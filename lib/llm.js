import { getSettings } from './settings';

/**
 * LLM 调用层
 * 兼容 OpenAI 格式（DeepSeek / 通义 / OpenAI / 硅基流动 …… 均可）
 *
 * 配置来源优先级：
 *   1. Turso app_settings 表（网页可改，改完即生效）—— 主
 *   2. 环境变量（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）—— 兜底
 *
 * 之所以环境变量只做兜底而不是主源：改 key 不该需要重新部署。
 */

/** 解析运行期配置（每次调用都读，但底层有 30 秒缓存，开销可忽略） */
async function resolveConfig() {
  let s = {};
  try {
    s = await getSettings();
  } catch {
    // 数据库不可用时不阻塞 —— 退化为纯环境变量模式
  }

  const baseUrl = (s['llm.base_url'] || process.env.LLM_BASE_URL || 'https://api.deepseek.com')
    .replace(/\/+$/, '');
  const model = s['llm.model'] || process.env.LLM_MODEL || 'deepseek-chat';
  const apiKey = s['llm.api_key'] || process.env.LLM_API_KEY || '';
  const temperature = Number(s['llm.temperature'] ?? 0.7) || 0.7;
  // 默认 400 对推理类模型偏小（推理 token 会先吃掉一大块），提到 900 更稳。
  // 已有配置不会被覆盖 —— 只有未显式设置时才用新默认值。
  const maxTokens = Number(s['llm.max_tokens'] ?? 0) || Number(process.env.LLM_MAX_TOKENS || 900);

  return { baseUrl, model, apiKey, temperature, maxTokens };
}

/** 缺 key 时给出可操作的报错文案 */
function requireKey(cfg) {
  if (!cfg.apiKey) {
    throw new Error(
      '尚未配置 LLM API Key。请打开 /admin 配置页填写，或在环境变量中设置 LLM_API_KEY。'
    );
  }
  return cfg.apiKey;
}

/**
 * 非流式调用 —— 用于返回完整回复
 * 教学场景下，等完整回复再合成语音体验更好（避免断句不自然）
 */
export async function chat(messages, overrides = {}) {
  const cfg = await resolveConfig();
  const temperature = overrides.temperature ?? cfg.temperature;
  const maxTokens = overrides.maxTokens ?? cfg.maxTokens;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireKey(cfg)}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LLM 调用失败 ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0] ?? {};
  // 注意：推理类模型（如 agnes-2.5-flash / deepseek-reasoner）会先产出
  // reasoning_content 思维链，再从剩余 token 里产出 content。
  // max_tokens 太小会导致 content 为空 —— 见下方空回复兜底。
  const text = choice.message?.content ?? '';
  return {
    text: text.trim(),
    usage: data.usage ?? null,
    model: cfg.model,
    finishReason: choice.finish_reason ?? null,
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** 流式调用 —— 用于 Web 端逐字显示 */
export async function* chatStream(messages, overrides = {}) {
  const cfg = await resolveConfig();
  const temperature = overrides.temperature ?? cfg.temperature;
  const maxTokens = overrides.maxTokens ?? cfg.maxTokens;

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireKey(cfg)}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LLM 调用失败 ${res.status}: ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 忽略不完整分片
      }
    }
  }
}

/**
 * 流式调用 —— 产出「文本增量 + 结束元数据」的异步生成器
 *
 * 为什么不用 chatStreamToResponse 直接透传上游 Response：
 *   上层需要拿到 usage / finish_reason 才能做落库与轮次判定，
 *   而透传上游响应就拿不到了。这里把上游 SSE 解析成我们自己的事件流，
 *   由调用方决定如何编码（HTTP SSE / 其它）。
 *
 * yield 形状：
 *   { type: 'delta', text }                  —— 增量文本
 *   { type: 'done', usage, finishReason, reasoningTokens, empty }
 *   { type: 'error', message, status }
 *
 * 空回复兜底放在调用方（route）做，因为它掌握重试与文案策略。
 */
export async function* chatStreamEvents(messages, overrides = {}) {
  const cfg = await resolveConfig();
  const temperature = overrides.temperature ?? cfg.temperature;
  const maxTokens = overrides.maxTokens ?? cfg.maxTokens;

  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${requireKey(cfg)}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        // 让上游在最后一个 chunk 里带上 usage（OpenAI 兼容字段）
        stream_options: { include_usage: true },
      }),
    });
  } catch (e) {
    yield { type: 'error', message: `连接失败: ${e.message}`, status: 0 };
    return;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    yield { type: 'error', message: `LLM 调用失败 ${res.status}: ${detail.slice(0, 300)}`, status: res.status };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawText = false;
  let usage = null;
  let finishReason = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') {
          yield {
            type: 'done',
            usage,
            finishReason,
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
            empty: !sawText,
          };
          return;
        }
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 忽略不完整分片
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta) {
          sawText = true;
          yield { type: 'delta', text: delta };
        }
      }
    }
  } catch (e) {
    yield { type: 'error', message: `流读取中断: ${e.message}`, status: 0 };
    return;
  }

  // 上游未发 [DONE] 就断流 —— 仍按正常结束处理，让前端能收尾
  yield {
    type: 'done',
    usage,
    finishReason,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    empty: !sawText,
  };
}

/**
 * 连通性测试 —— 供配置页「测试连接」按钮调用
 * 用最小开销的一次请求验证 base_url / key / model 三者是否可用
 */
export async function testConnection(override = {}) {
  const base = await resolveConfig();
  const cfg = { ...base, ...override };

  // 允许覆盖 key（前端刚填还没保存时也能测）
  if (override.apiKey === '__KEEP__') cfg.apiKey = base.apiKey;

  const started = Date.now();
  try {
    requireKey(cfg);
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
    });

    const ms = Date.now() - started;

    if (!res.ok) {
      const detail = await res.text();
      return { ok: false, ms, error: `HTTP ${res.status}: ${detail.slice(0, 300)}` };
    }

    const data = await res.json();
    return {
      ok: true,
      ms,
      model: data.model ?? cfg.model,
      sample: data.choices?.[0]?.message?.content ?? '',
      usage: data.usage ?? null,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.message };
  }
}
