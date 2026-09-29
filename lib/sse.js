/**
 * 极简 SSE 客户端 —— 消费 /api/chat 的事件流
 *
 * 为什么不用 EventSource：
 *   1) EventSource 只支持 GET，我们需要 POST 带 body（历史记录可能很长）
 *   2) EventSource 无法中断（组件卸载时要能停）
 *   3) 我们需要在「首字到达」这一刻就更新 UI，EventSource 的抽象反而碍事
 *
 * 协议（与 app/api/chat/route.js 一一对应）：
 *   {t:'delta', v:'...'}                       增量文本
 *   {t:'meta', sessionId, reply, turn, ...}    结束元数据
 *   {t:'error', v:'...'}                       错误
 *   {t:'done'}                                 流结束
 */
export async function streamChat(body, { onDelta, onMeta, onError, signal } = {}) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  // 鉴权 / 参数错误走普通 JSON 响应，不进入流
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* 保持默认文案 */
    }
    throw new Error(msg);
  }

  if (!res.body) throw new Error('响应无内容');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let meta = null;
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const raw = s.slice(5).trim();
      if (!raw) continue;

      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue; // 忽略不完整分片
      }

      if (ev.t === 'delta') {
        full += ev.v ?? '';
        onDelta?.(ev.v ?? '', full);
      } else if (ev.t === 'meta') {
        meta = ev;
        onMeta?.(ev);
      } else if (ev.t === 'error') {
        onError?.(ev.v || '生成出错');
      }
      // ev.t === 'done' → 循环自然结束
    }
  }

  return { meta, text: full };
}
