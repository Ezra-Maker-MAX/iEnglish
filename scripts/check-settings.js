// 临时验证脚本：检查 app_settings 中密钥的存储形态
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
const get = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
};

const url = get('TURSO_DATABASE_URL');
const tok = get('TURSO_AUTH_TOKEN');
const endpoint = url.replace('libsql://', 'https://') + '/v2/pipeline';

async function exec(sql) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
  });
  return r.json();
}

(async () => {
  const j = await exec("SELECT key, value, is_secret FROM app_settings ORDER BY key");
  const rows = j.results[0].response.result.rows;
  console.log('--- app_settings 存储形态 ---');
  for (const row of rows) {
    const [k, v, s] = row.map((c) => c.value);
    const preview = v && v.length > 46 ? v.slice(0, 46) + '…' : v;
    console.log(`${k.padEnd(20)} secret=${s}  ${preview}`);
  }
})();
