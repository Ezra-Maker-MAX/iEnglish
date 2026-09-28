import { NextResponse } from 'next/server';
import {
  checkPassword,
  signToken,
  buildAuthCookie,
  buildLogoutCookie,
  isAuthEnabled,
  getSession,
} from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 当前登录态 */
export async function GET(req) {
  const enabled = await isAuthEnabled();
  const sess = getSession(req);
  return NextResponse.json({
    authEnabled: enabled,
    loggedIn: Boolean(sess),
    since: sess?.iat ?? null,
  });
}

/** 登录 */
export async function POST(req) {
  try {
    const { password } = await req.json().catch(() => ({}));

    if (!(await isAuthEnabled())) {
      return NextResponse.json({
        ok: true,
        note: '当前未启用访问口令，已直接放行。',
      });
    }

    if (!password) {
      return NextResponse.json({ error: '请输入访问口令' }, { status: 400 });
    }

    if (!(await checkPassword(password))) {
      return NextResponse.json({ error: '口令不正确' }, { status: 401 });
    }

    const token = signToken({ role: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = NextResponse.json({ ok: true });
    res.headers.set('Set-Cookie', buildAuthCookie(token));
    return res;
  } catch (err) {
    console.error('[api/auth POST]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** 登出 */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.headers.set('Set-Cookie', buildLogoutCookie());
  return res;
}
