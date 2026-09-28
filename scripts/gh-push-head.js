/**
 * GitHub API 推送通道（git push 网络失败时的备用方案）
 *
 * 用途：本机 git push 经常因 TLS / 代理问题失败，但 GitHub REST API 始终可达。
 * 本脚本把当前 HEAD 提交的文件通过 API 推送，建 blob → tree → commit → 更新 ref。
 *
 * ============ 用法（两步，不需要 Node 派生任何进程）============
 *
 *   # 1. 在 shell 里预生成清单（脚本本身不调用 git，规避 EBUSY）
 *   git rev-parse HEAD > /tmp/push-sha.txt
 *   git show --pretty=format:%B --name-status HEAD > /tmp/push-manifest.txt
 *
 *   # 2. 推送
 *   export GH_TOKEN="<你的 GitHub PAT>"
 *   NO_PROXY='*' http_proxy= https_proxy= node scripts/gh-push-head.js
 *
 * ============ 为什么不让 Node 调 git ============
 *
 * 本机 Git Bash 下 spawnSync / execFileSync 派生 git 或 cmd 一律报 EBUSY
 * （stdout 管道句柄争用）。所以清单在 shell 侧生成，Node 只负责读文件 + 发 HTTP。
 *
 * ============ 注意 ============
 *
 * - token 从环境变量读取，脚本内不含任何硬编码密钥
 * - 只处理新增/修改，不处理文件移除（本机 safe-delete hook 会拦）
 * - 推送后本地 git 与远程分叉（sha 不同、内容一致），需手动对齐：
 *     git fetch origin main && git reset --hard origin/main
 *   前提是本地内容已与远程一致，执行前先用 git status 确认无未提交改动。
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'Ezra-Maker-MAX';
const REPO = 'iEnglish';
const BRANCH = 'main';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
const ROOT = path.join(__dirname, '..');

const SHA_FILE = process.env.PUSH_SHA_FILE || '/tmp/push-sha.txt';
const MANIFEST_FILE = process.env.PUSH_MANIFEST_FILE || '/tmp/push-manifest.txt';

if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

/**
 * 还原 git 输出的路径。
 *
 * 当路径含非 ASCII 字符时，git 会以 "..." 包裹并做八进制转义，形如：
 *   "docs/\351\205\215\347\275\256\344\270\255\345\277\203.md"
 * 对应「docs/配置中心.md」。这里把八进制序列还原成 UTF-8 字节再解码。
 */
function decodeGitPath(p) {
  let s = p.trim();
  const quoted = /^".*"$/.test(s);
  if (quoted) s = s.slice(1, -1);

  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && /[0-7]/.test(s[i + 1] || '')) {
      const oct = s.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

async function gh(p, opts) {
  opts = opts || {};
  const res = await fetch(API + p, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: Object.assign(
      {
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ienglish-push',
        'Content-Type': 'application/json',
      },
      opts.headers || {}
    ),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(res.status + ' ' + p + ' -> ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

(async () => {
  // ---------- 1. 读取预生成的清单 ----------
  if (!fs.existsSync(SHA_FILE) || !fs.existsSync(MANIFEST_FILE)) {
    console.error(
      '缺少清单文件。请先在 shell 里执行：\n' +
        '  git rev-parse HEAD > ' + SHA_FILE + '\n' +
        '  git show --pretty=format:%B --name-status HEAD > ' + MANIFEST_FILE
    );
    process.exit(1);
  }

  const headSha = fs.readFileSync(SHA_FILE, 'utf8').trim();
  const manifest = fs.readFileSync(MANIFEST_FILE, 'utf8');

  // 清单格式：提交信息 + 空行 + name-status 行
  const lines = manifest.split('\n');
  const statusStart = lines.findIndex((l) => /^[AMD]\t/.test(l));
  if (statusStart < 0) {
    console.error('清单里找不到文件状态行，格式应为 <A|M|D>\\t<path>');
    process.exit(1);
  }
  const msg = lines.slice(0, statusStart).join('\n').trim();

  const upserts = [];
  const removedPaths = [];
  for (const line of lines.slice(statusStart)) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0].trim();
    let p = parts[1].trim();
    // git 对含非 ASCII 的路径会输出 "..." 包裹的八进制转义，需还原
    p = decodeGitPath(p);
    if (status === 'D') removedPaths.push(p);
    else upserts.push(p);
  }

  console.log('HEAD:', headSha.slice(0, 7));
  console.log('新增/修改:', upserts.length, '| 移除:', removedPaths.length);

  if (removedPaths.length > 0) {
    console.error(
      '\n本次提交含文件移除，本脚本不处理该情况。\n受影响路径：\n  ' +
        removedPaths.join('\n  ') +
        '\n请改用常规 git push。'
    );
    process.exit(1);
  }

  // ---------- 2. 取远程 base ----------
  let baseSha = null;
  let baseTree;
  try {
    const ref = await gh('/git/ref/heads/' + BRANCH);
    baseSha = ref.object.sha;
    const baseCommit = await gh('/git/commits/' + baseSha);
    baseTree = baseCommit.tree.sha;
    console.log('远程 base:', baseSha.slice(0, 7));
  } catch (e) {
    console.log('远程分支不存在，作为首次提交处理');
  }

  // ---------- 3. 上传 blob ----------
  const tree = [];
  for (const p of upserts) {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) {
      console.log('  跳过（本地不存在）:', p);
      continue;
    }
    const content = fs.readFileSync(full, 'utf8');
    const blob = await gh('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  blob ok:', p, '(' + content.length + ' chars)');
  }

  if (tree.length === 0) {
    console.log('没有需要推送的变更');
    return;
  }

  // ---------- 4. 建 tree + commit ----------
  const newTree = await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  console.log('tree:', newTree.sha.slice(0, 7));

  const newCommit = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: msg,
      tree: newTree.sha,
      parents: baseSha ? [baseSha] : [],
    }),
  });
  console.log('commit:', newCommit.sha.slice(0, 7));

  // ---------- 5. 更新 ref ----------
  if (baseSha) {
    await gh('/git/refs/heads/' + BRANCH, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    });
  } else {
    await gh('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: 'refs/heads/' + BRANCH, sha: newCommit.sha }),
    });
  }

  console.log('\nOK 推送完成:', newCommit.sha.slice(0, 7));
  console.log('本地与远程 sha 不同（内容一致），对齐：');
  console.log('  git fetch origin main && git reset --hard origin/main');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
