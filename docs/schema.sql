-- ============================================================
-- 方案A 儿童英语学习设备 · Turso 数据库 Schema
-- 兼容 libSQL / SQLite
-- 使用：turso db shell <your-db> < schema.sql
-- ============================================================

-- ============ 1. 孩子档案 ============
CREATE TABLE IF NOT EXISTS children (
  id            TEXT PRIMARY KEY,
  nickname      TEXT NOT NULL,
  english_name  TEXT,
  grade_band    TEXT,
  cefr_level    TEXT DEFAULT 'A1',
  created_at    INTEGER DEFAULT (unixepoch())
);

-- ============ 2. 设备 ============
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  client_id     TEXT,
  child_id      TEXT REFERENCES children(id),
  name          TEXT,
  token_hash    TEXT NOT NULL,
  last_seen_at  INTEGER,
  firmware_ver  TEXT
);

-- ============ 3. 场景配置（热改，不用烧固件）============
CREATE TABLE IF NOT EXISTS scenarios (
  id            TEXT PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  difficulty    INTEGER,
  grade_band    TEXT,
  roles         TEXT,
  vocab_list    TEXT,
  system_prompt TEXT NOT NULL,
  opening_line  TEXT,
  stuck_hints   TEXT,
  upgrade_pairs TEXT,
  sort_order    INTEGER DEFAULT 0,
  active        INTEGER DEFAULT 1
);

-- ============ 4. 会话 ============
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  child_id      TEXT REFERENCES children(id),
  scenario_id   TEXT REFERENCES scenarios(id),
  started_at    INTEGER,
  ended_at      INTEGER,
  turn_count    INTEGER DEFAULT 0,
  duration_sec  INTEGER,
  completed     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_child ON sessions(child_id, started_at DESC);

-- ============ 5. 对话轮次 ============
CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id),
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  text          TEXT NOT NULL,
  asr_conf      REAL,
  created_at    INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);

-- ============ 6. 生词本 ============
CREATE TABLE IF NOT EXISTS vocab_progress (
  id            TEXT PRIMARY KEY,
  child_id      TEXT REFERENCES children(id),
  word          TEXT NOT NULL,
  first_seen_at INTEGER,
  times_seen    INTEGER DEFAULT 1,
  times_used    INTEGER DEFAULT 0,
  mastered      INTEGER DEFAULT 0,
  UNIQUE(child_id, word)
);
CREATE INDEX IF NOT EXISTS idx_vocab_child ON vocab_progress(child_id, mastered);

-- ============ 7. 发音评测（只存分数，不存音频）============
CREATE TABLE IF NOT EXISTS pron_scores (
  id            TEXT PRIMARY KEY,
  child_id      TEXT REFERENCES children(id),
  session_id    TEXT REFERENCES sessions(id),
  word          TEXT,
  expected_ipa  TEXT,
  heard_ipa     TEXT,
  score         REAL,
  created_at    INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pron_child ON pron_scores(child_id, score);

-- ============ 8. 每日统计（家长端看板）============
CREATE TABLE IF NOT EXISTS daily_stats (
  child_id       TEXT REFERENCES children(id),
  date           TEXT NOT NULL,
  minutes        REAL DEFAULT 0,
  turns          INTEGER DEFAULT 0,
  scenarios_done INTEGER DEFAULT 0,
  new_words      INTEGER DEFAULT 0,
  PRIMARY KEY (child_id, date)
);

-- ============================================================
-- 初始数据：默认孩子档案
-- ============================================================
INSERT OR IGNORE INTO children (id, nickname, english_name, grade_band, cefr_level)
VALUES ('child-001', '宝贝', 'Lily', 'primary_high', 'A1');
