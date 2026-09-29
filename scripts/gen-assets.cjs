// 批量生成场景美术资源（角色形象 + 关卡图标）
//
// 按官方文档要求实现指数退避重试（408/429/500/502/503/504/520/522/524）
// 免费额度参考：图片 4000 张/天，1K 分辨率 RPM 20~30
//
// 已存在的文件跳过而非覆盖 —— 避免重复消耗额度，也便于人工挑选后替换
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const apiKey = fs.readFileSync('C:/Users/lenovo/AppData/Local/Temp/agnes_key.txt', 'utf8').trim();
const BASE = 'https://apihub.agnes-ai.com/v1';
const ROOT = 'C:/Users/lenovo/WorkBuddy AI/2026-09-28-19-56-42/ienglish/public';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);

// 统一美术风格前缀 —— 保证所有素材看起来像一套
const STYLE = `flat vector illustration for a children's app, thick clean dark outlines,
soft pastel palette, simple rounded shapes, cute and friendly, centered composition,
plain solid light background, no text, no letters, no watermark`;

/** 角色形象：每个场景的主角 */
const AVATARS = [
  {
    file: 'avatar-max.png',
    // Max 已有，不再重新生成（避免覆盖已确认的效果）
    skipIfExists: true,
    prompt: `A cheerful young man airport ground crew worker, wearing bright orange safety vest
over light blue shirt and a red cap, big warm smile, round friendly eyes, slightly goofy
expression, waving hello with one hand. Full body, square composition. ${STYLE}`,
  },
];

/** 关卡图标：替换 emoji，统一视觉语言 */
const ICONS = [
  { file: 'icon-boarding-pass.png', prompt: `A simple boarding pass ticket icon, rectangular with a torn stub corner, small airplane symbol printed on it, teal and white colors. Single object, square composition. ${STYLE}` },
  { file: 'icon-luggage.png', prompt: `A chubby rolling suitcase icon, orange colored with visible zipper and handle, small wheels at bottom. Single object, square composition. ${STYLE}` },
  { file: 'icon-security.png', prompt: `A friendly security checkpoint icon: a metal detector archway frame with a small green checkmark badge on it, blue and white colors. Single object, square composition. ${STYLE}` },
  { file: 'icon-board-plane.png', prompt: `A small passenger airplane taking off at a gentle upward angle, body white with blue stripe and orange tail fin. Single object, square composition. ${STYLE}` },
];

async function generate(item) {
  const out = path.join(ROOT, item.file);
  if (item.skipIfExists && fs.existsSync(out)) {
    console.log(`  跳过（已存在）: ${item.file}`);
    return { file: item.file, skipped: true };
  }
  if (fs.existsSync(out)) {
    console.log(`  跳过（已存在）: ${item.file}`);
    return { file: item.file, skipped: true };
  }

  for (let i = 1; i <= 5; i++) {
    let res, body;
    try {
      res = await fetch(BASE + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: 'agnes-image-2.5-flash',
          prompt: item.prompt,
          size: '1K',
          extra_body: { ratio: '1:1', response_format: 'url' },
        }),
      });
      body = await res.text();
    } catch (e) {
      console.log(`  ${item.file} 第 ${i} 次网络异常: ${e.message}`);
      await new Promise((s) => setTimeout(s, 2000 * i));
      continue;
    }

    if (res.ok) {
      const j = JSON.parse(body);
      const d = j.data?.[0] ?? {};
      fs.mkdirSync(ROOT, { recursive: true });
      if (d.url) {
        const img = await fetch(d.url);
        const buf = Buffer.from(await img.arrayBuffer());
        fs.writeFileSync(out, buf);
        console.log(`  ✓ ${item.file} (${(buf.length / 1024).toFixed(0)} KB)`);
        return { file: item.file, ok: true, kb: Math.round(buf.length / 1024) };
      }
      if (d.b64_json) {
        const buf = Buffer.from(d.b64_json, 'base64');
        fs.writeFileSync(out, buf);
        console.log(`  ✓ ${item.file} (${(buf.length / 1024).toFixed(0)} KB, base64)`);
        return { file: item.file, ok: true, kb: Math.round(buf.length / 1024) };
      }
      console.log(`  ${item.file} 响应结构未知: ${body.slice(0, 200)}`);
      return { file: item.file, ok: false, err: 'unknown shape' };
    }

    if (RETRYABLE.has(res.status)) {
      const wait = Math.min(1500 * 2 ** (i - 1), 15000);
      console.log(`  ${item.file} 第 ${i} 次 HTTP ${res.status}，${wait}ms 后重试`);
      await new Promise((s) => setTimeout(s, wait));
    } else {
      console.log(`  ${item.file} 不可重试错误 HTTP ${res.status}: ${body.slice(0, 160)}`);
      return { file: item.file, ok: false, err: `HTTP ${res.status}` };
    }
  }
  console.log(`  ${item.file} 重试耗尽`);
  return { file: item.file, ok: false, err: 'retry exhausted' };
}

(async () => {
  const all = [...AVATARS, ...ICONS];
  console.log(`开始生成 ${all.length} 个资源（已存在的自动跳过）\n`);
  const results = [];
  for (const item of all) {
    console.log(`→ ${item.file}`);
    results.push(await generate(item));
    await new Promise((s) => setTimeout(s, 800)); // 温柔一点，避免触发 RPM
  }

  const ok = results.filter((r) => r.ok).length;
  const skip = results.filter((r) => r.skipped).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log(`\n完成: 新生成 ${ok} / 跳过 ${skip} / 失败 ${fail}`);
  fs.writeFileSync('C:/Users/lenovo/AppData/Local/Temp/gen_assets.json', JSON.stringify(results, null, 2));
})();
