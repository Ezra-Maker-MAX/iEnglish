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

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 文字对话接口
 * 第一期第一步：纯文字验证教学提示词质量，不需要任何语音服务
 */
export async function POST(req) {
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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
