/**
 * LLM 调用层
 * 兼容 OpenAI 格式（DeepSeek / 通义 / OpenAI 均可）
 */

const BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.LLM_MODEL || 'deepseek-flash';

function requireKey() {
  const key = process.env.LLM_API_KEY;
  if (!key) {
    throw new Error(
      '缺少 LLM_API_KEY 环境变量。请在 .env.local 或 Vercel 项目设置中配置。'
    );
  }
  return key;
}

/**
 * 非流式调用 —— 用于返回完整回复
 * 教学场景下，等完整回复再合成语音体验更好（避免断句不自然）
 */
export async function chat(messages, { temperature = 0.7, maxTokens = 400 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
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
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text: text.trim(), usage: data.usage ?? null };
}

/** 流式调用 —— 用于 Web 端逐字显示 */
export async function* chatStream(messages, { temperature = 0.7, maxTokens = 400 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
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
