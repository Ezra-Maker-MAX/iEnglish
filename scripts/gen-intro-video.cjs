// 生成机场场景开场短视频
//
// 用法：
//   1. API Key 写到 C:/Users/lenovo/AppData/Local/Temp/agnes_key.txt
//   2. unset http_proxy https_proxy ALL_PROXY    # 本机代理会拦外网
//   3. node scripts/gen-intro-video.cjs
//   4. 成功后在 Turso 里把 intro_video 指向 /intro-airport.mp4（通常已预置）
//
// ★ 为什么单独拆一个脚本、且默认长跑重试：
//   免费档视频模型 RPM = 2（实际可执行仅 1），队列常年满。
//   实测连续 16 分钟、22 次尝试全部返回 503 video_queue_full。
//   因此用「低频长跑」策略而非一次性调用 —— 建议放到夜间或其他低峰时段跑。
//
// ★ 参数形状是实测撞出来的，不要凭文档猜（文档与官方 catalog 都有出入）：
//   - mode 必填，合法值只有 text / keyframe / reference
//     （text2video / txt2video / text_to_video 全部报 400 invalid mode）
//   - seconds 必须是字符串，范围 "4"–"12"；duration 不是合法字段
//   - Flash 版 size 只能是 "720P"，其他值 400；分辨率靠 aspect_ratio 控制
//   - 轮询用 video_id（不是 task_id），且必须带 model_name
const fs = require('fs');
const path = require('path');

const KEY_FILE = 'C:/Users/lenovo/AppData/Local/Temp/agnes_key.txt';
const BASE = 'https://apihub.agnes-ai.com';
const MODEL = 'agnes-video-2.5-flash';
const OUT = path.join(
  __dirname,
  '..',
  'public',
  'intro-airport.mp4'
);

// 可调：MAX_TRIES × RETRY_MS ≈ 最长等待时间。默认约 1 小时。
const MAX_TRIES = 80;
const RETRY_MS = 45000;
const POLL_MS = 3000;
const POLL_MAX = 100;

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

// 与角色立绘保持同一画风 —— 视频里的人物要和静态立绘看起来是同一个人
const PROMPT =
  'A cheerful young airport ground crew worker in a bright orange safety vest and red cap, ' +
  'standing in an airport terminal, waves hello warmly and smiles at the camera, ' +
  'flat vector cartoon illustration style for a children app, thick clean dark outlines, ' +
  'soft pastel palette, simple rounded shapes, bright clean light background, ' +
  'gentle camera push-in, no text, no letters';

const BODY = {
  model: MODEL,
  prompt: PROMPT,
  seconds: '4',
  mode: 'text',
  size: '720P',
  aspect_ratio: '1:1', // 方形：手机端角色出场用
};

async function createTask(key) {
  for (let i = 1; i <= MAX_TRIES; i++) {
    let res, body;
    try {
      res = await fetch(`${BASE}/v1/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(BODY),
      });
      body = await res.text();
    } catch (e) {
      console.log(`[${i}] 网络异常: ${e.message}`);
      await sleep(RETRY_MS);
      continue;
    }

    if (res.ok) {
      const j = JSON.parse(body);
      console.log(`[${i}] ✓ 创建成功 video_id=${j.video_id}`);
      return j.video_id || null;
    }

    const why = body.includes('video_queue_full')
      ? '队列满'
      : body.includes('rate limit')
        ? '限流'
        : `HTTP ${res.status}`;
    console.log(`[${i}] ${why}`);

    if (!RETRYABLE.has(res.status)) {
      console.log(`  不可重试错误，退出: ${body.slice(0, 200)}`);
      return null;
    }
    await sleep(RETRY_MS);
  }
  return null;
}

async function pollAndDownload(key, vid) {
  console.log('开始轮询…');
  for (let i = 1; i <= POLL_MAX; i++) {
    await sleep(POLL_MS);
    const r = await fetch(
      `${BASE}/agnesapi?video_id=${encodeURIComponent(vid)}&model_name=${MODEL}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    const t = await r.text();
    let p;
    try {
      p = JSON.parse(t);
    } catch {
      p = {};
    }
    // 注意：internal_status / internal_progress 恒为 pending / 0，要看 status
    console.log(`  #${i} status=${p.status || '?'} progress=${p.progress ?? '-'}`);

    if (p.status === 'completed' && p.url) {
      const dl = await fetch(p.url);
      const buf = Buffer.from(await dl.arrayBuffer());
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      if (fs.existsSync(OUT)) {
        console.log(`目标文件已存在，改为写入 .new：${OUT}.new`);
        fs.writeFileSync(OUT + '.new', buf);
      } else {
        fs.writeFileSync(OUT, buf);
        console.log(`✓ 已保存 ${OUT} (${(buf.length / 1024).toFixed(0)} KB)`);
      }
      return true;
    }
    if (p.status === 'failed') {
      console.log('任务失败:', JSON.stringify(p).slice(0, 400));
      return false;
    }
  }
  console.log('轮询超时');
  return false;
}

(async () => {
  let key;
  try {
    key = fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    console.error(`读不到 API Key：${KEY_FILE}`);
    process.exit(1);
  }

  const vid = await createTask(key);
  if (!vid) {
    console.log('\n始终未拿到视频任务。免费档视频队列高峰期可能长时间满，建议低峰时段重跑。');
    process.exit(1);
  }
  const ok = await pollAndDownload(key, vid);
  process.exit(ok ? 0 : 1);
})();
