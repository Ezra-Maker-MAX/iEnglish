import { NextResponse } from 'next/server';
import {
  getScenario,
  getChild,
  buildMessages,
  createSession,
  saveTurn,
  trackVocab,
} from '@/lib/scenario';
import { chat } from '@/lib/llm';
import { getSession, isAuthEnabled } from '@/lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 文字对话接口
 *
 * 第一层保护：启用了访问口令时，要求已登录。
 * 理由：本接口背后是付费 API Key，公网开放等于给别人送额度。
 */
async function requireAccess(req) {
  if (!(await isAuthEnabled())) return null;
  const sess = getSession(req);
  if (sess) return null;
  return NextResponse.json(
    { error: '未登录。请先访问 /admin 输入访问口令。' },
    { status: 401 }
  );
}

export async function POST(req) {
  const denied = await requireAccess(req);
  if (denied) return denied;

  try {
    const {
      scenarioSlug,
      childId = 'child-001',
      sessionId,
      history = [],
      userText,
    } = await req.json();

    if (!userText?.trim()) {
      return NextResponse.json({ error: 'userText 不能为空' }, { status: 400 });
    }
    if (userText.length > 2000) {
      return NextResponse.json({ error: '单次输入过长（上限 2000 字符）' }, { status: 400 });
    }

    const scenario = await getScenario(scenarioSlug);
    if (!scenario) {
      return NextResponse.json({ error: `场景不存在: ${scenarioSlug}` }, { status: 404 });
    }

    const child = await getChild(childId);

    // 新建会话（首轮）或复用
    let sid = sessionId;
    if (!sid) {
      sid = await createSession(childId, scenario.id);
    }

    // 构建消息：场景提示词 + 历史 + 本轮输入
    const fullHistory = [...history, { role: 'child', text: userText }];
    const messages = buildMessages(scenario, fullHistory, child);

    const { text: reply, usage } = await chat(messages);

    // 落库
    const seq = history.length;
    await saveTurn(sid, seq, 'child', userText);
    await saveTurn(sid, seq + 1, 'ai', reply);
    await trackVocab(childId, scenario.vocabList, userText);

    return NextResponse.json({
      sessionId: sid,
      reply,
      usage,
    });
  } catch (err) {
    console.error('[api/chat]', err);
    const msg = err.message || '未知错误';
    // 配置类错误给 400 更合适，方便前端区分
    const status = msg.includes('API Key') ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
