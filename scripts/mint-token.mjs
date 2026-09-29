// 本地签发 ie_auth 登录 token
//
// 用途：在 /admin 启用了访问口令之后，本地验收脚本（Playwright / 直连接口）
//       需要带一个合法的登录 Cookie，否则 /api/chat 全部返回 401。
//
// 原理：server 与本机共享同一个 SETTINGS_SECRET，所以可以本地算出合法签名。
//       HMAC key 由 scryptSync(SETTINGS_SECRET, 'ienglish-auth-v1', 32) 派生，
//       盐串必须与 lib/auth.js 的 signingKey() 一致。
//
// 用法：
//   node scripts/mint-token.mjs                      # 打印 token（默认 14 天）
//   TOK=$(node scripts/mint-token.mjs)
//   BASE=http://127.0.0.1:3011 IE_AUTH="$TOK" node scripts/verify-game-ui.cjs
//
//   node scripts/mint-token.mjs --days 1             # 自定义有效期
//   node scripts/mint-token.mjs --cookie            # 直接打印 Cookie 头
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('找不到 .env.local（请在 ienglish 目录下运行）');
  process.exit(1);
}

const secret = (fs.readFileSync(envPath, 'utf8').match(/^SETTINGS_SECRET=(.*)$/m) || [])[1]?.trim();
if (!secret) {
  console.error('.env.local 里没有 SETTINGS_SECRET —— 无法签发 token');
  process.exit(1);
}

const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) || 14 : 14;
const asCookie = args.includes('--cookie');

const key = crypto.scryptSync(secret, 'ienglish-auth-v1', 32);
const b64url = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const now = Math.floor(Date.now() / 1000);
const body = { role: 'admin', iat: now, exp: now + days * 86400 };
const data = b64url(JSON.stringify(body));
const sig = b64url(crypto.createHmac('sha256', key).update(data).digest());
const token = `${data}.${sig}`;

console.log(asCookie ? `ie_auth=${token}` : token);
