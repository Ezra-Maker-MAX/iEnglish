const fs = require('fs');
const TOKEN = process.env.GH_TOKEN;
const OWNER = 'Ezra-Maker-MAX';
const REPO = 'iEnglish';
const BRANCH = 'main';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

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
  const ref = await gh('/git/ref/heads/' + BRANCH);
  const baseSha = ref.object.sha;
  const baseCommit = await gh('/git/commits/' + baseSha);
  console.log('base commit:', baseSha.slice(0, 7));

  const files = [
    'docs/schema.sql',
    'docs/scenarios.sql',
    'docs/xiaozhi-websocket-route.js',
    'docs/架构设计.md',
  ];

  const tree = [];
  for (const p of files) {
    const content = fs.readFileSync(p, 'utf8');
    const blob = await gh('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  blob ok:', p, '(' + content.length + ' chars)');
  }

  const newTree = await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  console.log('tree:', newTree.sha.slice(0, 7));

  const msg =
    'docs: 归档架构设计、数据库脚本与小智协议 WebSocket 骨架\n\n' +
    '- docs/架构设计.md：完整技术方案（含 Vercel 约束、协议细节、两期计划）\n' +
    '- docs/schema.sql、docs/scenarios.sql：数据库脚本备份\n' +
    '- docs/xiaozhi-websocket-route.js：第二期 ESP32 接入用骨架';

  const newCommit = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: msg, tree: newTree.sha, parents: [baseSha] }),
  });
  console.log('commit:', newCommit.sha.slice(0, 7));

  await gh('/git/refs/heads/' + BRANCH, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  console.log('OK 推送完成:', newCommit.sha.slice(0, 7));
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
