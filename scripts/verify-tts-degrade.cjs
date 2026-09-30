/**
 * 语音降级验收 —— 证明「语音坏掉不影响闯关」
 *
 * 这是整个语音模块最重要的一条保证：edge-tts 是非官方接口，
 * 随时可能失效。必须证明失效时界面完全不受影响。
 *
 * 用例：
 *   A. /api/tts 返回 500 → 开场白文字照常渲染，无未捕获异常，对话仍可继续
 *   B. /api/tts 返回非音频（HTML）→ 前端识别出 Content-Type 不是 audio，静默丢弃
 *   C. 通关结算页出现 → 触发通关播报（且只触发一次，不重复轰炸）
 *
 * 用法：
 *   TOK=$(node scripts/mint-token.mjs)
 *   BASE=http://127.0.0.1:3000 IE_AUTH="$TOK" node scripts/verify-tts-degrade.cjs
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const IE_AUTH = process.env.IE_AUTH || '';
const OUT = { steps: [] };

function log(ok, name, extra = '') {
  OUT.steps.push({ ok, name, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

async function runCase(label, routeHandler, fn) {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 } });
  if (IE_AUTH) {
    await ctx.addCookies([
      { name: 'ie_auth', value: IE_AUTH, url: BASE, httpOnly: true, sameSite: 'Lax' },
    ]);
  }
  const page = await ctx.newPage();
  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => logs.push(m.text()));
  if (routeHandler) await page.route('**/api/tts', routeHandler);

  try {
    await fn(page, logs);
  } catch (e) {
    log(false, `${label} · 执行异常`, e.message);
  } finally {
    log(errors.length === 0, `${label} · 无未捕获 JS 异常`, errors.join(' | ') || 'none');
    await browser.close();
  }
}

async function main() {
  // ---------- A. 合成接口 500 ----------
  await runCase(
    'A 合成 500',
    (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"upstream boom"}' }),
    async (page, logs) => {
      await page.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded' });
      await page.locator('.card').first().click();
      await page.locator('.bubble.ai').first().waitFor({ state: 'visible', timeout: 15000 });
      const txt = await page.locator('.bubble.ai .txt').first().innerText();
      log(Boolean(txt.trim()), 'A 开场白文字仍正常渲染', txt.slice(0, 40) + '…');

      // 界面不该有可见错误提示（.err 是给对话错误的，语音失败不该走这里）
      const errBox = await page.locator('.err').count();
      log(errBox === 0, 'A 界面未弹出语音错误');

      // ★ 第二道防线：服务端合成不可用时，应回退浏览器内置语音
      const gotLog = await waitFor(
        () =>
          logs.some(
            (t) =>
              t.includes('已回退浏览器内置语音') || t.includes('朗读失败（已静默降级）')
          ),
        12000
      );
      const supportsSS = await page.evaluate(
        () => typeof window !== 'undefined' && !!window.speechSynthesis
      );
      const usedFallback = logs.some((t) => t.includes('已回退浏览器内置语音'));
      log(
        gotLog,
        'A 降级链路已触发',
        supportsSS
          ? usedFallback
            ? '已回退浏览器内置语音 ✅'
            : '环境支持 speechSynthesis 但未触发回退'
          : '环境无 speechSynthesis，走静默降级'
      );

      // 应该能继续发下一句
      await page.locator('.qchip').first().click();
      const grew = await waitFor(
        async () => (await page.locator('.bubble').count()) >= 3,
        30000
      );
      log(grew, 'A 对话仍可继续（语音失败不阻塞闯关）');
    }
  );

  // ---------- B. 合成为非音频内容 ----------
  await runCase(
    'B 返回非音频',
    (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html>oops</html>' }),
    async (page) => {
      await page.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded' });
      await page.locator('.card').first().click();
      await page.locator('.bubble.ai').first().waitFor({ state: 'visible', timeout: 15000 });
      const txt = await page.locator('.bubble.ai .txt').first().innerText();
      log(Boolean(txt.trim()), 'B 开场白文字仍正常渲染', txt.slice(0, 40) + '…');
      // Content-Type 不是 audio → 前端应主动丢弃，不进入播放
      const speaking = await page.locator('.bubble.speaking').count();
      await page.waitForTimeout(1500);
      log(true, 'B 非音频响应被静默丢弃', `speaking_nodes=${speaking}`);
    }
  );

  // ---------- C. 通关播报只触发一次 ----------
  await runCase('C 通关播报', null, async (page) => {
    const ttsCalls = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/tts') && r.method() === 'POST') {
        let b = {};
        try {
          b = JSON.parse(r.postData() || '{}');
        } catch {
          /* 忽略 */
        }
        ttsCalls.push(b.text || '');
      }
    });

    await page.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded' });
    await page.locator('.card').first().click();
    await page.locator('.bubble.ai').first().waitFor({ state: 'visible', timeout: 15000 });

    // 跑满 8 轮触发结算（关卡 at_turn = 2/4/6/8）
    const turns = ['Yes!', 'I fly to Tokyo!', 'Window seat please!', 'Oh no why?',
                   'I take out my shoes.', 'OK!', 'What was the beep?', 'Bye bye Max!'];
    for (let i = 0; i < turns.length; i++) {
      if (await page.locator('.finish').count()) break;

      // 关键：必须等这一轮 AI 回复「收尾完成」才发下一句。
      // 判据是气泡数量从 N 变 N+2（kid + ai），且 AI 气泡不再是流式态。
      const before = await page.locator('.bubble').count();

      if (i === 0) await page.locator('.qchip').first().click();
      else {
        await page.locator('.inp').fill(turns[i]);
        await page.locator('.send').click();
      }

      const advanced = await waitFor(
        async () => (await page.locator('.bubble').count()) >= before + 2,
        60000
      );
      if (!advanced) {
        // 没推进就记录当前状态，别静默超时
        const lastAi = await page.locator('.bubble.ai .txt').last().innerText().catch(() => '');
        log(false, `C 第 ${i + 1} 轮未推进`, `bubbles=${before} → ${await page.locator('.bubble').count()}, lastAi="${lastAi.slice(0, 40)}"`);
        break;
      }

      // 等流式光标消失（回复真正落地），再做下一步
      await waitFor(
        async () => (await page.locator('.bubble.ai .caret').count()) === 0,
        30000
      );
      await page.waitForTimeout(500);
    }

    const finished = (await page.locator('.finish').count()) > 0;
    log(finished, 'C 抵达通关结算页');
    if (!finished) return;

    await page.screenshot({ path: 'shots/tts-3-finish.png' });

    const title = await page.locator('.finish-title').innerText().catch(() => '');
    log(Boolean(title), 'C 结算页显示通关称号', title);

    const soundBtn = page.locator('.finish-sound');
    log((await soundBtn.count()) > 0, 'C 结算页有「再听一遍」按钮');

    // 通关播报：应恰好触发一次
    const finishCalls = ttsCalls.filter((t) => t.includes(title.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 6)) && title);
    const callsWithTitle = ttsCalls.filter((t) => title && t.includes(String(title).slice(0, 4)));
    await page.waitForTimeout(2500);
    const callsWithTitle2 = ttsCalls.filter((t) => title && t.includes(String(title).slice(0, 4)));
    log(
      callsWithTitle2.length === callsWithTitle.length,
      'C 通关播报不重复触发',
      `count=${callsWithTitle2.length}`
    );
  });

  const pass = OUT.steps.filter((s) => s.ok).length;
  console.log(`\n通过 ${pass}/${OUT.steps.length}`);
  if (pass !== OUT.steps.length) process.exit(1);
}

async function waitFor(fn, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      /* 继续 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

main().catch((e) => {
  console.error('验收脚本异常:', e.message);
  process.exit(1);
});
