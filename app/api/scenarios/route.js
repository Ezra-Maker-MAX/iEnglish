import { NextResponse } from 'next/server';
import { listScenarios, getScenario } from '@/lib/scenario';

export const runtime = 'nodejs';

/** 场景列表 / 单个场景详情 */
export async function GET(req) {
  try {
    const slug = new URL(req.url).searchParams.get('slug');
    if (slug) {
      const s = await getScenario(slug);
      if (!s) return NextResponse.json({ error: 'not found' }, { status: 404 });
      return NextResponse.json(s);
    }
    return NextResponse.json({ scenarios: await listScenarios() });
  } catch (err) {
    console.error('[api/scenarios]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
