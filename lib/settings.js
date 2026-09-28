import crypto from 'node:crypto';
import { query, queryOne, run } from './db';

/**
 * ============================================================
 * 应用配置层（值存 Turso，Web 可改）
 * ============================================================
 *
 * 设计要点
 * ---------
 * 1. 分层：
 *    - Turso 自身连接串 → 必须留在环境变量（自举依赖）
 *    - LLM 配置 / 访问口令 → 存 app_settings 表，改完即刻生效
 *
 * 2. 密钥加密：
 *    用 SETTINGS_SECRET 环境变量派生 AES-256-GCM 密钥。
 *    SETTINGS_SECRET 缺失时退化为不加密（开发用），并在响应里给出告警。
 *    这样即使 Turso 库被拖走，api_key 也是密文。
 *
 * 3. 掩码：
 *    任何一个 is_secret=1 的值，读接口只回传掩码（sk-1a2b…ef90），
 *    前端「保持原值」时提交哨兵值 MASK_SENTINEL，后端识别后跳过更新。
 *
 * 4. 缓存：
 *    serverless 冷启动频繁，用进程内 30 秒 TTL 缓存，避免每次对话都查库。
 *    写操作主动清缓存，保证改完立刻生效。
 */

/** 前端「保持原值」哨兵：提交这个值代表不修改该字段 */
export const MASK_SENTINEL = '__KEEP__';

/** 进程内缓存 */
const cache = { at: 0, data: null };
const TTL_MS = 30_000;

// ------------------------------------------------------------
// 加密
// ------------------------------------------------------------

function deriveKey() {
  const secret = process.env.SETTINGS_SECRET;
  if (!secret) return null;
  // 固定 salt + scrypt 派生：同一 secret 永远得到同一密钥，便于跨实例解密
  return crypto.scryptSync(secret, 'ienglish-settings-v1', 32);
}

/** 加密：返回 `enc:v1:<iv>:<tag>:<cipher>`；无 secret 时原样返回 */
export function encryptValue(plain) {
  const key = deriveKey();
  if (!key) return `raw:${plain}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** 解密：兼容 raw: 前缀（未加密时写入的值） */
export function decryptValue(stored) {
  if (stored == null) return '';
  const s = String(stored);
  if (s.startsWith('raw:')) return s.slice(4);
  if (!s.startsWith('enc:v1:')) return s;

  const key = deriveKey();
  if (!key) {
    throw new Error(
      'SETTINGS_SECRET 未配置，无法解密已加密的配置项。请在环境变量中补上同一个 SETTINGS_SECRET。'
    );
  }
  const [, , ivB64, tagB64, dataB64] = s.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ------------------------------------------------------------
// 掩码
// ------------------------------------------------------------

/** 掩码显示：保留头 6 位与尾 4 位 */
export function maskValue(plain) {
  const s = String(plain || '');
  if (!s) return '';
  if (s.length <= 12) return s.slice(0, 2) + '****';
  return `${s.slice(0, 6)}****${s.slice(-4)}`;
}

// ------------------------------------------------------------
// 读写
// ------------------------------------------------------------

/** 读取全部配置（原始态，含密文） */
async function loadRaw() {
  const rows = await query(`SELECT key, value, is_secret, updated_at FROM app_settings`);
  const map = {};
  for (const r of rows) map[r.key] = r;
  return map;
}

/** 获取配置对象（带 30 秒缓存），返回解密后的明文值 */
export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const raw = await loadRaw();
  const out = {};
  for (const [k, r] of Object.entries(raw)) {
    let v = r.value ?? '';
    if (Number(r.is_secret) === 1 && v) {
      try {
        v = decryptValue(v);
      } catch {
        // 解密失败（如 SETTINGS_SECRET 被换过）→ 置空，前端会提示重新填写
        v = '';
      }
    }
    out[k] = v;
  }

  cache.at = Date.now();
  cache.data = out;
  return out;
}

/** 清缓存（写操作后调用） */
export function invalidateSettings() {
  cache.at = 0;
  cache.data = null;
}

/**
 * 批量写入配置
 * @param {Record<string,string>} entries  key → value
 * @param {string[]} secretKeys 这些 key 走加密存储
 * @param {string} actor 操作者标识（审计用）
 */
export async function setSettings(entries, secretKeys = [], actor = 'web') {
  const now = Math.floor(Date.now() / 1000);
  const written = [];

  for (const [key, rawVal] of Object.entries(entries)) {
    if (rawVal === undefined || rawVal === null) continue;
    // 哨兵：保持原值，跳过
    if (rawVal === MASK_SENTINEL) continue;

    const isSecret = secretKeys.includes(key) ? 1 : 0;
    let stored = String(rawVal);

    // 密钥类字段：非空才加密覆盖；空字符串表示「清除」
    if (isSecret && stored !== '') {
      stored = encryptValue(stored);
    }

    await run(
      `INSERT INTO app_settings (key, value, is_secret, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         is_secret = excluded.is_secret,
         updated_at = excluded.updated_at`,
      [key, stored, isSecret, now]
    );

    await run(
      `INSERT INTO config_audit (id, key, action, actor, created_at) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), key, stored === '' ? 'clear' : 'set', actor, now]
    );

    written.push(key);
  }

  invalidateSettings();
  return written;
}

/** 记录一次审计（测试连通性等动作） */
export async function audit(key, action, actor = 'web') {
  await run(
    `INSERT INTO config_audit (id, key, action, actor, created_at) VALUES (?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), key, action, actor, Math.floor(Date.now() / 1000)]
  );
}

// ------------------------------------------------------------
// 访问口令
// ------------------------------------------------------------

/** 口令哈希：scrypt(salt + password) */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${h}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expect] = stored.split(':');
  const actual = crypto.scryptSync(String(password), salt, 32).toString('hex');
  // 定长比较，防时序侧信道
  if (actual.length !== expect.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expect));
}

// ------------------------------------------------------------
// 对外：脱敏视图（给配置页读）
// ------------------------------------------------------------

/** 返回可安全回传前端的配置（密文字段只给掩码 + 是否已配置） */
export async function getSettingsForUI() {
  const raw = await loadRaw();
  const items = [];

  const LABELS = {
    'llm.base_url': { label: 'API 地址', group: 'llm', placeholder: 'https://api.deepseek.com' },
    'llm.model': { label: '模型名', group: 'llm', placeholder: 'deepseek-chat' },
    'llm.api_key': { label: 'API Key', group: 'llm', placeholder: 'sk-...' },
    'llm.temperature': { label: '温度', group: 'llm', placeholder: '0.7' },
    'llm.max_tokens': { label: '单次最大输出 tokens', group: 'llm', placeholder: '400' },
    'llm.provider_name': { label: '服务商显示名', group: 'llm', placeholder: 'DeepSeek' },
  };

  for (const [key, meta] of Object.entries(LABELS)) {
    const r = raw[key];
    const isSecret = Number(r?.is_secret) === 1;
    let display = r?.value ?? '';

    if (isSecret && display) {
      try {
        display = maskValue(decryptValue(display));
      } catch {
        display = '（无法解密）';
      }
    }

    items.push({
      key,
      label: meta.label,
      group: meta.group,
      placeholder: meta.placeholder,
      secret: isSecret,
      value: display,
      configured: Boolean(r?.value),
      updatedAt: r?.updated_at ?? null,
    });
  }

  const accessHash = raw['access.password_hash']?.value;
  return {
    items,
    access: {
      enabled: raw['access.enabled']?.value === '1',
      passwordSet: Boolean(accessHash),
    },
    encryption: {
      // 供配置页显示告警：未配 SETTINGS_SECRET 时密钥是明文存的
      enabled: Boolean(process.env.SETTINGS_SECRET),
    },
    envFallback: {
      // 环境变量兜底状态（LLM_API_KEY 等），用于提示「值来自环境变量」
      llmApiKeyFromEnv: Boolean(process.env.LLM_API_KEY),
      tursoUrlFromEnv: Boolean(process.env.TURSO_DATABASE_URL),
    },
  };
}
