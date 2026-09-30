import crypto from 'node:crypto';

/**
 * ============================================================
 * TTS 合成层 —— 零依赖，基于 Node 内置 WebSocket
 * ============================================================
 *
 * 为什么用 Node 内置 WebSocket（undici 实现）而不是自己搓握手：
 *   本机实测过「手工 TLS + WebSocket 握手」的方案，HTTP 层逐头对照
 *   aiohttp 完全一致，但服务端始终**一个帧都不回**就关闭连接。
 *   Node 内置的 WebSocket 一次即通 —— 说明差异在 TLS 层细节
 *   （ALPN / 扩展顺序 / 记录分片），肉眼无法对齐。
 *   结论：不要重造 WebSocket，用标准实现。
 *
 * 为什么不用 npm 包（ws / edge-tts-js）：
 *   1) 本机 Node 无法派生任何子进程（EBUSY），不能用「调 Python CLI」的方案，
 *      那条路在 Vercel 上也不通。
 *   2) Node ≥ 21 已内置 WebSocket，功能足够，加依赖只会拖慢冷启动。
 *
 * 协议要点（逆向自 Edge 浏览器的「朗读」功能，2026-09 实测）：
 *   - 端点 wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 *   - 必须带 trustedClientToken（浏览器端公开常量，非密钥）
 *   - 必须带 Sec-MS-GEC / Sec-MS-GEC-Version 反滥用令牌，否则 403
 *   - Origin 必须是 Edge 朗读扩展的固定 ID，随机值会被拒
 *
 * ⚠️ 合规与稳定性：这是 Edge 浏览器的**内部未公开接口**，无 SLA 保障，
 *    微软可随时调整。适合作为零成本起点，生产环境应准备降级路径
 *    （见 docs/语音实现.md「降级策略」）。
 */

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/**
 * 必须跟随 Edge 当前发布版本。服务端校验 Sec-MS-GEC-Version，
 * 版本过旧会被判 403 —— 实测 130.x 已失效，143.x 可用。
 * 升级方式：跟随 edge-tts 上游的 CHROMIUM_FULL_VERSION 常量。
 */
const CHROMIUM_FULL_VERSION = '143.0.3650.75';

const WSS_HOST = 'speech.platform.bing.com';
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';

/**
 * Origin 必须是 Edge「朗读」扩展的固定 ID。
 * 服务端对 Origin 做白名单校验，随机 UUID 会被 403 拒绝。
 */
const EDGE_EXTENSION_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';

const WS_HEADERS = {
  Origin: EDGE_EXTENSION_ORIGIN,
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
    ` (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Windows FILETIME 纪元与 Unix 纪元的差值（秒） */
const WIN_EPOCH_OFFSET = 11644473600;
/** 令牌有效窗口（秒）—— 取整到 5 分钟，保证同一窗口内令牌稳定 */
const TOKEN_WINDOW_SEC = 300;

/**
 * 生成 Sec-MS-GEC 令牌。
 *
 * 算法：当前 UTC 秒 → 加 Windows 纪元偏移 → 向 5 分钟窗口取整
 *      → ×1e7 转成 100ns 单位 → 拼 trustedClientToken → SHA-256 → 大写十六进制。
 * 服务端用同一算法校验，必须逐位对齐。
 *
 * ⚠️ 注意保持浮点运算顺序与上游一致（先取整再乘），
 *    自行「优化」成 BigInt 会导致令牌不匹配 → 403。
 */
export function generateSecMsGec(nowMs = Date.now()) {
  let ticks = Math.floor(nowMs / 1000) + WIN_EPOCH_OFFSET;
  ticks -= ticks % TOKEN_WINDOW_SEC;
  ticks = Math.floor(ticks * 1e7);
  return crypto
    .createHash('sha256')
    .update(`${ticks}${TRUSTED_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

// ------------------------------------------------------------
// SSML 构建
// ------------------------------------------------------------

/** 转义 SSML 特殊字符 —— 不转义会让含 & < > 的文本合成失败 */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 规范化语速：接受 0.85 / "-15%" / "+10%" 三种写法 → "-15%" */
function normalizeRate(rate) {
  if (rate == null || rate === '') return '+0%';
  if (typeof rate === 'string' && rate.trim().endsWith('%')) {
    const v = rate.trim();
    return v.startsWith('+') || v.startsWith('-') ? v : `+${v}`;
  }
  const num = Number(rate);
  if (!Number.isFinite(num)) return '+0%';
  const pct = Math.round((num - 1) * 100); // 1.0 = 原速
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** 规范化音调（Hz） */
function normalizePitch(pitch) {
  if (pitch == null || pitch === '') return '+0Hz';
  if (typeof pitch === 'string' && pitch.trim().endsWith('Hz')) {
    const v = pitch.trim();
    return v.startsWith('+') || v.startsWith('-') ? v : `+${v}`;
  }
  const num = Number(pitch);
  if (!Number.isFinite(num)) return '+0Hz';
  return `${num >= 0 ? '+' : ''}${num}Hz`;
}

/** 规范化音量（%）。服务端正则 `^[+-]\d+%$` —— 必须带正负号。 */
function normalizeVolume(volume) {
  if (volume == null || volume === '') return '+0%';
  if (typeof volume === 'string' && volume.trim().endsWith('%')) {
    const v = volume.trim();
    return v.startsWith('+') || v.startsWith('-') ? v : `+${v}`;
  }
  const num = Number(volume);
  if (!Number.isFinite(num)) return '+0%';
  const pct = Math.round(num <= 1 ? num * 100 : num);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/**
 * JavaScript 风格时间戳。
 *
 * ⚠️ 不能用 toISOString()。服务端要的是 `Date.prototype.toString()` 的格式，
 *    且 SSML 那条消息还要**额外**在末尾补一个 'Z'
 *    （edge-tts 上游注释：「This is not a mistake, Microsoft Edge bug.」）。
 *    用 ISO 8601 时表现为握手成功、SSML 已发，但服务端一个帧都不回。
 */
function jsDateString(date = new Date()) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${p(date.getUTCDate())} ` +
    `${date.getUTCFullYear()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:` +
    `${p(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

/**
 * 把短音色名转成服务端要求的完整 voice 名。
 *
 * ⚠️ SSML 里的 voice name **不能**写 `en-US-AndrewNeural`，
 *    必须是 .NET 风格全称：
 *      `Microsoft Server Speech Text to Speech Voice (en-US, AndrewNeural)`
 *    写短名会被直接拒绝（握手 101 成功、一个帧都不回就关闭）。
 */
export function toFullVoiceName(shortName) {
  const m = /^([a-z]{2}-[A-Z]{2})-(.+)Neural$/.exec(String(shortName || ''));
  if (!m) return shortName;
  return `Microsoft Server Speech Text to Speech Voice (${m[1]}, ${m[2]}Neural)`;
}

/**
 * 构建 SSML。与服务端严格对齐的几处细节：
 *   1) 属性用**单引号**，**不带** mstts 命名空间 —— 与 Edge 实际发送的形式一致。
 *   2) `<prosody>` 的 volume 属性**必须存在**，值形如 `+0%`。
 *   3) voice name 必须是完整全称（见 toFullVoiceName）。
 *   4) **不要**加 `<mstts:webvtt/>` 空标签 —— 非法。
 */
function buildSsml(text, { voice, rate, pitch, volume, style }) {
  const esc = escapeXml(text).replace(/"/g, "'");
  const inner =
    style && style !== 'default'
      ? `<mstts:express-as style="${escapeXml(style)}">${esc}</mstts:express-as>`
      : esc;

  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${toFullVoiceName(voice)}'>` +
    `<prosody pitch='${normalizePitch(pitch)}' rate='${normalizeRate(rate)}' volume='${normalizeVolume(volume)}'>` +
    inner +
    '</prosody></voice></speak>'
  );
}

// ------------------------------------------------------------
// 合成
// ------------------------------------------------------------

/** 单次合成的文本上限 —— 过长会被服务端拒绝，孩子一次也听不完 */
const MAX_TEXT_LEN = 3000;

/**
 * 合成一段文字为 MP3。
 *
 * @returns {Promise<{audio: Buffer, mime: string, voice: string, ms: number}>}
 */
export function synthesize(text, options = {}) {
  const {
    voice = 'en-US-AriaNeural',
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    style = 'default',
    timeoutMs = 45000,
  } = options;

  const clean = String(text || '').trim();
  if (!clean) return Promise.reject(new Error('TTS 文本为空'));
  if (clean.length > MAX_TEXT_LEN) {
    return Promise.reject(new Error(`TTS 文本过长（${clean.length} 字符，上限 ${MAX_TEXT_LEN}）`));
  }

  // 显式前置检查：Node < 21 没有内置 WebSocket。
  // 不加这层的话，Vercel 上会抛 "WebSocket is not defined"，
  // 被上层 catch 成含糊的「合成失败」，排查时看不出是运行时版本问题。
  if (typeof WebSocket !== 'function') {
    return Promise.reject(
      new Error(`当前 Node 运行时无内置 WebSocket（${process.version}，需 ≥ 21）`)
    );
  }

  const started = Date.now();
  const requestId = crypto.randomUUID().replace(/-/g, '');

  const url =
    `wss://${WSS_HOST}${WSS_PATH}?TrustedClientToken=${TRUSTED_TOKEN}` +
    `&Sec-MS-GEC=${generateSecMsGec()}` +
    `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    let guard;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
      if (err) reject(err);
      else resolve(value);
    };

    try {
      ws = new WebSocket(url, { headers: WS_HEADERS });
    } catch (e) {
      reject(new Error(`TTS 初始化失败: ${e.message}`));
      return;
    }

    ws.binaryType = 'arraybuffer';
    const chunks = [];

    guard = setTimeout(() => done(new Error('TTS 合成超时（45 秒）')), timeoutMs);

    ws.onopen = () => {
      const timestamp = jsDateString();
      const speechConfig = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            },
          },
        },
      });

      ws.send(
        `X-Timestamp:${timestamp}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          speechConfig
      );

      const ssml = buildSsml(clean, { voice, rate, pitch, volume, style });
      ws.send(
        `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          // 这条消息的 X-Timestamp 末尾要额外补 'Z'（Edge 服务端怪癖，非笔误）
          `X-Timestamp:${timestamp}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml
      );
    };

    ws.onmessage = (ev) => {
      // ---- 文本帧：控制消息，形如
      //      X-RequestId:...\r\nContent-Type:application/json\r\nPath:turn.start\r\n\r\n{...}
      if (typeof ev.data === 'string') {
        const path = /Path:([^\r\n]+)/.exec(ev.data)?.[1];
        if (path === 'turn.end') {
          if (!chunks.length) {
            done(new Error('TTS 返回空音频'));
            return;
          }
          done(null, {
            audio: Buffer.concat(chunks),
            mime: 'audio/mpeg',
            voice,
            ms: Date.now() - started,
          });
        }
        // turn.start / response / audio.metadata 无需处理
        return;
      }

      // ---- 二进制帧：音频，结构是
      //      [2 字节大端 headerLen][header 文本][MP3 数据]
      //      头部形如：
      //        X-RequestId:...\r\nContent-Type:audio/mpeg\r\n
      //        X-StreamId:...\r\nPath:audio\r\n
      //
      // ⚠️ 早期错误地直接把前 2 字节当长度前缀切掉、其余全收，
      //    结果把 header 文本也塞进了 MP3，产出以 "X-RequestId:" 开头的伪音频。
      //    必须按 headerLen 精确定位音频起点。
      const buf = Buffer.from(ev.data);
      if (buf.length < 2) return;
      const headerLen = buf.readUInt16BE(0);
      const audioStart = 2 + headerLen;
      if (buf.length <= audioStart) return; // 只有头部、无音频体的帧
      chunks.push(buf.subarray(audioStart));
    };

    ws.onerror = (e) => {
      const raw = e?.message || e?.error?.message || '未知错误';
      // 代理干扰是最常见的坑，给出可操作的提示
      const msg = /hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(raw)
        ? `TTS 连接失败（${raw}）。若本机设了 http_proxy，请确认已对本服务的出站请求关闭代理。`
        : `TTS 失败: ${raw}`;
      done(new Error(msg));
    };

    ws.onclose = (e) => {
      if (settled) return;
      const code = e?.code ? ` code=${e.code}` : '';
      const reason = e?.reason ? ` reason=${e.reason}` : '';
      done(new Error(`TTS 连接提前关闭，未收到完整音频${code}${reason}`));
    };
  });
}

/** 供配置页「试听」与验收脚本使用：列出英文音色 */
export async function listEnglishVoices() {
  const res = await fetch(
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_TOKEN}`,
    {
      headers: {
        'User-Agent': WS_HEADERS['User-Agent'],
        'Accept-Language': WS_HEADERS['Accept-Language'],
      },
    }
  );
  if (!res.ok) throw new Error(`获取音色列表失败: HTTP ${res.status}`);
  const all = await res.json();
  return all
    .filter((v) => String(v.Locale || '').startsWith('en-'))
    .map((v) => ({
      name: v.ShortName,
      gender: v.Gender,
      locale: v.Locale,
      tags: v.VoiceTag?.VoicePersonalities || [],
    }));
}

/** 校验一段 Buffer 是否像 MP3（ID3 标签或帧同步头） */
export function looksLikeMp3(buf) {
  if (!buf || buf.length < 3) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // 'ID3'
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0; // 帧同步
}
