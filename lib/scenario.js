import { query, queryOne, run } from './db';

/**
 * 加载场景配置
 * 这是「提示词存数据库」设计的具体实现 —— 改一行 UPDATE 即刻生效
 */
export async function getScenario(slug) {
  const row = await queryOne(
    `SELECT id, slug, title, difficulty, grade_band, roles, vocab_list,
            system_prompt, opening_line, stuck_hints, upgrade_pairs
     FROM scenarios
     WHERE slug = ? AND active = 1`,
    [slug]
  );
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    difficulty: row.difficulty,
    gradeBand: row.grade_band,
    roles: safeJson(row.roles, {}),
    vocabList: safeJson(row.vocab_list, []),
    systemPrompt: row.system_prompt,
    openingLine: row.opening_line,
    stuckHints: safeJson(row.stuck_hints, []),
    upgradePairs: safeJson(row.upgrade_pairs, []),
  };
}

/** 列出全部场景（给孩子选） */
export async function listScenarios() {
  return query(
    `SELECT slug, title, difficulty, grade_band, sort_order
     FROM scenarios
     WHERE active = 1
     ORDER BY sort_order`
  );
}

/** 获取孩子档案 */
export async function getChild(childId) {
  return queryOne(
    `SELECT id, nickname, english_name, grade_band, cefr_level
     FROM children WHERE id = ?`,
    [childId]
  );
}

/**
 * 构建教学提示词
 *
 * 关键：把场景规则 + 卡壳提示 + 升级对照一起注入。
 * 教学法源自 xiaozhi-english-speaking-coach：
 *   全程英语 / 不逐句纠错 / 卡壳给二选一 / 复盘给升级表达
 */
export function buildMessages(scenario, history, child) {
  const hints = scenario.stuckHints
    .map((h) => `  - 孩子卡壳「${h.point}」→ 提示方式：${h.hint}`)
    .join('\n');

  const upgrades = scenario.upgradePairs
    .map(([basic, better]) => `  - 初级 "${basic}" → 升级 "${better}"`)
    .join('\n');

  const system = `${scenario.systemPrompt}

--- 本次场景 ---
场景：${scenario.title}
孩子的角色：${scenario.roles.student || 'Learner'}
你的角色：${scenario.roles.ai || 'Conversation partner'}

目标词汇（引导孩子说出，但不要把词表直接念给孩子）：
${scenario.vocabList.join(', ')}

孩子卡壳时的提示方式（给选择，不给整句）：
${hints}

对话结束复盘时的升级对照：
${upgrades}

--- 孩子信息 ---
昵称：${child?.nickname || '孩子'}
英文名：${child?.english_name || '未设定'}
英语水平：${child?.cefr_level || 'A1'}

根据孩子的水平调整句子长度和语速。水平低时用更短的句子、更基础的词汇。
再次强调：全程英语，不逐句纠错，卡壳时给二选一。`;

  const msgs = [{ role: 'system', content: system }];
  for (const t of history) {
    msgs.push({
      role: t.role === 'child' ? 'user' : 'assistant',
      content: t.text,
    });
  }
  return msgs;
}

/** 生成开场白 —— 若场景未配置则让 LLM 生成 */
export async function getOpeningLine(scenario) {
  return scenario.openingLine || "Hello! Are you ready to start? Let's go!";
}

// ============================================================
// 会话与记录
// ============================================================

export async function createSession(childId, scenarioId) {
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO sessions (id, child_id, scenario_id, started_at, turn_count)
     VALUES (?, ?, ?, unixepoch(), 0)`,
    [id, childId, scenarioId]
  );
  return id;
}

export async function saveTurn(sessionId, seq, role, text, asrConf = null) {
  await run(
    `INSERT INTO turns (id, session_id, seq, role, text, asr_conf)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), sessionId, seq, role, text, asrConf]
  );
  await run(`UPDATE sessions SET turn_count = turn_count + 1 WHERE id = ?`, [sessionId]);
}

export async function endSession(sessionId, completed, durationSec) {
  await run(
    `UPDATE sessions SET ended_at = unixepoch(), completed = ?, duration_sec = ? WHERE id = ?`,
    [completed ? 1 : 0, durationSec, sessionId]
  );
}

/** 生词累积：孩子主动说出场景词汇时计入 */
export async function trackVocab(childId, vocabList, childText) {
  const lower = (childText || '').toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  for (const w of vocabList) {
    const word = String(w).toLowerCase();
    if (!word || !lower.includes(word)) continue;
    await run(
      `INSERT INTO vocab_progress (id, child_id, word, first_seen_at, times_seen, times_used)
       VALUES (?, ?, ?, ?, 1, 1)
       ON CONFLICT(child_id, word) DO UPDATE SET
         times_seen = times_seen + 1,
         times_used = times_used + 1`,
      [crypto.randomUUID(), childId, word, now]
    );
  }
}

/** 每日统计 */
export async function bumpDailyStats(childId, minutes, turns, newWords = 0, done = 0) {
  const date = new Date().toISOString().slice(0, 10);
  await run(
    `INSERT INTO daily_stats (child_id, date, minutes, turns, scenarios_done, new_words)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(child_id, date) DO UPDATE SET
       minutes        = minutes + excluded.minutes,
       turns          = turns + excluded.turns,
       scenarios_done = scenarios_done + excluded.scenarios_done,
       new_words      = new_words + excluded.new_words`,
    [childId, date, minutes, turns, done, newWords]
  );
}

function safeJson(v, fallback) {
  if (v == null) return fallback;
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return fallback;
  }
}
