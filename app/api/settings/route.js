import { NextResponse } from 'next/server';
import {
  getSettingsForUI,
  getSettings,
  setSettings,
  invalidateSettings,
  MASK_SENTINEL,
} from '@/lib/settings';
import { testConnection } from '@/lib/llm';
import { getSession, isAuthEnabled } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 可写的配置键白名单 —— 防止前端乱塞键 */
const EDITABLE = [
  'llm.base_url',
  'llm.model',
  'llm.api_key',
  'llm.temperature',
  'llm.max_tokens',
  'llm.provider_name',
];

const SECRET_KEYS = ['llm.api_key'];

/** 统一鉴权：未启用则放行，启用则要求已登录 */
async function guard(req) {
  if (!(await isAuthEnabled())) return null;
  const sess = getSession(req);
  if (sess) return null;
  return NextResponse.json({ error: '未登录或登录已过期' }, { status: 401 });
}

// ------------------------------------------------------------
// GET：读取当前配置（脱敏）
// ------------------------------------------------------------
export async function GET(req) {
  const denied = await guard(req);
  if (denied) return denied;

  try {
    const data = await getSettingsForUI();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[api/settings GET]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------
// POST：保存配置
// ------------------------------------------------------------
export async function POST(req) {
  const denied = await guard(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const incoming = body?.settings ?? {};

    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      return NextResponse.json({ error: 'settings 必须是对象' }, { status: 400 });
    }

    // 只接受白名单内的键
    const entries = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (EDITABLE.includes(k)) entries[k] = v;
    }
    if (Object.keys(entries).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 });
    }

    // 数值校验，避免把字符串塞进温度导致运行期报错
    if (entries['llm.temperature'] !== undefined && entries['llm.temperature'] !== MASK_SENTINEL) {
      const t = Number(entries['llm.temperature']);
      if (Number.isNaN(t) || t < 0 || t > 2) {
        return NextResponse.json({ error: '温度需在 0 ~ 2 之间' }, { status: 400 });
      }
      entries['llm.temperature'] = String(t);
    }
    if (entries['llm.max_tokens'] !== undefined && entries['llm.max_tokens'] !== MASK_SENTINEL) {
      const m = Number(entries['llm.max_tokens']);
      if (!Number.isInteger(m) || m < 1 || m > 8192) {
        return NextResponse.json({ error: 'max_tokens 需为 1 ~ 8192 的整数' }, { status: 400 });
      }
      entries['llm.max_tokens'] = String(m);
    }
    if (entries['llm.base_url'] !== undefined && entries['llm.base_url'] !== MASK_SENTINEL) {
      const u = String(entries['llm.base_url']).trim();
      if (u && !/^https?:\/\//i.test(u)) {
        return NextResponse.json(
          { error: 'API 地址必须以 http:// 或 https:// 开头' },
          { status: 400 }
        );
      }
      entries['llm.base_url'] = u.replace(/\/+$/, '');
    }

    const written = await setSettings(entries, SECRET_KEYS, 'admin-page');
    invalidateSettings();

    return NextResponse.json({
      ok: true,
      written,
      note: written.length
        ? undefined
        : '没有实际变更（密钥字段提交了保持原值标记）',
    });
  } catch (err) {
    console.error('[api/settings POST]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ------------------------------------------------------------
// PUT：测试连通性（可携带尚未保存的临时值）
// ------------------------------------------------------------
export async function PUT(req) {
  const denied = await guard(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const probe = body?.probe ?? {};

    // 未保存的临时值优先；API Key 传哨兵则用库里已存的
    const override = {};
    if (probe['llm.base_url']) override.baseUrl = String(probe['llm.base_url']).replace(/\/+$/, '');
    if (probe['llm.model']) override.model = String(probe['llm.model']);
    if (probe['llm.api_key']) override.apiKey = String(probe['llm.api_key']);

    const result = await testConnection(override);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    console.error('[api/settings PUT]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
