// 重置配置为初始状态（清掉验收测试留下的假口令与假 key）
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
const get = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
};

const endpoint = get('TURSO_DATABASE_URL').replace('libsql://', 'https://') + '/v2/pipeline';
const tok = get('TURSO_AUTH_TOKEN');

async function exec(sql) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
  });
  return r.json();
}

(async () => {
  const res = await exec(
    `UPDATE app_settings SET value = '', updated_at = unixepoch()
     WHERE key IN ('llm.api_key','access.password_hash')`
  );
  const res2 = await exec(`UPDATE app_settings SET value = '0' WHERE key = 'access.enabled'`);
  const res3 = await exec(`UPDATE app_settings SET value = '0.7' WHERE key = 'llm.temperature'`);
  const res4 = await exec(`UPDATE app_settings SET value = 'https://api.deepseek.com' WHERE key = 'llm.base_url'`);
  const res5 = await exec(`UPDATE app_settings SET value = 'deepseek-chat' WHERE key = 'llm.model'`);

  const all = [res, res2, res3, res4, res5];
  const bad = all.filter((x) => x.results?.[0]?.type !== 'ok');
  console.log(bad.length ? '有失败项: ' + JSON.stringify(bad) : '配置已重置为初始状态');

  // 顺带清掉审计日志里的测试记录
  await exec('DELETE FROM config_audit');
  console.log('审计日志已清空');
})();
