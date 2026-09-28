/**
 * 小智协议 WebSocket 服务端（Vercel Route Handler）
 * 文件位置：app/api/xiaozhi/route.js
 *
 * ⚠️ 关键约束
 *   - 必须用 Node.js runtime（edge 不支持 WebSocket）
 *   - Vercel 连接最大时长：Hobby 300s / Pro 800s
 *   - 周期性断连是预期行为，固件自带退避重连
 *
 * 协议要点
 *   - 单 WebSocket 连接双工
 *   - 二进制帧 = Opus 音频，文本帧 = JSON 控制消息
 *   - 上行 16000Hz mono 60ms；下行 24000Hz mono 60ms
 *   - 服务器必须在 10 秒内回复 hello，且 hello 必须含 transport:"websocket"
 */

export const runtime = 'nodejs';
export const maxDuration = 300; // Hobby 上限；Pro 可调至 800

import { randomUUID } from 'node:crypto';
import {
  loadScenario,
  buildMessages,
  streamLLM,
  createSession,
  saveTurn,
  endSession,
  trackVocab,
} from '@/lib/dialogue';

// 注意：Next.js Route Handler 的 WebSocket 支持需 Next.js 15+ 与平台支持
// 若你的环境不支持，改用独立 WebSocket 服务（见架构文档 §6）

export async function GET(req) {
  const upgrade = req.headers.get('upgrade');
  if (upgrade?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // ---------- 鉴权：读设备请求头 ----------
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const deviceId = req.headers.get('device-id');
  const clientId = req.headers.get('client-id');
  const protocolVersion = req.headers.get('protocol-version') || '1';

  if (!token || !deviceId) {
    return new Response('Unauthorized', { status: 401 });
  }
  // TODO: 校验 token 与 devices.token_hash

  const { socket, response } = (await import('@vercel/functions')).experimental_upgradeWebSocket(req);

  // ---------- 会话状态 ----------
  let sessionId = null;
  let scenario = null;
  let history = [];          // [{role:'child'|'ai', text}]
  let seq = 0;
  let audioChunks = [];      // 上行 Opus 帧累积
  let state = 'idle';        // idle | listening | speaking
  let childId = 'child-001'; // TODO: 由 deviceId 查 devices 表得到
  let sessionStartedAt = Date.now();

  socket.on('message', async (event) => {
    try {
      // 二进制帧 → Opus 音频
      if (typeof event.data !== 'string') {
        if (state === 'listening') {
          audioChunks.push(Buffer.from(event.data));
        }
        return;
      }

      const msg = JSON.parse(event.data);

      switch (msg.type) {
        // ---------- 握手 ----------
        case 'hello': {
          if (!msg.transport || msg.transport !== 'websocket') {
            console.warn('设备 hello 缺少 transport');
          }
          sessionId = randomUUID();
          state = 'idle';

          socket.send(JSON.stringify({
            type: 'hello',
            transport: 'websocket',        // ⚠️ 必须，否则设备认为音频通道未开
            session_id: sessionId,
            audio_params: {
              format: 'opus',
              sample_rate: 24000,          // 下行为 24k
              channels: 1,
              frame_duration: 60,
            },
          }));
          break;
        }

        // ---------- 开始说话 ----------
        case 'listen': {
          if (msg.state === 'start') {
            state = 'listening';
            audioChunks = [];

            // 首次进入会话：加载场景 + 建 session 记录
            if (!scenario) {
              scenario = await loadScenario(process.env.DEFAULT_SCENARIO || 'airport-checkin');
              await createSession(childId, scenario.id);
              history = [];

              // 播开场白
              await speak(scenario.openingLine);
              history.push({ role: 'ai', text: scenario.openingLine });
            }
          } else if (msg.state === 'stop') {
            state = 'idle';
            // 音频结束 → 走完整对话回合
            await handleTurn();
          }
          break;
        }

        // ---------- 打断（孩子插话）----------
        case 'abort': {
          state = 'idle';
          audioChunks = [];
          break;
        }

        default:
          // 忽略未知类型
          break;
      }
    } catch (err) {
      console.error('[xiaozhi] message handler error:', err);
    }
  });

  socket.on('close', async () => {
    if (sessionId) {
      const dur = Math.round((Date.now() - sessionStartedAt) / 1000);
      await endSession(sessionId, history.length > 6, dur);
    }
  });

  // ============================================================
  // 一轮完整对话：ASR → LLM → TTS
  // ============================================================
  async function handleTurn() {
    if (!audioChunks.length) return;

    // ① ASR：上行 Opus → 文本
    const childText = await transcribe(Buffer.concat(audioChunks));
    audioChunks = [];
    if (!childText?.trim()) return;

    history.push({ role: 'child', text: childText });
    await saveTurn(sessionId, seq++, 'child', childText);
    socket.send(JSON.stringify({ type: 'stt', session_id: sessionId, text: childText }));

    // ② LLM：注入场景提示词 + 历史
    const messages = buildMessages(scenario, history, { nickname: '宝贝', cefrLevel: 'A1' });
    let reply = '';
    for await (const delta of streamLLM(messages)) {
      reply += delta;
    }
    if (!reply.trim()) return;

    history.push({ role: 'ai', text: reply });
    await saveTurn(sessionId, seq++, 'ai', reply);

    // ③ TTS：文本 → 下行 Opus
    await speak(reply);

    // ④ 生词累积
    await trackVocab(childId, scenario.vocabList, childText);
  }

  // ============================================================
  // 播放 AI 回复
  // ⚠️ 必须先发 tts{state:start}，否则音频帧会被设备丢弃
  // ============================================================
  async function speak(text) {
    state = 'speaking';
    socket.send(JSON.stringify({
      type: 'tts', session_id: sessionId, state: 'start', text,
    }));

    const opusFrames = await synthesize(text);  // 返回 24kHz Opus 帧数组
    for (const frame of opusFrames) {
      socket.send(frame);
    }

    socket.send(JSON.stringify({
      type: 'tts', session_id: sessionId, state: 'stop',
    }));
    state = 'idle';
  }

  return response;
}

// ============================================================
// 外部服务占位（按你选定的服务商实现）
// ============================================================

async function transcribe(opusBuffer) {
  // TODO: Opus 解码 → 16kHz PCM → 调 ASR API
  // 推荐国内服务商（中文语境 + 童声优化）：
  //   火山引擎 / 阿里云 / 讯飞
  const res = await fetch(`${process.env.ASR_BASE_URL}/recognize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/ogg',
      Authorization: `Bearer ${process.env.ASR_API_KEY}`,
    },
    body: opusBuffer,
  });
  const data = await res.json();
  return data.text || '';
}

async function synthesize(text) {
  // TODO: 调 TTS API → 得 24kHz PCM → Opus 编码
  // 建议选带童声友好音色的服务商
  const res = await fetch(`${process.env.TTS_BASE_URL}/synthesize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TTS_API_KEY}`,
    },
    body: JSON.stringify({ text, voice: process.env.TTS_VOICE, format: 'opus', sample_rate: 24000 }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return [buf]; // 简化：实际需按 60ms 切帧
}
