import { getScenario } from '@/lib/scenario';
import { getSession, isAuthEnabled } from '@/lib/auth';
import { getSpeech, cacheKey } from '@/lib/tts-cache';
import { looksLikeMp3 } from '@/lib/tts';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * ============================================================
 * 语音合成接口
 * ============================================================
 *
 * 设计决策
 * --------
 * 1. **POST 文本、返回 MP3 字节**（而不是返回音频 URL）
 *    本机与 Vercel 都没有可靠的持久对象存储；直接吐字节最简单，
 *    且天然免去「先上传再下发」的两次往返。
 *
 * 2. **服务端缓存是功能的一部分，不是优化**
 *    孩子会反复点「重听」。命中缓存时响应 < 10ms，未命中要 3-5 秒。
 *
 * 3. **失败不返回 5xx**
 *    语音是「锦上添花」，坏掉不该影响闯关。这里统一返回 JSON 错误
 *    + 200 之外的状态码，由前端静默降级（只显示文字）。
 *
 * 4. **鉴权与 /api/chat 一致**
 *    合成同样消耗上游资源，且部署到公网会被白嫖，必须同一道门。
 */
const MAX_CHARS = 800; // 单次请求上限：孩子的一句回复远不到这个长度

async function requireAccess(req) {
  if (!(await isAuthEnabled())) return null;
  if (getSession(req)) return null;
  return { error: '未登录。请先访问 /admin 输入访问口令。', status: 401 };
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 解析引擎参数：优先请求体，其次场景配置，最后默认值 */
function resolveVoiceOptions(payload, scenario) {
  const rate = payload.rate ?? scenario?.voiceRate ?? '-10%';
  const pitch = payload.pitch ?? scenario?.voicePitch ?? '+0Hz';
  const volume = payload.volume ?? '+0%';
  const style = payload.style ?? 'default';
  return { rate, pitch, volume, style };
}

export async function POST(req) {
  const denied = await requireAccess(req);
  if (denied) return jsonError(denied.error, denied.status);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }

  const { text, voice: reqVoice, scenarioSlug, noCache } = payload;

  const clean = String(text || '').trim();
  if (!clean) return jsonError('text 不能为空', 400);
  if (clean.length > MAX_CHARS) {
    return jsonError(`text 过长（${clean.length} 字符，上限 ${MAX_CHARS}）`, 400);
  }

  // 音色：请求体优先；否则取场景绑定的角色音色；再退化为通用女声
  let scenario = null;
  if (scenarioSlug) {
    scenario = await getScenario(scenarioSlug).catch(() => null);
  }
  const voice = reqVoice || scenario?.characterVoice || 'en-US-AriaNeural';
  const options = { voice, ...resolveVoiceOptions(payload, scenario) };

  try {
    const started = Date.now();
    const r = await getSpeech(clean, options);

    // 兜底校验：上游异常时可能返回非音频内容，绝不能让它污染缓存
    if (!looksLikeMp3(r.audio)) {
      console.error('[api/tts] 合成结果不是 MP3，已拒绝返回');
      return jsonError('合成结果异常，请重试', 502);
    }

    const key = cacheKey(clean, options);
    return new Response(r.audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(r.audio.length),
        // 内容寻址 → 同一 URL 永远同一字节，可长期强缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-TTS-Cache': r.cache,
        'X-TTS-Voice': voice,
        'X-TTS-Key': key.slice(0, 16),
        'X-TTS-Ms': String(Date.now() - started),
        // 便于前端在缓存前后切换文案
        'Access-Control-Expose-Headers': 'X-TTS-Cache, X-TTS-Voice, X-TTS-Ms',
      },
    });
  } catch (e) {
    console.error('[api/tts] 合成失败:', e.message);
    return jsonError(e.message || '语音合成失败', 502);
  }
}

/** GET /api/tts —— 供连通性自检 */
export async function GET() {
  const ok = typeof WebSocket === 'function';
  return Response.json({
    ok,
    engine: 'edge-tts (via Node built-in WebSocket)',
    note: ok
      ? 'POST { text, voice?, scenarioSlug? } 返回 audio/mpeg'
      : '当前 Node 运行时没有内置 WebSocket，需 Node ≥ 21',
    node: process.version,
  });
}
