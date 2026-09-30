import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { synthesize } from './tts';

/**
 * ============================================================
 * TTS 缓存层 —— 内容寻址 + 磁盘落地
 * ============================================================
 *
 * 为什么要缓存（这不是优化，是功能可用的前提）：
 *   1) 孩子会反复点「🔊 重听同一句话」。同一段文本第二次合成纯属浪费，且要多等 3-5 秒。
 *   2) 场景的**开场白**和**表扬词**是固定的几十条，全量预热后基本零延迟。
 *   3) 上游是未公开接口，有软性限流。降低请求量 = 降低被限的风险。
 *
 * 缓存键：sha256(voice | rate | pitch | volume | style | text)
 *   —— 任何一个参数变化都会产出不同音频，必须全部纳入键。
 *
 * 存储位置：.tts-cache/<前两位>/<完整哈希>.mp3
 *   分两级目录，避免单目录堆几万个文件导致文件系统变慢。
 *
 * ⚠️ Vercel 部署注意：
 *   Serverless 文件系统除 /tmp 外只读，且 /tmp 不跨实例、不持久。
 *   因此这里的磁盘缓存**只在本地与自托管环境生效**；
 *   Vercel 上会自动降级为「内存缓存 + 直接合成」。
 *   这是刻意的设计 —— 代码不做分支判断，靠写入失败静默降级。
 */

const CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(process.cwd(), '.tts-cache');

/** 进程内缓存：直接存 Buffer，命中时零 IO。用于 Vercel 等无持久磁盘的环境。 */
const memory = new Map();
const MEMORY_LIMIT = 60; // 条数上限，防止内存无界增长

/** 同文本并发去重：避免孩子连点、或一次请求触发多路重复合成 */
const inflight = new Map();

export function cacheKey(text, opts = {}) {
  const {
    voice = 'default',
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    style = 'default',
  } = opts;
  return crypto
    .createHash('sha256')
    .update([voice, rate, pitch, volume, style, text].join('\u0000'))
    .digest('hex');
}

function cachePath(key) {
  return path.join(CACHE_DIR, key.slice(0, 2), `${key}.mp3`);
}

function readFromDisk(key) {
  try {
    const p = cachePath(key);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  } catch {
    return null; // 读失败就当未命中，不影响主流程
  }
}

function writeToDisk(key, buf) {
  try {
    const p = cachePath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    return true;
  } catch {
    // 只读文件系统（Vercel）→ 静默失败，靠内存缓存兜
    return false;
  }
}

function putMemory(key, buf) {
  if (memory.has(key)) memory.delete(key); // 重新插入以更新 LRU 顺序
  memory.set(key, buf);
  while (memory.size > MEMORY_LIMIT) {
    memory.delete(memory.keys().next().value);
  }
}

/**
 * 取音频：命中缓存直接返回，未命中则合成并写回。
 *
 * @returns {Promise<{audio: Buffer, mime: string, cache: 'memory'|'disk'|'miss', ms: number}>}
 */
export async function getSpeech(text, options = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('TTS 文本为空');

  const key = cacheKey(clean, options);

  // 1) 内存
  const mem = memory.get(key);
  if (mem) {
    memory.delete(key);
    memory.set(key, mem); // LRU 提升
    return { audio: mem, mime: 'audio/mpeg', cache: 'memory', ms: 0 };
  }

  // 2) 磁盘
  const disk = readFromDisk(key);
  if (disk && disk.length > 0) {
    putMemory(key, disk);
    return { audio: disk, mime: 'audio/mpeg', cache: 'disk', ms: 0 };
  }

  // 3) 并发去重
  if (inflight.has(key)) {
    const audio = await inflight.get(key);
    return { audio, mime: 'audio/mpeg', cache: 'memory', ms: 0 };
  }

  // 4) 合成
  const task = (async () => {
    const r = await synthesize(clean, options);
    putMemory(key, r.audio);
    writeToDisk(key, r.audio);
    return r.audio;
  })();

  inflight.set(key, task);
  try {
    const audio = await task;
    return { audio, mime: 'audio/mpeg', cache: 'miss', ms: 0 };
  } finally {
    inflight.delete(key);
  }
}

/**
 * 预热：批量合成固定文案（开场白、表扬词等）。
 * 失败不抛出 —— 预热是尽力而为，不应阻塞启动。
 *
 * @returns {Promise<{ok:number, fail:number, skipped:number}>}
 */
export async function prewarm(items, options = {}) {
  const stat = { ok: 0, fail: 0, skipped: 0 };

  for (const it of items) {
    const text = typeof it === 'string' ? it : it?.text;
    const opts = typeof it === 'string' ? options : { ...options, ...(it?.options || {}) };
    const clean = String(text || '').trim();
    if (!clean) {
      stat.skipped++;
      continue;
    }
    const key = cacheKey(clean, opts);
    if (memory.has(key) || readFromDisk(key)) {
      stat.skipped++;
      continue;
    }
    try {
      const r = await synthesize(clean, opts);
      putMemory(key, r.audio);
      writeToDisk(key, r.audio);
      stat.ok++;
    } catch {
      stat.fail++;
    }
  }

  return stat;
}

/** 缓存统计（供管理页/验收脚本查看） */
export function cacheStats() {
  let diskFiles = 0;
  let diskBytes = 0;
  try {
    if (fs.existsSync(CACHE_DIR)) {
      for (const d of fs.readdirSync(CACHE_DIR)) {
        const sub = path.join(CACHE_DIR, d);
        if (!fs.statSync(sub).isDirectory()) continue;
        for (const f of fs.readdirSync(sub)) {
          if (!f.endsWith('.mp3')) continue;
          diskFiles++;
          diskBytes += fs.statSync(path.join(sub, f)).size;
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  return {
    dir: CACHE_DIR,
    memoryEntries: memory.size,
    diskFiles,
    diskBytes,
    diskMB: Number((diskBytes / 1024 / 1024).toFixed(2)),
  };
}
