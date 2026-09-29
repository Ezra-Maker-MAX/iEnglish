'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { streamChat } from '@/lib/sse';

/**
 * 孩子端闯关界面
 *
 * 设计目标（针对「像聊天软件 / 没目标感 / 没戏剧性」三个反馈）：
 *   1. 顶部常驻关卡进度条 —— 随时看得见还有几关
 *   2. 角色卡 —— 强化「我在和一个活人玩」，而不是和软件对话
 *   3. 突发事件横幅 —— 剧情转折用视觉强调，制造惊喜
 *   4. 通关结算页 —— 徽章 + 称号 + 升级表达，有明确的收尾
 *   5. 快捷回答芯片 —— 9 岁初学孩子打字慢，给可点的选项，降低门槛
 */

/**
 * 关卡推进策略（关键设计决策，踩过坑）
 *
 * 坑：早期版本让前端用「轮次计数」独立推进进度，AI 又按自己的节奏走剧情，
 *     结果第 8 轮进度条显示 4/4 全通关，Max 却还在问 "How many bags?" —— 
 *     孩子看到的是「我赢了但游戏没反应」，体验断裂。
 *
 * 现在的原则：**进度条是剧情的镜子，不是独立的计时器。**
 *   1) 首选 —— missions[].at_turn 由场景配置定义（与提示词里的 PACING 一一对应），
 *      服务端返回当前轮次，前端据此点亮对应的关卡。这是权威来源。
 *   2) 关键词命中时可以提前点亮，给孩子即时爽感（但不会超越 at_turn 太多）。
 *   3) at_turn 未配置时才退化为纯轮次兜底（兼容其他未改造场景）。
 */
const MISSION_SIGNALS = [
  { id: 't1', words: ['boarding', 'pass', 'ticket', 'check in', 'checkin', 'window', 'aisle', 'seat'] },
  { id: 't2', words: ['heavy', 'too heavy', 'take out', 'backpack', 'pay extra', 'move'] },
  { id: 't3', words: ['security', 'tray', 'metal', 'belt', 'walk through'] },
  { id: 't4', words: ['board', 'gate', 'plane', 'thank you', 'bye'] },
];

/** 每个关卡跨多少轮（仅当 missions 未配置 at_turn 时作为兜底） */
const TURN_PER_MISSION = 2;

export default function PracticeClient({ scenarios }) {
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [history, setHistory] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  /** 流式输出中 —— 气泡末尾显示光标，让"正在打字"这件事可见 */
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [turn, setTurn] = useState(0);
  const [error, setError] = useState(null);

  const [doneMissions, setDoneMissions] = useState([]);
  const [praise, setPraise] = useState(null);
  const [eventBanner, setEventBanner] = useState(null);
  const [finished, setFinished] = useState(false);
  /** 开场视频是否已关闭（用户手动关，或文件加载失败） */
  const [videoClosed, setVideoClosed] = useState(false);
  /** 等待时长计时器 —— 推理类模型响应可能长达 20 秒，需要给孩子持续反馈 */
  const [elapsed, setElapsed] = useState(0);

  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [history, loading, eventBanner]);

  // 等待计时 + 分档提示文案：让孩子知道"它在想"，而不是卡死了
  useEffect(() => {
    if (!loading) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const missions = detail?.missions ?? [];
  const events = detail?.events ?? [];
  const progress = missions.length
    ? Math.round((doneMissions.length / missions.length) * 100)
    : 0;

  const currentMission = useMemo(
    () => missions.find((m) => !doneMissions.includes(m.id)) ?? null,
    [missions, doneMissions]
  );

  // ---------- 进入场景：拉取详情 + 播放开场白 ----------
  async function enter(s) {
    setSelected(s);
    setDetail(null);
    setHistory([]);
    setSessionId(null);
    setTurn(0);
    setDoneMissions([]);
    setPraise(null);
    setEventBanner(null);
    setFinished(false);
    setVideoClosed(false);
    setError(null);
    setLoadingDetail(true);

    try {
      const res = await fetch(`/api/scenarios?slug=${encodeURIComponent(s.slug)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '读取场景失败');
      setDetail(d);

      // 开场白直接展示（不消耗 LLM 额度，也保证第一屏立刻有内容）
      if (d.openingLine) {
        setHistory([{ role: 'ai', text: d.openingLine, opening: true }]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingDetail(false);
    }
  }

  function leave() {
    setSelected(null);
    setDetail(null);
    setHistory([]);
  }

  // ---------- 关卡推进 ----------
  /**
   * 返回本次应该解锁的关卡列表（可能一次解锁多个，当剧情跳跃时）。
   *
   * 权威来源是 missions[].at_turn：
   *   currentTurn >= at_turn  → 该关已完成
   * 这样进度条与 AI 剧情由同一份配置驱动，不可能再脱节。
   */
  function diffMissions(childText, currentTurn) {
    const low = childText.toLowerCase();

    // 关键词提前过关：只允许解锁「轮次尚未到达、但孩子已经说出了关键内容」的那一关
    const keywordHit = missions.find((m) => {
      if (doneMissions.includes(m.id)) return false;
      const sig = MISSION_SIGNALS.find((s) => s.id === m.id);
      if (!sig || !sig.words.some((w) => low.includes(w))) return false;
      // 只提前解锁下一关，避免一句话跳太多
      const next = missions.find((x) => !doneMissions.includes(x.id));
      return next && next.id === m.id;
    });

    const unlocked = missions.filter((m) => {
      if (doneMissions.includes(m.id)) return false;
      const at = Number(m.at_turn) || 0;
      if (at > 0) return currentTurn >= at;          // 配置驱动（权威）
      if (keywordHit?.id === m.id) return true;      // 关键词加速
      // 兜底：未配置 at_turn 时按轮次估算
      const idx = missions.indexOf(m);
      return currentTurn >= (idx + 1) * TURN_PER_MISSION;
    });

    return unlocked;
  }

  function fireEventIfAny(nextTurn) {
    const ev = events.find((e) => Number(e.at_turn) === nextTurn);
    if (ev) setEventBanner({ text: ev.event, hint: ev.ai_hint });
  }

  async function send(forcedText) {
    const text = (forcedText ?? input).trim();
    if (!text || loading || !selected) return;

    setInput('');
    setError(null);
    setLoading(true);
    setStreaming(false);
    setEventBanner(null);

    const nextHistory = [...history, { role: 'child', text }];
    setHistory(nextHistory);

    try {
      // ---- 流式消费 ----
      // 首字到达就立刻渲染，孩子看到的是「TA 正在打给我看」，
      // 而不是对着三个点干等 5-20 秒。
      const { meta } = await streamChat(
        {
          scenarioSlug: selected.slug,
          sessionId,
          history: history.filter((m) => !m.opening),
          userText: text,
        },
        {
          onDelta: (chunk, full) => {
            setStreaming(true);
            setLoading(false); // 首个字到达 → 撤掉「正在想」气泡，换成真实文字
            setHistory([...nextHistory, { role: 'ai', text: full, streaming: true }]);
          },
          onError: (msg) => setError(msg),
        }
      );

      // 收尾：把流式气泡固化为普通气泡
      const finalText = meta?.reply || '';
      if (finalText) {
        setHistory([...nextHistory, { role: 'ai', text: finalText }]);
      }

      setSessionId(meta?.sessionId ?? sessionId);

      if (detail?.gamified && meta) {
        const nowTurn = meta.turn ?? turn + 1;
        setTurn(nowTurn);

        // 关卡判定：由 missions[].at_turn 驱动，进度条严格镜像剧情
        const unlocked = diffMissions(text, nowTurn);
        if (unlocked.length > 0) {
          setDoneMissions((prev) => {
            const next = [...prev];
            for (const m of unlocked) if (!next.includes(m.id)) next.push(m.id);
            return next;
          });
          const last = unlocked[unlocked.length - 1];
          const line =
            detail.praiseLines?.[Math.floor(Math.random() * detail.praiseLines.length)] ||
            'Nice! You did it!';
          setPraise({ text: line, mission: last });
          setTimeout(() => setPraise(null), 2600);
        } else {
          // 没到过关轮次也要给正反馈 —— 9 岁孩子等两轮才被夸一次太久了。
          // 用轻量的"接住了"提示，与过关庆祝区分开。
          const quicks = ['Nice try! 👍', 'Good job! Keep going! 💪', 'I like that! 😄', 'Great effort! ⭐'];
          setPraise({
            text: quicks[Math.floor(Math.random() * quicks.length)],
            mission: { label: `继续冲：${(missions.find((m) => !doneMissions.includes(m.id)) || {}).label || ''}` },
            light: true,
          });
          setTimeout(() => setPraise(null), 1800);
        }
        // 突发事件
        fireEventIfAny(nowTurn);

        // 通关判定：全部关卡达成即进入结算
        // 注意：这里不用 setTimeout 延迟 —— 延迟会让「进度已满但界面没反应」
        // 出现在测试和真实使用的窗口期。改成同步置位，动画交给 CSS 负责。
        const total = new Set([...doneMissions, ...unlocked.map((m) => m.id)]).size;
        if (missions.length > 0 && total >= missions.length) {
          setFinished(true);
        }
      }
    } catch (e) {
      setError(e.message);
      setHistory(history);
    } finally {
      setLoading(false);
      setStreaming(false);
    }
  }

  // ================= 场景选择 =================
  if (!selected) {
    return (
      <div className="wrap">
        <header className="head">
          <h1>iEnglish</h1>
          <p className="sub">选一个冒险，用英语闯关</p>
        </header>

        <div className="grid">
          {scenarios.map((s) => (
            <button key={s.slug} className="card" onClick={() => enter(s)}>
              <span className="stars">{'⭐'.repeat(Number(s.difficulty) || 1)}</span>
              <span className="ctitle">{s.title}</span>
              {s.gamified ? (
                <span className="card-tag">🎮 闯关模式</span>
              ) : (
                <span className="card-tag plain">💬 对话模式</span>
              )}
            </button>
          ))}
        </div>

        <p className="tip">
          <a className="adminlink" href="/admin">⚙ 配置中心</a>
          <span className="dot">·</span>
          <a className="adminlink" href="/dashboard">📊 学习看板</a>
        </p>
      </div>
    );
  }

  // ================= 加载中 =================
  if (loadingDetail) {
    return (
      <div className="wrap">
        <p className="tip">正在准备场景…</p>
      </div>
    );
  }

  // ================= 通关结算页 =================
  if (finished) {
    return (
      <div className="wrap">
        <div className="finish">
          <div className="finish-badge">{detail?.rewardBadge || '🏅'}</div>
          <h1 className="finish-title">{detail?.rewardTitle || 'Mission Complete!'}</h1>
          <p className="finish-sub">{detail?.title}</p>

          <div className="finish-missions">
            {missions.map((m) => (
              <div key={m.id} className="fm done">
                <span className="fm-icon">
                  {m.icon_image ? <img src={m.icon_image} alt="" /> : m.icon}
                </span>
                <span className="fm-label">{m.label}</span>
                <span className="fm-check">✓</span>
              </div>
            ))}
          </div>

          <div className="finish-stats">
            <div className="fs">
              <span className="fsn">{turn}</span>
              <span className="fsl">轮对话</span>
            </div>
            <div className="fs">
              <span className="fsn">{missions.length}</span>
              <span className="fsl">个关卡</span>
            </div>
          </div>

          <div className="finish-actions">
            <button className="save" onClick={() => enter(selected)}>
              再玩一次
            </button>
            <button className="ghost" onClick={leave}>
              换个冒险
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ================= 闯关界面 =================
  return (
    <div className="wrap game">
      {/* 顶栏：返回 + 进度 */}
      <header className="game-head">
        <button className="back" onClick={leave}>← 换个冒险</button>
        <div className="prog-wrap">
          <div className="prog-bar">
            <div className="prog-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="prog-num">
            {doneMissions.length}/{missions.length || 1}
          </span>
        </div>
      </header>

      {/* 开场短视频 —— 仅在场景配置了 introVideo 且用户未关闭时显示 */}
      {detail?.introVideo && !videoClosed && (
        <div className="introvideo">
          <video
            src={detail.introVideo}
            autoPlay
            muted
            playsInline
            loop
            onError={() => setVideoClosed(true)}
          />
          <button className="iv-close" onClick={() => setVideoClosed(true)} aria-label="关闭">
            ✕
          </button>
        </div>
      )}

      {/* 角色卡 */}
      <div className="charcard">
        <div className="avatar">
          {detail?.characterAvatar ? (
            <img src={detail.characterAvatar} alt={detail.characterName || 'AI'} />
          ) : detail?.characterName ? (
            detail.characterName[0]
          ) : (
            '💬'
          )}
        </div>
        <div className="charinfo">
          <div className="charname">
            {detail?.characterName || detail?.title}
            <span className="charlive">在线</span>
          </div>
          <div className="charpersona">
            {detail?.characterPersona || '你的英语对话伙伴'}
          </div>
        </div>
      </div>

      {/* 关卡清单 */}
      {missions.length > 0 && (
        <div className="missions">
          {missions.map((m) => {
            const done = doneMissions.includes(m.id);
            const active = currentMission?.id === m.id;
            return (
              <div key={m.id} className={`mission ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
                <span className="m-icon">
                  {done ? (
                    '✅'
                  ) : m.icon_image ? (
                    <img src={m.icon_image} alt="" />
                  ) : (
                    m.icon
                  )}
                </span>
                <span className="m-label">
                  {m.label}
                  {m.label_en && <em>{m.label_en}</em>}
                </span>
                {active && !done && <span className="m-hint">进行中</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* 突发事件 */}
      {eventBanner && (
        <div className="event">
          <span className="event-tag">⚠ 突发情况</span>
          <span className="event-text">{eventBanner.text}</span>
        </div>
      )}

      {/* 对话流 */}
      <div className="chat">
        {history.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === 'ai' &&
              (detail?.characterAvatar ? (
                <img className="avatar-sm img" src={detail.characterAvatar} alt={detail.characterName || 'AI'} />
              ) : (
                <span className="avatar-sm">
                  {detail?.characterName ? detail.characterName[0] : 'AI'}
                </span>
              ))}
            <span className="txt">
              {m.text}
              {m.streaming && <span className="caret" />}
            </span>
          </div>
        ))}

        {loading && (
          <div className="bubble ai">
            {detail?.characterAvatar ? (
              <img className="avatar-sm img" src={detail.characterAvatar} alt={detail.characterName || 'AI'} />
            ) : (
              <span className="avatar-sm">
                {detail?.characterName ? detail.characterName[0] : 'AI'}
              </span>
            )}
            <span className="txt typing">
              <span className="dots">
                <i /><i /><i />
              </span>
              <span className="waiting-text">
                {elapsed < 3
                  ? `${detail?.characterName || 'TA'} 正在听你说…`
                  : elapsed < 8
                    ? `${detail?.characterName || 'TA'} 正在想怎么回你…`
                    : elapsed < 15
                      ? `${detail?.characterName || 'TA'} 想得有点久，再等一下下～`
                      : '网络有点慢，马上就好！'}
              </span>
              {elapsed >= 5 && <span className="elapsed">{elapsed}s</span>}
            </span>
          </div>
        )}

        {error && <div className="err">{error}</div>}
        <div ref={endRef} />
      </div>

      {/* 即时表扬气泡 */}
      {praise && (
        <div className={`praise ${praise.light ? 'light' : ''}`}>
          <span className="praise-emoji">{praise.light ? '👍' : '🎉'}</span>
          <div className="praise-body">
            <strong>{praise.text}</strong>
            <span>{praise.light ? praise.mission.label : `完成：${praise.mission.label}`}</span>
          </div>
        </div>
      )}

      {/* 当前任务提示 + 快捷回答 */}
      <div className="dock">
        {currentMission && (
          <div className="nowgoal">
            <span className="ng-label">现在要做</span>
            <span className="ng-text">
              {currentMission.icon_image ? (
                <img className="ng-icon" src={currentMission.icon_image} alt="" />
              ) : (
                currentMission.icon
              )}{' '}
              {currentMission.label}
            </span>
          </div>
        )}

        <div className="quick">
          {['Yes!', 'No...', "I don't know", 'Help me!'].map((q) => (
            <button key={q} className="qchip" onClick={() => send(q)} disabled={loading}>
              {q}
            </button>
          ))}
        </div>

        <div className="bar">
          <input
            className="inp"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="用英语说点什么…"
            disabled={loading}
            autoFocus
          />
          <button className="send" onClick={() => send()} disabled={loading || !input.trim()}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
