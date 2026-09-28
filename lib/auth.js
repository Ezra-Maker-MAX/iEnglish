import crypto from 'node:crypto';
import { getSettings, verifyPassword } from './settings';

/**
 * ============================================================
 * 轻量访问控制
 * ============================================================
 *
 * 为什么需要：
 *   /api/chat 背后是你的付费 API Key。一旦部署到公网，
 *   任何人拿到地址就能白嫖你的额度。所以必须加一道门。
 *
 * 设计：
 *   - 口令哈希存 Turso（app_settings.access.password_hash）
 *   - 登录成功签发 HMAC 签名的 Cookie（无状态，serverless 友好）
 *   - access.enabled = '0' 时视为「未启用鉴权」，全部放行（本地开发方便）
 *
 * 签名密钥派生自 SETTINGS_SECRET；未配置时退化为固定串
 * （此时会打印告警，提醒生产环境必须配置）。
 */

const COOKIE_NAME = 'ie_auth';
const MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 天

function signingKey() {
  const secret = process.env.SETTINGS_SECRET;
  if (!secret) {
    console.warn(
      '[auth] 警告：未配置 SETTINGS_SECRET，登录 Cookie 使用弱固定密钥。生产环境请务必配置。'
    );
    return 'ienglish-insecure-dev-key';
  }
  return crypto.scryptSync(secret, 'ienglish-auth-v1', 32);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** 签发令牌：payload.exp|sig */
export function signToken(payload = {}) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', signingKey()).update(data).digest());
  return `${data}.${sig}`;
}

/** 校验令牌 */
export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', signingKey()).update(data).digest());
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;

  try {
    const body = JSON.parse(fromB64url(data).toString('utf8'));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

/** 从请求中读取并校验登录态 */
export function getSession(req) {
  const cookie = req.cookies?.get?.(COOKIE_NAME)?.value ?? null;
  return verifyToken(cookie);
}

/** 是否启用了登录门槛 */
export async function isAuthEnabled() {
  try {
    const s = await getSettings();
    return s['access.enabled'] === '1' && Boolean(s['access.password_hash']);
  } catch {
    // 数据库不可用时，出于安全默认「要求鉴权」是更稳的选择，
    // 但那样会让本地完全无法开发。这里选择放行并打印告警。
    console.warn('[auth] 读取鉴权配置失败，本次请求按未启用鉴权处理。');
    return false;
  }
}

/** 校验口令 */
export async function checkPassword(password) {
  const s = await getSettings();
  return verifyPassword(password, s['access.password_hash'] || '');
}

export const AUTH_COOKIE = {
  name: COOKIE_NAME,
  maxAge: MAX_AGE_SEC,
};

/** 生成 Set-Cookie 头 */
export function buildAuthCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  // 生产环境（HTTPS）加 Secure
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function buildLogoutCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
