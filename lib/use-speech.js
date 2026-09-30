'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * ============================================================
 * 语音播放 hook
 * ============================================================
 *
 * 设计要点
 * --------
 * 1. **失败静默降级** —— 语音坏掉绝不能影响闯关。任何合成/播放失败
 *    都只是「这次没声音」，界面照常显示文字，不弹错误、不阻塞。
 *
 * 2. **同一时刻只播一条** —— 孩子连点重听时，先停掉上一条再播新的。
 *    否则多条音频叠在一起，完全听不清。
 *
 * 3. **预取下一句**（可选）—— 合成要 3-5 秒。若等到文本出现才开始合成，
 *    孩子要干等。这里在文本确定后立刻发起，并缓存 blob URL，
 *    点「重听」时是瞬时的。
 *
 * 4. **静音开关持久化** —— 存 localStorage。孩子自己关掉声音后，
 *    下次打开不该又突然响起来（会被吓到，也会影响家长）。
 */

const LS_MUTED = 'ienglish.tts.muted';

/** 合成结果的进程内缓存：key 是文本+音色，值取自 /api/tts（浏览器也会命中 HTTP 缓存） */
const audioCache = new Map();

/** "-12%" / "0.9" → SpeechSynthesis 的 rate（合法区间 0.1–10） */
function toSpeechRate(rate) {
  if (rate == null) return 1;
  const s = String(rate).trim();
  if (s.endsWith('%')) {
    const n = Number(s.slice(0, -1));
    if (Number.isFinite(n)) return Math.min(10, Math.max(0.1, 1 + n / 100));
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.min(10, Math.max(0.1, n)) : 1;
}

/**
 * ★ 浏览器内置语音兜底（第二道防线）
 *
 * 服务端合成不可用时启用，典型场景：
 *   - 云端函数运行时无内置 WebSocket（Node < 21）
 *   - 云端出站 WebSocket 被平台限制
 *   - edge-tts 端点失效
 *
 * 代价：音色取自用户设备，**与场景绑定的角色音色不一致**，角色区分度会丢失。
 * 但这属于可接受的降级 —— 「有声音但音色不对」远好于「完全没声音」。
 * 本地已实测 edge-tts 可用，这条路径正常情况下不会被触发。
 *
 * @returns {SpeechSynthesisUtterance|null} null 表示浏览器不支持
 */
function browserSpeak(text, rate) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = toSpeechRate(rate);
    // 中文系统上不指定音色会用中文音色念英文，挑一个英文音色
    const voices = window.speechSynthesis.getVoices() || [];
    const en = voices.find((v) => /^en([-_]|$)/i.test(v.lang));
    if (en) u.voice = en;
    return u;
  } catch {
    return null;
  }
}

export function useSpeech({ voice, rate, pitch, scenarioSlug } = {}) {
  const [muted, setMuted] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  /** 正在合成中的文本（用于显示「准备语音…」） */
  const [preparing, setPreparing] = useState(false);
  const [supported, setSupported] = useState(true);

  const audioRef = useRef(null);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  // 读取静音开关
  useEffect(() => {
    try {
      setMuted(localStorage.getItem(LS_MUTED) === '1');
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 卸载时停掉正在播的音频，避免切页面后还在响
      try {
        audioRef.current?.pause();
      } catch {
        /* 忽略 */
      }
      abortRef.current?.abort();
      try {
        if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
      } catch {
        /* 忽略 */
      }
    };
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem(LS_MUTED, next ? '1' : '0');
      } catch {
        /* 忽略 */
      }
      if (next) {
        // 立即静音：停掉当前播放（两条通道都要停）
        try {
          audioRef.current?.pause();
        } catch {
          /* 忽略 */
        }
        abortRef.current?.abort();
        try {
          if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
        } catch {
          /* 忽略 */
        }
        setSpeakingId(null);
        setPreparing(false);
      }
      return next;
    });
  }, []);

  /** 拉取音频 blob（带进程内缓存） */
  const fetchAudio = useCallback(
    async (text, signal) => {
      const key = `${voice || ''}|${rate || ''}|${text}`;
      const hit = audioCache.get(key);
      if (hit) return hit;

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, rate, pitch, scenarioSlug }),
        signal,
      });

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg = (await res.json())?.error || msg;
        } catch {
          /* 保持默认 */
        }
        throw new Error(msg);
      }

      const contentType = res.headers.get('Content-Type') || '';
      if (!contentType.includes('audio')) {
        // 防御：上游异常可能返回 JSON/HTML，不能拿去当音频播
        throw new Error('返回内容不是音频');
      }

      const blob = await res.blob();
      if (blob.size < 512) throw new Error('音频数据过小');

      const url = URL.createObjectURL(blob);
      audioCache.set(key, url);

      // 缓存上限，避免长时间会话积累过多 blob URL 占内存
      if (audioCache.size > 40) {
        const oldest = audioCache.keys().next().value;
        try {
          URL.revokeObjectURL(audioCache.get(oldest));
        } catch {
          /* 忽略 */
        }
        audioCache.delete(oldest);
      }

      return url;
    },
    [voice, rate, pitch, scenarioSlug]
  );

  /**
   * 朗读一段文本。
   * @param {string} text 要读的英文
   * @param {string} id   播放标识（通常是气泡的 key），用于高亮「正在读这条」
   * @param {{force?:boolean}} opts force=true 时忽略静音开关（用于用户主动点重听）
   */
  const speak = useCallback(
    async (text, id, opts = {}) => {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (muted && !opts.force) return;
      if (typeof window === 'undefined') return;

      // 停掉上一条
      try {
        audioRef.current?.pause();
      } catch {
        /* 忽略 */
      }
      abortRef.current?.abort();

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setSpeakingId(id);
      setPreparing(true);

      try {
        const url = await fetchAudio(clean, ctrl.signal);
        if (!mountedRef.current || ctrl.signal.aborted) return;

        const audio = new Audio(url);
        audioRef.current = audio;

        audio.onended = () => {
          if (!mountedRef.current) return;
          setSpeakingId(null);
          setPreparing(false);
        };
        audio.onerror = () => {
          if (!mountedRef.current) return;
          // 播放失败（浏览器策略 / 解码问题）—— 静默收场
          setSpeakingId(null);
          setPreparing(false);
        };

        setPreparing(false);
        await audio.play();
      } catch (e) {
        if (ctrl.signal.aborted || !mountedRef.current) return;

        // ---- 第二道防线：浏览器内置语音 ----
        // 服务端合成不可用（云端无 WebSocket / 端点失效）时回退，
        // 保证「至少有声音」。音色与角色音色不一致，属已知代价。
        const fallback = browserSpeak(clean, rate);
        if (fallback) {
          console.warn(
            '[tts] 服务端合成不可用，已回退浏览器内置语音（音色可能与角色不符）:',
            e.message
          );
          const clear = () => {
            if (mountedRef.current) {
              setSpeakingId(null);
              setPreparing(false);
            }
          };
          fallback.onend = clear;
          fallback.onerror = clear;
          setPreparing(false);
          try {
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(fallback);
            return;
          } catch {
            clear();
            return;
          }
        }

        // ---- 两道防线都不可用：静默收场，只留日志 ----
        console.warn('[tts] 朗读失败（已静默降级）:', e.message);
        setSpeakingId(null);
        setPreparing(false);
      }
    },
    [muted, fetchAudio, rate]
  );

  /** 停止播放（含浏览器内置语音兜底的通道） */
  const stop = useCallback(() => {
    try {
      audioRef.current?.pause();
    } catch {
      /* 忽略 */
    }
    abortRef.current?.abort();
    try {
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    } catch {
      /* 忽略 */
    }
    setSpeakingId(null);
    setPreparing(false);
  }, []);

  /**
   * 预取：文本已知时提前合成，但不播。
   * 用于 AI 回复落地后立刻预热，孩子点重听时零等待。
   */
  const prefetch = useCallback(
    (text) => {
      const clean = String(text || '').trim();
      if (!clean) return;
      fetchAudio(clean).catch(() => {
        /* 预取失败无所谓，真正要播时会重试 */
      });
    },
    [fetchAudio]
  );

  return { speak, stop, prefetch, muted, toggleMuted, speakingId, preparing, supported };
}
