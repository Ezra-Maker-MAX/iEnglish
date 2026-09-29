import { query, queryOne, run } from './db';

/**
 * 加载场景配置
 * 这是「提示词存数据库」设计的具体实现 —— 改一行 UPDATE 即刻生效
 */
export async function getScenario(slug) {
  const row = await queryOne(
    `SELECT id, slug, title, difficulty, grade_band, roles, vocab_list,
            system_prompt, opening_line, stuck_hints, upgrade_pairs,
            character_name, character_persona, character_avatar, hook_line,
            events, missions, praise_lines, reward_badge, reward_title
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

    // ---- 游戏化字段（未配置时为 null / []，界面自动退化为普通形态）----
    characterName: row.character_name || null,
    characterPersona: row.character_persona || null,
    /** 角色立绘/头像路径（public 下的静态资源）。未配置时界面回退为首字母色块。 */
    characterAvatar: row.character_avatar || null,
    hookLine: row.hook_line || null,
    events: safeJson(row.events, []),
    missions: safeJson(row.missions, []),
    praiseLines: safeJson(row.praise_lines, []),
    rewardBadge: row.reward_badge || null,
    rewardTitle: row.reward_title || null,
  };
}

/**
 * 判断场景是否已完成游戏化改造
 * 界面据此决定渲染「游戏关卡模式」还是「纯聊天模式」
 */
export function isGamified(scenario) {
  return Boolean(scenario && scenario.characterName && scenario.missions?.length);
}

/**
 * 给孩子看的场景摘要 —— 只暴露游戏化字段，不泄漏提示词
 * 目的：孩子端一次拿到全部渲染所需数据，不必中途再请求
 */
export function toPublicScenario(s) {
  if (!s) return null;
  return {
    slug: s.slug,
    title: s.title,
    difficulty: s.difficulty,
    gamified: isGamified(s),
    characterName: s.characterName,
    characterPersona: s.characterPersona,
    characterAvatar: s.characterAvatar,
    hookLine: s.hookLine,
    openingLine: s.openingLine,
    missions: s.missions,
    events: s.events,
    praiseLines: s.praiseLines,
    rewardBadge: s.rewardBadge,
    rewardTitle: s.rewardTitle,
  };
}

/** 列出全部场景（给孩子选） */
export async function listScenarios() {
  const rows = await query(
    `SELECT slug, title, difficulty, grade_band, sort_order,
            character_name, reward_badge
     FROM scenarios
     WHERE active = 1
     ORDER BY sort_order`
  );
  return rows.map((r) => ({
    ...r,
    gamified: Boolean(r.character_name),
  }));
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

  // ---- 游戏化段落：只有配置了才注入，否则保持原样 ----
  const characterBlock = scenario.characterName
    ? `
--- 你是谁 ---
你的名字：${scenario.characterName}
人物设定：${scenario.characterPersona || '（未配置）'}
${scenario.hookLine ? `开场氛围（第一句话必须体现这种感觉）：\n${scenario.hookLine}` : ''}`
    : '';

  const missionsBlock = scenario.missions?.length
    ? `
--- 闯关进度（孩子的 4 个关卡）---
${scenario.missions
  .map((m, i) => `  ${i + 1}. ${m.icon || ''} ${m.label} / ${m.label_en || ''}`)
  .join('\n')}

重要：每完成一个关卡，立刻用一句超夸张的英文欢呼（不要等孩子问）。
孩子说出关键词（boarding pass / heavy / security / board 等）就算过关。`
    : '';

  const eventsBlock = scenario.events?.length
    ? `
--- 剧情突发事件（必须按轮次抛出，这是好玩的关键）---
${scenario.events
  .map(
    (e) =>
      `  第 ${e.at_turn} 轮：${e.event}\n    怎么演：${e.ai_hint}`
  )
  .join('\n')}

到达指定轮次时，直接开演，不要预告、不要问"你想听个坏消息吗"。
演完让孩子做决定。孩子说什么都算对，你负责配合他把戏演下去。`
    : '';

  const praiseBlock = scenario.praiseLines?.length
    ? `
--- 表扬词池（可自由变化，保持同等夸张程度）---
${scenario.praiseLines.map((p) => `  ${p}`).join('\n')}`
    : '';

  const rewardBlock = scenario.rewardTitle
    ? `
--- 通关奖励（最后一轮必须给出）---
颁发徽章 ${scenario.rewardBadge || '🏅'}，称号「${scenario.rewardTitle}」。
要先大声宣布这个称号，再用 2-3 句英文总结孩子今天做得好的地方。
最后教 TA 一句升级表达（比孩子原话更地道的一个句子）。`
    : '';

  const system = `${scenario.systemPrompt}
${characterBlock}
--- 本次场景 ---
场景：${scenario.title}
孩子的角色：${scenario.roles.student || 'Learner'}
你的角色：${scenario.roles.ai || 'Conversation partner'}

目标词汇（引导孩子说出，但不要把词表直接念给孩子）：
${scenario.vocabList.join(', ')}
${missionsBlock}
${eventsBlock}
${praiseBlock}
${rewardBlock}
--- 孩子卡壳时的提示方式（给选择，不给整句）---
${hints}

--- 对话结束复盘时的升级对照 ---
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

/** 记录本次会话到过的关卡（用于「本次旅程」小结展示） */
export async function trackMission(sessionId, missionId, label) {
  await run(
    `INSERT INTO session_missions (id, session_id, mission_id, label, at_turn, created_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())`,
    [crypto.randomUUID(), sessionId, missionId, label || '', 0]
  ).catch(() => {
    // 表不存在时不阻塞主流程 —— 这只是锦上添花的记录
  });
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
