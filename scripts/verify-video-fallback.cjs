// 验证：intro_video 指向的文件尚不存在时，视频区块必须自动隐藏（不报错、不占位）
const { chromium } = require('playwright');

const BASE = 'http://localhost:3111';

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    proxy: { server: 'direct://', bypass: '127.0.0.1,localhost' },
  });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });

  if (process.env.IE_AUTH) {
    await ctx.addCookies([
      { name: 'ie_auth', value: process.env.IE_AUTH, domain: 'localhost', path: '/', httpOnly: true },
    ]);
  }

  const errs = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
  });

  await page.goto(BASE + '/practice', { waitUntil: 'networkidle' });
  await page.locator('.card', { hasText: '机场' }).first().click();
  await page.waitForTimeout(3000);

  const videoEls = await page.locator('.introvideo').count();
  const charcard = await page.locator('.charcard').count();
  const missions = await page.locator('.mission').count();
  const prog = await page.locator('.prog-num').textContent().catch(() => '-');

  console.log(`视频区块（文件缺失时应为 0）: ${videoEls}`);
  console.log(`角色卡: ${charcard} | 关卡: ${missions} | 进度: ${prog}`);

  // 应用级错误里忽略「视频加载失败」类的网络噪音
  const real = errs.filter(
    (e) => !/intro-airport|Failed to load resource|net::ERR|MEDIA_ELEMENT/i.test(e)
  );
  console.log(`页面错误数（已排除视频 404 噪音）: ${real.length}`);
  real.slice(0, 5).forEach((e) => console.log('  ', e));

  await page.screenshot({ path: 'shots/15-video-fallback.png', fullPage: false });

  await browser.close();
  process.exit(real.length === 0 && videoEls === 0 ? 0 : 1);
})().catch((e) => {
  console.error('异常:', e.message);
  process.exit(2);
});
