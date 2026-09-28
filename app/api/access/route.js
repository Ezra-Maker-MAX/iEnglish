import { NextResponse } from 'next/server';
import {
  setSettings,
  hashPassword,
  getSettingsForUI,
} from '@/lib/settings';
import { getSession, isAuthEnabled } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 访问口令管理
 *
 * 引导逻辑：
 *   - 尚未设置口令（password_hash 为空）→ 任何人可设置（首次初始化）。
 *     这是必要的：否则部署后没有任何途径进入配置页。
 *   - 已设置口令 → 必须已登录才能改。
 */
export async function GET() {
  const s = await getSettingsForUI();
  return NextResponse.json(s.access);
}

export async function POST(req) {
  try {
    const { password, enabled } = await req.json().catch(() => ({}));
    const current = await getSettingsForUI();

    const hasPassword = current.access.passwordSet;
    const loggedIn = Boolean(getSession(req));

    // 已设过口令，必须登录后才能改
    if (hasPassword && !loggedIn) {
      return NextResponse.json({ error: '需要先登录才能修改访问口令' }, { status: 401 });
    }

    const entries = {};

    if (typeof enabled === 'boolean') {
      entries['access.enabled'] = enabled ? '1' : '0';
    }

    if (password !== undefined) {
      const p = String(password);
      if (p.length > 0 && p.length < 4) {
        return NextResponse.json({ error: '口令至少 4 位' }, { status: 400 });
      }
      // 空字符串 = 清除口令（会同时关闭鉴权门槛）
      entries['access.password_hash'] = p ? hashPassword(p) : '';
      if (!p) entries['access.enabled'] = '0';
    }

    if (Object.keys(entries).length === 0) {
      return NextResponse.json({ error: '没有需要更新的内容' }, { status: 400 });
    }

    await setSettings(entries, ['access.password_hash'], 'access-page');

    return NextResponse.json({
      ok: true,
      authEnabled: await isAuthEnabled(),
    });
  } catch (err) {
    console.error('[api/access POST]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
