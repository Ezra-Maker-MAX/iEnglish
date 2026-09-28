'use client';

import { useState, useRef, useEffect } from 'react';

export default function PracticeClient({ scenarios }) {
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading || !selected) return;

    setInput('');
    setError(null);
    setLoading(true);
    const nextHistory = [...history, { role: 'child', text }];
    setHistory(nextHistory);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioSlug: selected.slug,
          sessionId,
          history,
          userText: text,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);

      setSessionId(data.sessionId);
      setHistory([...nextHistory, { role: 'ai', text: data.reply }]);
    } catch (e) {
      setError(e.message);
      setHistory(history);
    } finally {
      setLoading(false);
    }
  }

  // ---------- 场景选择 ----------
  if (!selected) {
    return (
      <div className="wrap">
        <header className="head">
          <h1>iEnglish</h1>
          <p className="sub">选一个场景，用英语跟 AI 聊聊天</p>
        </header>

        <div className="grid">
          {scenarios.map((s) => (
            <button
              key={s.slug}
              className="card"
              onClick={() =>
                setSelected({
                  slug: s.slug,
                  title: s.title,
                  difficulty: Number(s.difficulty),
                })
              }
            >
              <span className="stars">{'⭐'.repeat(Number(s.difficulty) || 1)}</span>
              <span className="ctitle">{s.title}</span>
            </button>
          ))}
        </div>

        <p className="tip">
          建议：先用文字对话验证教学效果，再接入语音。
        </p>
      </div>
    );
  }

  // ---------- 对话界面 ----------
  return (
    <div className="wrap">
      <header className="head chat-head">
        <button className="back" onClick={() => { setSelected(null); setHistory([]); setSessionId(null); }}>
          ← 换个场景
        </button>
        <h2>{selected.title}</h2>
      </header>

      <div className="chat">
        {history.length === 0 && (
          <div className="sys">
            <p>场景已准备好，输入一句英语开始对话吧。</p>
            <p className="hint">提示：AI 全程说英语，不会打断你纠错，卡住时会给你两个选择。</p>
          </div>
        )}

        {history.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <span className="who">{m.role === 'child' ? '你' : 'AI'}</span>
            <span className="txt">{m.text}</span>
          </div>
        ))}

        {loading && (
          <div className="bubble ai">
            <span className="who">AI</span>
            <span className="txt typing">正在回复…</span>
          </div>
        )}

        {error && <div className="err">出错了：{error}</div>}
        <div ref={endRef} />
      </div>

      <div className="bar">
        <input
          className="inp"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="Type in English…"
          disabled={loading}
          autoFocus
        />
        <button className="send" onClick={send} disabled={loading || !input.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}
