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
