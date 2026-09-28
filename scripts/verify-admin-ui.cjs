/**
 * 配置中心 UI 端到端验收（Playwright + Edge）
 *
 * 用 Edge 而非 Chrome：本机 Chrome 渲染进程会崩。
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:3000';
const SHOT = 'shots';

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    // 本机有代理，本地服务必须绕开，否则连不上
    proxy: { server: 'direct://', bypass: '127.0.0.1,localhost' },
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  const log = (...a) => console.log(...a);

  // ---------- 1. 未登录访问 /admin 应显示登录框 ----------
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  const loginVisible = await page.locator('input[type=password]').first().isVisible();
  const h1 = await page.locator('h1').first().textContent();
  log('1) 未登录 /admin →  标题:', h1, '| 登录框可见:', loginVisible);
  await page.screenshot({ path: SHOT + '/01-login.png' });

  // ---------- 2. 错口令 ----------
  await page.fill('input[type=password]', 'wrongpass');
  await page.click('button.save');
  await page.waitForTimeout(900);
  const toastErr = await page.locator('.toast.err').textContent().catch(() => null);
  log('2) 错口令 → 提示:', toastErr);
  await page.screenshot({ path: SHOT + '/02-wrong-password.png' });

  // ---------- 3. 正确口令登录 ----------
  await page.fill('input[type=password]', 'parent2026');
  await page.click('button.save');
  await page.waitForTimeout(1800);
  const hasPanels = await page.locator('.card-panel').count();
  log('3) 正确口令登录 → 配置面板数:', hasPanels);
  await page.screenshot({ path: SHOT + '/03-config-full.png', fullPage: true });

  // ---------- 4. 检查密钥掩码显示 ----------
  const keyLabel = await page.locator('.flabel', { hasText: 'API Key' }).first().textContent();
  log('4) API Key 标签:', keyLabel.replace(/\s+/g, ' ').trim());

  // 确认页面上不出现明文 key
  const bodyText = await page.locator('body').innerText();
  const leaksPlain = bodyText.includes('sk-test1234567890abcdefghijklmn');
  log('   页面是否泄露明文 key:', leaksPlain ? '❌ 泄露！' : '✅ 未泄露');

  // ---------- 5. 服务商预设按钮 ----------
  const chips = await page.locator('.chip').count();
  await page.locator('.chip', { hasText: '通义千问' }).click();
  await page.waitForTimeout(300);
  const baseUrlVal = await page.inputValue('input[value*="dashscope"], .field:has-text("API 地址") input').catch(() => '?');
  log('5) 预设按钮数:', chips, '| 点击「通义千问」后 API 地址:', baseUrlVal);
  await page.screenshot({ path: SHOT + '/04-preset-filled.png' });

  // ---------- 6. 改回 DeepSeek 并测试连接 ----------
  await page.locator('.chip', { hasText: 'DeepSeek' }).click();
  await page.waitForTimeout(300);
  await page.locator('button.ghost', { hasText: '测试连接' }).click();
  await page.waitForTimeout(3500);
  const testBox = await page.locator('.alert.err, .alert.ok').last().textContent().catch(() => null);
  log('6) 测试连接结果:', (testBox || '').replace(/\s+/g, ' ').slice(0, 150));
  await page.screenshot({ path: SHOT + '/05-test-connection.png' });

  // ---------- 7. 保存 ----------
  const tempVal = '0.85';
  const tempInput = page.locator('.field:has-text("温度") input');
  await tempInput.fill(tempVal);
  await page.locator('button.save', { hasText: '保存配置' }).click();
  await page.waitForTimeout(1600);
  const toastOk = await page.locator('.toast.ok').textContent().catch(() => null);
  log('7) 保存 → 提示:', toastOk);
  await page.screenshot({ path: SHOT + '/06-saved.png' });

  // ---------- 8. 刷新后确认持久化 ----------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const tempAfter = await page.locator('.field:has-text("温度") input').inputValue();
  log('8) 刷新后温度值:', tempAfter, tempAfter === tempVal ? '✅ 已持久化' : '❌ 未持久化');

  // ---------- 9. 访问保护区块 ----------
  const accessSection = await page.locator('.card-panel', { hasText: '访问保护' }).textContent();
  log('9) 访问保护状态:', accessSection.replace(/\s+/g, ' ').slice(0, 120));

  // ---------- 10. 环境变量说明表 ----------
  const envRows = await page.locator('.envtable tr').count();
  log('10) 环境变量说明行数:', envRows);

  // ---------- 11. 练习页 ----------
  await page.goto(BASE + '/practice', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const cards = await page.locator('.card').count();
  const adminLink = await page.locator('.adminlink').count();
  log('11) 练习页场景卡:', cards, '| 配置入口链接:', adminLink);
  await page.screenshot({ path: SHOT + '/07-practice.png' });

  // ---------- 12. 看板 ----------
  await page.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const dashH1 = await page.locator('h1').first().textContent();
  log('12) 看板标题:', dashH1);
  await page.screenshot({ path: SHOT + '/08-dashboard.png' });

  // ---------- 13. 未登录访问看板（新上下文，无 Cookie）----------
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
  await page2.waitForTimeout(700);
  const url2 = page2.url();
  log('13) 无 Cookie 访问 /dashboard → 落地 URL:', url2);

  log('\n=== 页面错误 ===');
  log(errors.length ? errors.slice(0, 12).join('\n') : '无');

  await browser.close();
})();
