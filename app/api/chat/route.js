import {
  getScenario,
  getChild,
  buildMessages,
  createSession,
  saveTurn,
  trackVocab,
} from '@/lib/scenario';
import { chatStreamEvents } from '@/lib/llm';
import { getSession, isAuthEnabled } from '@/lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 儿童口语陪练的对话接口（流式）
 *
 * ── 为什么要改成流式 ──
 * 推理类模型（agnes-2.5-flash 等）会先产出一大段内部思维链再吐可见回复。
 * 非流式下孩子要盯着空白等 4-20 秒 —— 实测 5 秒无反馈孩子就会走开。
 * 流式让首字在 1-3 秒内蹦出来，感知等待时间下降一半以上。
 *
 * ── 协议设计 ──
 * 上游是 OpenAI 兼容 SSE；我们**不透传**，而是解析后重新编码成自己的事件流。
 * 原因：落库与轮次判定需要 usage / finish_reason，透传就拿不到了。
 *
 * 事件类型（每行 `data: <json>`）：
 *   {t:'delta', v:'...'}                      增量文本
 *   {t:'meta', sessionId, turn, storyComplete} 结束时的元数据
 *   {t:'error', v:'...'}                      错误（HTTP 200 内传递，前端好处理）
 */
const PEDAGOGY_OVERRIDES = {
  // 高温度让孩子感受到情绪起伏，不是背诵课文
  temperature: 0.9,
};

/** 推理模型额度不足时的兜底文案 —— 绝不让 9 岁孩子看到空白 */
const FALLBACK_LINE = 'Hmm... let me think! Can you say that again? 😊';

async function requireAccess(req) {
  if (!(await isAuthEnabled())) return null;
  const sess = getSession(req);
  if (sess) return null;
  return { error: '未登录。请先访问 /admin 输入访问口令。', status: 401 };
}

export async function POST(req) {
  const denied = await requireAccess(req);
  if (denied) {
    return new Response(JSON.stringify({ error: denied.error }), {
      status: denied.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: '请求体不是合法 JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const {
    scenarioSlug,
    childId = 'child-001',
    sessionId,
    history = [],
    userText,
  } = payload;

  if (!userText?.trim()) {
    return new Response(JSON.stringify({ error: 'userText 不能为空' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (userText.length > 2000) {
    return new Response(JSON.stringify({ error: '单次输入过长（上限 2000 字符）' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const scenario = await getScenario(scenarioSlug).catch(() => null);
  if (!scenario) {
    return new Response(JSON.stringify({ error: `场景不存在: ${scenarioSlug}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const child = await getChild(childId).catch(() => null);

  let sid = sessionId;
  if (!sid) {
    try {
      sid = await createSession(childId, scenario.id);
    } catch (e) {
      console.warn('[api/chat] 建会话失败，降级为无会话模式:', e.message);
    }
  }

  const fullHistory = [...history, { role: 'child', text: userText }];
  const messages = buildMessages(scenario, fullHistory, child);

  const seq = history.length;
  const aiTurn = Math.floor(seq / 2) + 1;
  const maxTurn =
    scenario.events?.reduce((m, e) => Math.max(m, Number(e.at_turn) || 0), 0) || 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      let collected = '';

      try {
        for await (const ev of chatStreamEvents(messages, PEDAGOGY_OVERRIDES)) {
          if (ev.type === 'delta') {
            collected += ev.text;
            send({ t: 'delta', v: ev.text });
          } else if (ev.type === 'error') {
            // 上游在流开始前就失败 —— 还没吐任何字，可以安全重试一次
            if (!collected) {
              console.warn('[api/chat] 流启动失败，重试一次:', ev.message);
              let retried = false;
              const retry = chatStreamEvents(messages, {
                ...PEDAGOGY_OVERRIDES,
                maxTokens: Math.min((scenario._maxTokensHint || 900) * 2, 4096),
              });
              for await (const e2 of retry) {
                if (e2.type === 'delta') {
                  collected += e2.text;
                  retried = true;
                  send({ t: 'delta', v: e2.text });
                } else if (e2.type === 'error') {
                  break;
                }
              }
              if (!retried) send({ t: 'error', v: '生成失败，请再试一次' });
            } else {
              send({ t: 'error', v: '回复中断，请再试一次' });
            }
          } else if (ev.type === 'done') {
            // ---- 空回复兜底 ----
            // 推理模型会把 max_tokens 全花在思维链上，导致 content 为空串。
            // 这里在孩子已经等待的情况下再翻倍重试一次，仍不行就给兜底文案。
            if (ev.empty && !collected) {
              console.warn(
                '[api/chat] 回复为空 finishReason=%s reasoningTokens=%s，翻倍重试',
                ev.finishReason,
                ev.reasoningTokens
              );
              const retry = chatStreamEvents(messages, {
                ...PEDAGOGY_OVERRIDES,
                maxTokens: Math.min((scenario._maxTokensHint || 900) * 2, 4096),
              });
              for await (const e2 of retry) {
                if (e2.type === 'delta') {
                  collected += e2.text;
                  send({ t: 'delta', v: e2.text });
                } else if (e2.type === 'error') {
                  break;
                }
              }
            }
            if (!collected) {
              collected = FALLBACK_LINE;
              send({ t: 'delta', v: FALLBACK_LINE });
            }
            break;
          }
        }
      } catch (err) {
        console.error('[api/chat] 流异常:', err);
        if (!collected) {
          collected = FALLBACK_LINE;
          send({ t: 'delta', v: FALLBACK_LINE });
        }
      }

      // ---- 落库 + 收尾元数据 ----
      try {
        if (sid) {
          await saveTurn(sid, seq, 'child', userText);
          await saveTurn(sid, seq + 1, 'ai', collected);
        }
        await trackVocab(childId, scenario.vocabList, userText);
      } catch (e) {
        console.warn('[api/chat] 落库失败（不影响对话）:', e.message);
      }

      send({
        t: 'meta',
        sessionId: sid,
        reply: collected,
        turn: aiTurn,
        storyComplete: maxTurn > 0 ? aiTurn >= maxTurn : false,
        totalTurns: Math.max(history.length + 2, 1),
      });
      send({ t: 'done' });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 Nginx / 中间层的缓冲，否则流会被攒成一坨再下发
      'X-Accel-Buffering': 'no',
    },
  });
}
