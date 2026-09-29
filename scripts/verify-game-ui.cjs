/**
 * 闯关界面端到端验收（Playwright + Edge）
 *
 * 检查三件事：
 *   1. 场景选择页正确区分「闯关模式」与「对话模式」
 *   2. 进入机场场景后，角色卡 / 关卡清单 / 进度条 / 快捷回答全部渲染
 *   3. 点击快捷回答能真实推进关卡，进度条与关卡状态随之更新
 *
 * Edge 而非 Chrome：本机 Chrome 渲染进程会崩。
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3111';
const SHOT = 'shots';
const OUT = { steps: [], errors: [] };

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

  // ---------- 1. 场景选择页 ----------
  await page.goto(BASE + '/practice', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const cards = await page.locator('.card').count();
  const ctitle = await page.locator('.card .ctitle').allTextContents();
  const tags = await page.locator('.card .card-tag').allTextContents();
  step(1, `场景卡 ${cards} 张 | 标题: ${ctitle.join(' / ')} | 模式标签: ${tags.join(' / ')}`);
  await page.screenshot({ path: SHOT + '/10-picker.png', fullPage: true });

  const airportCard = page.locator('.card', { hasText: '机场' }).first();
  await airportCard.click();
  await page.waitForTimeout(2500);

  // ---------- 2. 闯关界面结构 ----------
  const hasChar = await page.locator('.charcard .charname').textContent().catch(() => null);
  const persona = await page.locator('.charcard .charpersona').textContent().catch(() => null);
  const missionCount = await page.locator('.mission').count();
  const missionLabels = await page.locator('.mission .m-label').allTextContents();
  const missionsText = missionLabels.map((t) => t.trim().replace(/\s+/g, ' '));
  const chips = await page.locator('.qchip').allTextContents();
  const progNum = await page.locator('.prog-num').textContent().catch(() => null);
  const goal = await page.locator('.nowgoal .ng-text').textContent().catch(() => null);

  step(2, `角色: ${hasChar} | 设定: ${(persona || '').slice(0, 30)}…`);
  step(3, `关卡 ${missionCount} 个: ${missionsText.join(' | ')}`);
  step(4, `进度: ${progNum} | 当前目标: ${goal} | 快捷回答: ${chips.join(' ')}`);
  await page.screenshot({ path: SHOT + '/11-game-start.png', fullPage: true });

  // 首屏应有开场白
  const opening = await page.locator('.bubble.ai .txt').first().textContent();
  step(5, `开场白: ${opening}`);

  // ---------- 3. 推进两轮，验证进度变化 ----------
  // 等待策略：轮询等 loading 消失，而不是死等固定秒数
  // （推理类模型响应 7-28 秒波动很大，固定等待必然误判）
  async function waitReply(timeoutMs = 40000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const typing = await page.locator('.typing').count();
      if (typing === 0) {
        await page.waitForTimeout(400);
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  await page.locator('.qchip', { hasText: 'Yes!' }).first().click();
  await waitReply();
  const prog1 = await page.locator('.prog-num').textContent();
  const done1 = await page.locator('.mission.done').count();
  step(6, `第 1 轮后 → 进度 ${prog1}，已完成关卡 ${done1} 个`);
  await page.screenshot({ path: SHOT + '/12-turn1.png', fullPage: true });

  // 第二轮：说目的地
  await page.fill('.inp', 'I fly to Tokyo!');
  await page.click('button.send');
  await waitReply();
  const prog2 = await page.locator('.prog-num').textContent();
  const done2 = await page.locator('.mission.done').count();
  const lastReply = await page.locator('.bubble.ai .txt').last().textContent();
  step(7, `第 2 轮后 → 进度 ${prog2}，已完成关卡 ${done2} 个`);
  step(8, `最新回复: ${lastReply.replace(/\n+/g, ' / ').trim().slice(0, 140)}`);
  await page.screenshot({ path: SHOT + '/13-turn2.png', fullPage: true });

  // ---------- 4. 通关结算页（直接驱动到第 8 轮） ----------
  const script = ['Window seat please!', 'Oh no why?', 'I take out my shoes.', 'OK!', 'What was the beep?', 'Bye bye Max!'];
  for (let i = 0; i < script.length; i++) {
    if (await page.locator('.finish').count()) break;
    await page.fill('.inp', script[i]);
    await page.click('button.send');
    await waitReply();
    const p = await page.locator('.prog-num').textContent().catch(() => '-');
    console.log(`   轮 ${i + 3} → ${p}`);
  }
  // 结算页由状态同步置位，给 React 一帧渲染时间即可
  await page.waitForTimeout(800);

  const finished = await page.locator('.finish').count();
  if (finished) {
    const badge = await page.locator('.finish-badge').textContent();
    const title = await page.locator('.finish-title').textContent();
    const fms = await page.locator('.fm').count();
    step(9, `通关结算页 ✓ 徽章 ${badge} | 称号「${title}」| 关卡回显 ${fms} 个`);
    await page.screenshot({ path: SHOT + '/14-finish.png', fullPage: true });
  } else {
    step(9, `⚠ 未出现结算页（进度停在 ${await page.locator('.prog-num').textContent()}）`);
    await page.screenshot({ path: SHOT + '/14-no-finish.png', fullPage: true });
  }

  // ---------- 结果 ----------
  console.log('\n===== 汇总 =====');
  console.log('页面错误数:', OUT.errors.length);
  if (OUT.errors.length) OUT.errors.slice(0, 10).forEach((e) => console.log('  ', e));

  const code = OUT.errors.length > 0 || !finished ? 1 : 0;
  await browser.close();
  process.exit(code);
})().catch((e) => {
  console.error('验收脚本异常:', e.message);
  process.exit(2);
});
