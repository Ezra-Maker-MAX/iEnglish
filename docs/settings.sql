-- ============================================================
-- 应用配置表（Web 可编辑，值存 Turso）
-- 追加到现有库，不影响原有 8 张表
-- ============================================================

-- ============ 9. 应用配置（键值对）============
-- 用途：把 LLM 的 base_url / model / api_key 等从环境变量搬到这里，
--       通过网页改一行即生效，不需要重新部署 Vercel。
--
-- 注意：Turso 自己的连接串不能存在这里（自举依赖），仍走环境变量。
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  is_secret   INTEGER DEFAULT 0,     -- 1 表示密文，读取时只回传掩码
  updated_at  INTEGER DEFAULT (unixepoch())
);

-- 初始化默认值（INSERT OR IGNORE：已存在则不覆盖）
INSERT OR IGNORE INTO app_settings (key, value, is_secret) VALUES
  ('llm.base_url',      'https://api.deepseek.com', 0),
  ('llm.model',         'deepseek-chat',            0),
  ('llm.temperature',   '0.7',                      0),
  ('llm.max_tokens',    '400',                      0),
  ('llm.api_key',       '',                         1),
  ('llm.provider_name','DeepSeek',                  0),
  ('access.password_hash', '',                      1),
  ('access.enabled',    '0',                        0);

-- ============================================================
-- 测试连通性用的轻量请求日志（可选，便于看谁在调接口）
-- ============================================================
CREATE TABLE IF NOT EXISTS config_audit (
  id          TEXT PRIMARY KEY,
  key         TEXT,
  action      TEXT,               -- set / clear / test
  actor       TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON config_audit(created_at DESC);
