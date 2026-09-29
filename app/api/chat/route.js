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
 * 推理类模型（agnes-2.5-flash / deepseek-reasoner 等）会先产出一大段内部思维链，
 * 再吐可见回复。对孩子用的对话产品来说，这段等待是致命的：
 * 实测冷启动 7-28 秒，孩子在 5 秒内没有回应就会走开。
 *
 * 对策：为「儿童口语陪练」这一场景把温度调高、显式压缩推理开销，
 * 并在提示词里要求极短回复（每句 6-8 词，整段不超过 3 句）。
 * 供应商若不支持这些字段会直接忽略，属安全操作。
 */
const PEDAGOGY_OVERRIDES = {
  // 高温度让孩子感受到情绪起伏，不是背诵课文
  temperature: 0.9,
};

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

    let { text: reply, usage, finishReason } = await chat(messages, PEDAGOGY_OVERRIDES);

    // ---- 空回复兜底 ----
    // 推理类模型会把 max_tokens 先花在思维链上，导致 content 为空串。
    // 对策：翻倍额度重试一次；仍为空则退化为一句自然的推进语，避免孩子看到空白。
    if (!reply) {
      console.warn('[api/chat] 首次回复为空 finishReason=%s，翻倍 max_tokens 重试', finishReason);
      const retry = await chat(messages, {
        maxTokens: Math.min((scenario._maxTokensHint || 900) * 2, 4096),
      });
      reply = retry.text;
      usage = retry.usage ?? usage;
    }
    if (!reply) {
      reply = "Hmm... let me think! Can you say that again? 😊";
    }

    // 落库
    const seq = history.length;
    await saveTurn(sid, seq, 'child', userText);
    await saveTurn(sid, seq + 1, 'ai', reply);
    await trackVocab(childId, scenario.vocabList, userText);

    // 轮次计数：用于前端推进关卡与触发突发事件
    // 一轮 = 1 条孩子发言 + 1 条 AI 回复，故 aiTurn = seq/2 + 1
    const aiTurn = Math.floor(seq / 2) + 1;
    const maxTurn = scenario.events?.reduce(
      (m, e) => Math.max(m, Number(e.at_turn) || 0),
      0
    ) || 0;

    return NextResponse.json({
      sessionId: sid,
      reply,
      usage,
      turn: aiTurn,
      // 剧情是否已走完（用于前端提示可以结营领徽章）
      storyComplete: maxTurn > 0 ? aiTurn >= maxTurn : false,
      totalTurns: Math.max(history.length + 2, 1),
    });
  } catch (err) {
    console.error('[api/chat]', err);
    const msg = err.message || '未知错误';
    // 配置类错误给 400 更合适，方便前端区分
    const status = msg.includes('API Key') ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
