/**
 * 闯关界面端到端验收（Playwright + Edge）
 *
 * 覆盖全部 5 个场景，每个场景走完整 8 轮，检查：
 *   1. 场景卡与「闯关模式」标签
 *   2. 角色卡 / 立绘 / 关卡清单 / 关卡图标 / 进度条 全部渲染且图片真实加载
 *   3. 流式首字延迟（本轮改造的核心指标）
 *   4. 进度条按 2 轮/关 推进到 4/4
 *   5. 通关结算页出现，徽章与称号正确
 *
 * Edge 而非 Chrome：本机 Chrome 渲染进程会崩。
 *
 * ★★ 必须传 IE_AUTH ★★
 * 一旦在 /admin 启用了访问口令，`/api/chat` 会返回 401。
 * 此时如果不带登录 Cookie 跑本脚本，会看到**极具误导性的现象**：
 *   - 页面正常渲染、立绘与图标全部加载成功
 *   - 但每一轮进度条都停在 0/4，永远不结算
 * 看起来像「关卡推进逻辑坏了」，实际是鉴权把对话全挡掉了。
 *
 * 正确用法：
 *   TOK=$(node -e "…本地签发同 SETTINGS_SECRET 的 token…")
 *   BASE=http://127.0.0.1:3011 IE_AUTH="$TOK" node scripts/verify-game-ui.cjs
 *
 * 签发脚本见 docs/验收方法.md。
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3111';
const SHOT = 'shots';
const OUT = { steps: [], errors: [] };

/** 每个场景的 8 轮台词。
 *  第 1 轮点快捷回答（消耗 turn 1），turns[1..7] 手输填满 turn 2..8。
 *  关卡 at_turn 是 2/4/6/8，所以**必须跑满 8 轮**才能到结算页。
 *  台词只需「沾边」，验证的是节奏与进度同步，不是语义准确率。 */
const SCRIPTS = {
  'airport-checkin': {
    label: '机场值机',
    turns: [
      'Yes!',
      'I fly to Tokyo!',
      'Window seat please!',
      'Oh no why?',
      'I take out my shoes.',
      'OK!',
      'What was the beep?',
      'Bye bye Max!',
    ],
    expectTitle: '空中飞人',
  },
  'shop-compare': {
    label: '商店购物',
    turns: [
      'Yes!',
      'I want a gift.',
      'A toy please.',
      'How much is it?',
      'That is cheap!',
      'I like the red one.',
      'The blue one is better.',
      'OK I take it!',
    ],
    expectTitle: '砍价小能手',
  },
  'restaurant-order': {
    label: '餐厅点餐',
    turns: [
      'Yes!',
      'Juice please.',
      'I want pasta.',
      'Not spicy please.',
      'Sounds good!',
      'Yes please.',
      'I want dessert.',
      'Here you are!',
    ],
    expectTitle: '点餐达人',
  },
  'impromptu-speech': {
    label: '即兴演讲',
    turns: [
      'Yes!',
      'I am ready.',
      'I think yes.',
      'Because pets are fun.',
      'We can play together.',
      'For example my dog.',
      'Thank you!',
      'Yes I can answer.',
    ],
    expectTitle: '小小演说家',
  },
  'club-interview': {
    label: '社团面试',
    turns: [
      'Yes!',
      'I am Alex.',
      'I like photos.',
      'Because it is fun.',
      'I want to learn.',
      'I am good at drawing.',
      'I like sports too.',
      'What do you do?',
    ],
    expectTitle: '社团新星',
  },
};

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    proxy: { server: 'direct://', bypass: '127.0.0.1,localhost' },
  });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 }, // 手机竖屏，贴近孩子真实使用场景
    deviceScaleFactor: 2,
  });

  // 复用本地 dev 生成的登录 Cookie（访问口令启用时必需）
  if (process.env.IE_AUTH) {
    const url = new URL(BASE);
    await ctx.addCookies([
      {
        name: 'ie_auth',
        value: process.env.IE_AUTH,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
      },
    ]);
  }

  const page = await ctx.newPage();
  page.on('pageerror', (e) => OUT.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') OUT.errors.push('console: ' + m.text());
  });

  const step = (n, text) => {
    OUT.steps.push(`${n}) ${text}`);
    console.log(`${n}) ${text}`);
  };

  /** 等待回复结束：没有 .typing 且没有 .caret 且发送按钮可用 */
  async function waitReply(timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const typing = await page.locator('.typing').count();
      const caret = await page.locator('.caret').count();
      const busy = await page.locator('button.send').isDisabled().catch(() => false);
      if (typing === 0 && caret === 0 && !busy) {
        await page.waitForTimeout(400);
        return true;
      }
      await page.waitForTimeout(400);
    }
    return false;
  }

  // ---------- 1. 场景选择页 ----------
  await page.goto(BASE + '/practice', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const cards = await page.locator('.card').count();
  const ctitle = await page.locator('.card .ctitle').allTextContents();
  const tags = await page.locator('.card .card-tag').allTextContents();
  step(1, `场景卡 ${cards} 张 | 标题: ${ctitle.join(' / ')}`);
  step(1.1, `模式标签: ${tags.join(' / ')}`);
  await page.screenshot({ path: SHOT + '/10-picker.png', fullPage: true });

  const results = [];

  for (const [slug, cfg] of Object.entries(SCRIPTS)) {
    console.log(`\n──────── ${cfg.label} (${slug}) ────────`);
    const R = { slug, ok: false, notes: [] };
    results.push(R);

    // 回列表页点进该场景（用卡片标题里的关键词匹配）
    await page.goto(BASE + '/practice', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const card = page.locator('.card', { hasText: cfg.label.slice(0, 2) }).first();
    if ((await card.count()) === 0) {
      R.notes.push('未找到场景卡');
      console.log('  ✗ 未找到场景卡');
      continue;
    }
    await card.click();
    await page.waitForTimeout(3000);

    // ---------- 结构 + 美术资源 ----------
    const charName = await page.locator('.charcard .charname').textContent().catch(() => null);
    const missionCount = await page.locator('.mission').count();
    const missionLabels = (await page.locator('.mission .m-label').allTextContents()).map((t) =>
      t.trim().replace(/\s+/g, ' ')
    );

    async function imgOk(locator) {
      const n = await locator.count();
      if (n === 0) return { n: 0, loaded: 0, src: null };
      const src = await locator.first().getAttribute('src');
      const loaded = await locator.first().evaluate((el) => el.complete && el.naturalWidth > 0);
      return { n, loaded: loaded ? 1 : 0, src };
    }

    const avatarImg = await imgOk(page.locator('.charcard .avatar img'));
    const iconCount = await page.locator('.mission .m-icon img').count();
    const iconLoaded = await page.locator('.mission .m-icon img').evaluateAll((els) =>
      els.filter((e) => e.complete && e.naturalWidth > 0).length
    );

    console.log(`  角色: ${charName} | 关卡 ${missionCount} 个: ${missionLabels.join(' | ')}`);
    console.log(
      `  立绘 ${avatarImg.loaded ? '✓' : '✗'} (${avatarImg.src}) | 图标 ${iconLoaded}/${iconCount}`
    );
    if (avatarImg.n === 0 || !avatarImg.loaded) R.notes.push('立绘未加载');
    if (iconLoaded < iconCount) R.notes.push(`图标 ${iconLoaded}/${iconCount}`);
    if (missionCount !== 4) R.notes.push(`关卡数 ${missionCount}≠4`);

    await page.screenshot({ path: `${SHOT}/g-${slug}-start.png`, fullPage: true });

    // ---------- 流式首字 ----------
    const t0Stream = Date.now();
    const chip = page.locator('.qchip').first();
    if ((await chip.count()) > 0) await chip.click();
    else {
      await page.fill('.inp', cfg.turns[0]);
      await page.click('button.send');
    }
    let ttft = null;
    for (let i = 0; i < 400; i++) {
      if ((await page.locator('.bubble.ai .caret').count()) > 0) {
        ttft = Date.now() - t0Stream;
        break;
      }
      await page.waitForTimeout(100);
    }
    console.log(`  流式首字: ${ttft === null ? '✗ 未捕获' : ttft + 'ms'}`);
    if (ttft === null) R.notes.push('未捕获流式光标');
    await waitReply();

    let prog = await page.locator('.prog-num').textContent().catch(() => '-');
    console.log(`  轮 1 → ${prog}`);

    // ---------- 跑完剩余轮次 ----------
    for (let i = 1; i < cfg.turns.length; i++) {
      if ((await page.locator('.finish').count()) > 0) break;
      await page.fill('.inp', cfg.turns[i]);
      await page.click('button.send');
      await waitReply();
      prog = await page.locator('.prog-num').textContent().catch(() => '-');
      console.log(`  轮 ${i + 1} → ${prog}`);
    }
    await page.waitForTimeout(900);

    // ---------- 结算页 ----------
    if ((await page.locator('.finish').count()) > 0) {
      const badge = await page.locator('.finish-badge').textContent().catch(() => '?');
      const title = await page.locator('.finish-title').textContent().catch(() => '?');
      const fms = await page.locator('.fm').count();
      console.log(`  ✓ 结算页: ${badge} ${title} | 关卡回显 ${fms} 个`);
      if (!String(title).includes(cfg.expectTitle)) R.notes.push(`称号「${title}」≠预期「${cfg.expectTitle}」`);
      if (fms !== 4) R.notes.push(`回显 ${fms}≠4`);
      R.ok = R.notes.length === 0;
      await page.screenshot({ path: `${SHOT}/g-${slug}-finish.png`, fullPage: true });
    } else {
      console.log(`  ✗ 未出现结算页（进度 ${prog}）`);
      R.notes.push(`未结算，停在 ${prog}`);
      await page.screenshot({ path: `${SHOT}/g-${slug}-nofinish.png`, fullPage: true });
    }
  }

  // ---------- 结果 ----------
  console.log('\n===== 汇总 =====');
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.slug.padEnd(20)} ${r.ok ? '通过' : r.notes.join('; ')}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${passed}/${results.length}`);
  console.log('页面错误数:', OUT.errors.length);
  if (OUT.errors.length) OUT.errors.slice(0, 12).forEach((e) => console.log('  ', e));

  const code = OUT.errors.length > 0 || passed !== results.length ? 1 : 0;
  await browser.close();
  process.exit(code);
})().catch((e) => {
  console.error('验收脚本异常:', e.message);
  process.exit(2);
});
