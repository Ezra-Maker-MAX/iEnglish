import { query, queryOne } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHILD_ID = 'child-001';

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts) * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function Dashboard() {
  let stats = [], sessions = [], recentTurns = [], vocab = [], err = null;

  try {
    const child = await queryOne(
      `SELECT nickname, english_name, cefr_level FROM children WHERE id = ?`,
      [CHILD_ID]
    );

    stats = await query(
      `SELECT date, minutes, turns, scenarios_done, new_words
       FROM daily_stats WHERE child_id = ?
       ORDER BY date DESC LIMIT 14`,
      [CHILD_ID]
    );

    sessions = await query(
      `SELECT s.id, s.started_at, s.duration_sec, s.turn_count, s.completed, sc.title
       FROM sessions s
       LEFT JOIN scenarios sc ON sc.id = s.scenario_id
       WHERE s.child_id = ?
       ORDER BY s.started_at DESC LIMIT 10`,
      [CHILD_ID]
    );

    recentTurns = await query(
      `SELECT t.role, t.text, t.created_at
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       WHERE s.child_id = ?
       ORDER BY t.created_at DESC LIMIT 20`,
      [CHILD_ID]
    );

    vocab = await query(
      `SELECT word, times_seen, times_used, mastered
       FROM vocab_progress WHERE child_id = ?
       ORDER BY times_used DESC, times_seen DESC LIMIT 30`,
      [CHILD_ID]
    );

    // 汇总
    const totalMin = stats.reduce((a, b) => a + (Number(b.minutes) || 0), 0);
    const totalTurns = stats.reduce((a, b) => a + (Number(b.turns) || 0), 0);
    const totalScen = stats.reduce((a, b) => a + (Number(b.scenarios_done) || 0), 0);

    return (
      <div className="dash">
        <h1>学习看板</h1>
        <p className="sub">
          {child?.nickname || CHILD_ID}
          {child?.english_name ? ` · ${child.english_name}` : ''}
          {child?.cefr_level ? ` · ${child.cefr_level}` : ''}
        </p>

        <div className="kpis">
          <div className="kpi">
            <span className="knum">{totalMin.toFixed(1)}</span>
            <span className="klab">练习分钟</span>
          </div>
          <div className="kpi">
            <span className="knum">{totalTurns}</span>
            <span className="klab">对话轮次</span>
          </div>
          <div className="kpi">
            <span className="knum">{totalScen}</span>
            <span className="klab">完成场景</span>
          </div>
          <div className="kpi">
            <span className="knum">{vocab.length}</span>
            <span className="klab">累计词汇</span>
          </div>
        </div>

        <section>
          <h2>最近会话</h2>
          {sessions.length === 0 ? (
            <p className="empty">还没有练习记录。去 <a href="/practice">练习页</a> 开始第一次对话。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>场景</th><th>开始</th><th>时长</th><th>轮次</th><th>状态</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.title || '—'}</td>
                    <td>{fmtDate(s.started_at)}</td>
                    <td>{s.duration_sec ? `${s.duration_sec}s` : '—'}</td>
                    <td>{s.turn_count}</td>
                    <td>{s.completed ? '✅ 完成' : '进行中'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2>每日统计</h2>
          {stats.length === 0 ? (
            <p className="empty">暂无数据</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>日期</th><th>分钟</th><th>轮次</th><th>完成场景</th><th>新词</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.date}>
                    <td>{s.date}</td>
                    <td>{Number(s.minutes).toFixed(1)}</td>
                    <td>{s.turns}</td>
                    <td>{s.scenarios_done}</td>
                    <td>{s.new_words}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2>生词本</h2>
          {vocab.length === 0 ? (
            <p className="empty">孩子主动说出场景词汇后会自动记录在这里。</p>
          ) : (
            <div className="words">
              {vocab.map((v) => (
                <span key={v.word} className="word">
                  {v.word}
                  <em>{v.times_used}</em>
                </span>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2>最近对话</h2>
          {recentTurns.length === 0 ? (
            <p className="empty">暂无对话记录</p>
          ) : (
            <div className="log">
              {recentTurns.map((t, i) => (
                <div key={i} className={`line ${t.role}`}>
                  <span className="lwho">{t.role === 'child' ? '孩子' : 'AI'}</span>
                  <span className="ltxt">{t.text}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="foot">
          <a href="/practice">→ 去练习页</a>
        </p>
      </div>
    );
  } catch (e) {
    err = e.message;
  }

  return (
    <div className="dash">
      <h1>数据库连接失败</h1>
      <pre className="err">{err}</pre>
      <p className="sub">请检查 TURSO_DATABASE_URL 与 TURSO_AUTH_TOKEN。</p>
    </div>
  );
}
