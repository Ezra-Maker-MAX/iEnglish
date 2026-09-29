/**
 * 项目状态体检 —— 一次看清数据库、配置、场景的就绪情况
 */
const fs = require('fs');
const path = require('path');

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const get = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
};
const ep = get('TURSO_DATABASE_URL').replace('libsql://', 'https://') + '/v2/pipeline';
const tok = get('TURSO_AUTH_TOKEN');

async function q(sql) {
  const r = await fetch(ep, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
  });
  const j = await r.json();
  const res = j.results?.[0];
  if (res?.type !== 'ok') throw new Error('SQL 失败: ' + JSON.stringify(res?.error || res));
  return res.response.result;
}

(async () => {
  console.log('======== 配 置 ========');
  const st = await q(
    'SELECT key, value, is_secret FROM app_settings ORDER BY key'
  );
  for (const row of st.rows) {
    const [k, v, sec] = row.map((c) => c.value);
    let show = v;
    if (Number(sec) === 1 && v) show = '(已加密)';
    if (show === '' || show == null) show = '(空)';
    console.log('  ' + k.padEnd(22) + show);
  }

  console.log('\n======== 场 景 ========');
  const sc = await q(
    'SELECT slug, title, difficulty, LENGTH(system_prompt) len FROM scenarios WHERE active=1 ORDER BY sort_order'
  );
  for (const row of sc.rows) {
    const [slug, title, diff, len] = row.map((c) => c.value);
    console.log(`  ${'⭐'.repeat(Number(diff))} ${title.padEnd(20)} 提示词 ${len} 字符`);
  }

  console.log('\n======== 数 据 ========');
  const counts = await q(
    `SELECT
      (SELECT COUNT(*) FROM sessions) sessions,
      (SELECT COUNT(*) FROM turns) turns,
      (SELECT COUNT(*) FROM vocab_progress) vocab,
      (SELECT COUNT(*) FROM pron_scores) pron,
      (SELECT COUNT(*) FROM daily_stats) stats`
  );
  const [ss, tt, vv, pp, dd] = counts.rows[0].map((c) => c.value);
  console.log(`  会话 ${ss} · 对话轮次 ${tt} · 生词 ${vv} · 发音评分 ${pp} · 每日统计 ${dd}`);

  if (Number(ss) > 0) {
    const last = await q(
      'SELECT s.started_at, s.turn_count, sc.title FROM sessions s LEFT JOIN scenarios sc ON sc.id=s.scenario_id ORDER BY s.started_at DESC LIMIT 3'
    );
    console.log('\n  最近会话：');
    for (const row of last.rows) {
      const [ts, tc, title] = row.map((c) => c.value);
      const d = new Date(Number(ts) * 1000).toLocaleString('zh-CN');
      console.log(`    ${d}  ${title || '—'}  ${tc} 轮`);
    }
  }
})();
