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
  {
    file: 'avatar-nico.png',
    prompt: `A cheerful young male shop assistant, wearing a green apron over a striped shirt
and a small paper hat, big excited grin with raised eyebrows, holding up a small gift box
in one hand, slightly over-enthusiastic expression. Full body, square composition. ${STYLE}`,
  },
  {
    file: 'avatar-momo.png',
    prompt: `A warm friendly young waitress, wearing a cream blouse with a small black bow tie
and a brown apron, hair in a neat bun, holding a small notepad and a pencil, gentle happy
smile, a pencil tucked behind one ear. Full body, square composition. ${STYLE}`,
  },
  {
    file: 'avatar-ivy.png',
    prompt: `A confident friendly young female event host, wearing a mint green blazer over a
white top, short bob haircut, holding a microphone in one hand and gesturing warmly with the
other, encouraging smile. Full body, square composition. ${STYLE}`,
  },
  {
    file: 'avatar-sam.png',
    prompt: `A friendly approachable teenage boy club president, wearing a navy school-uniform
blazer with a small camera hanging from a strap around his neck, short messy hair, relaxed
easygoing smile, one hand raised in a casual wave. Full body, square composition. ${STYLE}`,
  },
];

/** 关卡图标：替换 emoji，统一视觉语言
 *  每个场景 4 个，文件名与 Turso missions[].icon_image 严格对应 */
const ICONS = [
  // ── 机场值机（airport-checkin）──────────────────────────
  { file: 'icon-boarding-pass.png', prompt: `A simple boarding pass ticket icon, rectangular with a torn stub corner, small airplane symbol printed on it, teal and white colors. Single object, square composition. ${STYLE}` },
  { file: 'icon-luggage.png', prompt: `A chubby rolling suitcase icon, orange colored with visible zipper and handle, small wheels at bottom. Single object, square composition. ${STYLE}` },
  { file: 'icon-security.png', prompt: `A friendly security checkpoint icon: a metal detector archway frame with a small green checkmark badge on it, blue and white colors. Single object, square composition. ${STYLE}` },
  { file: 'icon-board-plane.png', prompt: `A small passenger airplane taking off at a gentle upward angle, body white with blue stripe and orange tail fin. Single object, square composition. ${STYLE}` },

  // ── 商店购物比价（shop-compare）────────────────────────
  { file: 'icon-shop-want.png', prompt: `A cute shopping basket icon with a small glowing star above it, warm yellow and brown colors, symbolizing "I want to buy this". Single object, square composition. ${STYLE}` },
  { file: 'icon-shop-price.png', prompt: `A price tag icon with a small coin beside it, red tag with a string loop, gold coin, symbolizing asking the price. Single object, square composition. ${STYLE}` },
  { file: 'icon-shop-compare.png', prompt: `A balance scale icon with a small price tag on each side, one side slightly lower, teal and cream colors, symbolizing comparing two items. Single object, square composition. ${STYLE}` },
  { file: 'icon-shop-buy.png', prompt: `A paper shopping bag icon with a small heart on it and a checkmark badge, coral pink colors, symbolizing making a purchase. Single object, square composition. ${STYLE}` },

  // ── 西餐厅点餐结账（restaurant-order）──────────────────
  { file: 'icon-rest-drink.png', prompt: `A tall glass of juice with a straw and ice cubes, orange juice color, cheerful and simple, symbolizing ordering a drink. Single object, square composition. ${STYLE}` },
  { file: 'icon-rest-main.png', prompt: `A plate of pasta with a fork and a small steam swirl above, warm yellow noodles and red sauce, symbolizing ordering a main dish. Single object, square composition. ${STYLE}` },
  { file: 'icon-rest-pref.png', prompt: `A cute red chili pepper icon with a small happy face and a green leaf, symbolizing spicy taste preference. Single object, square composition. ${STYLE}` },
  { file: 'icon-rest-bill.png', prompt: `A restaurant bill receipt icon with a small credit card behind it, white paper with zigzag bottom edge, blue card, symbolizing paying the bill. Single object, square composition. ${STYLE}` },

  // ── 即兴演讲（impromptu-speech）────────────────────────
  { file: 'icon-speech-topic.png', prompt: `A cute dice icon with question mark pips, purple and white colors, symbolizing drawing a random topic. Single object, square composition. ${STYLE}` },
  { file: 'icon-speech-opinion.png', prompt: `A glowing light bulb icon with a small speech bubble beside it, warm yellow glow, symbolizing stating an opinion. Single object, square composition. ${STYLE}` },
  { file: 'icon-speech-reason.png', prompt: `A single jigsaw puzzle piece icon with a small connecting arrow, teal and cream colors, symbolizing giving a reason or example. Single object, square composition. ${STYLE}` },
  { file: 'icon-speech-question.png', prompt: `A big friendly question mark icon with a small speech bubble, blue and white colors, symbolizing answering a question. Single object, square composition. ${STYLE}` },

  // ── 社团面试（club-interview）──────────────────────────
  { file: 'icon-club-intro.png', prompt: `A friendly waving hand icon with a small name badge beside it, warm peach colors, symbolizing introducing yourself. Single object, square composition. ${STYLE}` },
  { file: 'icon-club-why.png', prompt: `A cute heart icon with a small sparkle and an arrow pointing into it, pink and coral colors, symbolizing why you want to join. Single object, square composition. ${STYLE}` },
  { file: 'icon-club-strength.png', prompt: `A shiny gold star icon with small sparkles around it and a small badge ribbon below, symbolizing your personal strength. Single object, square composition. ${STYLE}` },
  { file: 'icon-club-ask.png', prompt: `Two overlapping speech bubbles icon, one asking and one replying, with a small handshake symbol between them, mint green and cream colors, symbolizing asking a question back. Single object, square composition. ${STYLE}` },
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

      /** 校验拿到的确实是图片 —— 上游偶发 503 时可能返回一段错误文本，
       *  若直接落盘会得到一个 19 字节的"文件"，且因为 existsSync 为真
       *  而被后续所有运行跳过，成为幽灵资源。 */
      const looksLikeImage = (buf) =>
        buf.length > 1024 &&
        // PNG: 89 50 4E 47 | JPEG: FF D8 FF
        ((buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
          (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff));

      let buf = null;
      if (d.url) {
        buf = Buffer.from(await (await fetch(d.url)).arrayBuffer());
      } else if (d.b64_json) {
        buf = Buffer.from(d.b64_json, 'base64');
      }

      if (buf && looksLikeImage(buf)) {
        fs.writeFileSync(out, buf);
        console.log(`  ✓ ${item.file} (${(buf.length / 1024).toFixed(0)} KB)`);
        return { file: item.file, ok: true, kb: Math.round(buf.length / 1024) };
      }

      // 内容不是图片 —— 当作可重试的失败处理，不要落盘
      const preview = buf ? buf.slice(0, 80).toString('utf8').replace(/\s+/g, ' ') : '(无数据)';
      console.log(
        `  ${item.file} 第 ${i} 次返回的不是图片 (${buf ? buf.length + ' 字节' : '空'}): ${preview}`
      );
      if (i < 5) {
        const wait = Math.min(1500 * 2 ** (i - 1), 15000);
        await new Promise((s) => setTimeout(s, wait));
        continue;
      }
      return { file: item.file, ok: false, err: 'not an image' };
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
