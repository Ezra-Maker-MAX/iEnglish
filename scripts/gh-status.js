/**
 * 查看远程仓库状态（不依赖 git 传输层）
 * 用法：GH_TOKEN=xxx NO_PROXY='*' node scripts/gh-status.js
 */
const TOKEN = process.env.GH_TOKEN;
const OWNER = 'Ezra-Maker-MAX';
const REPO = 'iEnglish';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

async function gh(p) {
  const res = await fetch(API + p, {
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ienglish-status',
    },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(res.status + ' ' + p + ' -> ' + txt.slice(0, 200));
  return JSON.parse(txt);
}

(async () => {
  const ref = await gh('/git/ref/heads/main');
  const sha = ref.object.sha;
  console.log('远程 main HEAD:', sha.slice(0, 7));
  console.log('完整 sha:', sha);

  const commit = await gh('/git/commits/' + sha);
  console.log('\n提交信息:');
  console.log(commit.message.split('\n').slice(0, 3).join('\n'));

  const tree = await gh('/git/trees/' + commit.tree.sha + '?recursive=1');
  const wanted = tree.tree.filter(
    (t) => t.type === 'blob' && /admin|settings|proxy|auth\.js|配置/.test(t.path)
  );
  console.log('\n关键文件是否在远程:');
  for (const t of wanted) console.log('  ✓', t.path, '(' + t.size + ' bytes)');

  const hasDoc = tree.tree.some((t) => t.path.includes('配置中心'));
  console.log('\n配置中心.md 是否已推送:', hasDoc ? '✓ 是' : '✗ 否（缺失）');
})();
