import { chromium } from 'playwright';
const BASE = 'http://localhost:5174';
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
await page.getByPlaceholder('yourname').fill('maren');
await page.locator('input[type="password"]').fill('ShowcaseNewt!2026');
const [r] = await Promise.all([page.waitForResponse(x => x.url().includes('/auth/login')), page.locator('button[type="submit"]').click()]);
if (r.status() !== 200) { console.log('login', r.status()); await b.close(); process.exit(1); }
await page.getByRole('button', { name: 'Today' }).first().waitFor({ timeout: 45000 });
await page.waitForTimeout(3000);
const bar = page.locator('[class*="_filterBox_"]').first();
await bar.evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
for (const g of ['Category', 'Topic']) {
  await page.getByRole('button', { name: new RegExp('^' + g + '$') }).first().click();
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[class*="_optionPick_"], [class*="_option_"]')]
      .filter(r => r.tagName === 'BUTTON' && r.offsetParent !== null && r.textContent.trim() && !/^All /.test(r.textContent.trim()));
    rows.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length)[0]?.click();
  });
  await page.waitForTimeout(700);
}
for (const w of [720, 1020]) {
  await page.setViewportSize({ width: w, height: 860 });
  await page.waitForTimeout(400);
  await bar.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const d = await bar.evaluate(el => {
    const q = s => el.querySelector(s);
    const info = (label, n) => {
      if (!n) return `${label}: absent`;
      const cs = getComputedStyle(n), r = n.getBoundingClientRect();
      return `${label}: w=${Math.round(r.width)} x=[${Math.round(r.left)},${Math.round(r.right)}] flex=${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis} minW=${cs.minWidth} ovf=${cs.overflowX}`;
    };
    const box = el.getBoundingClientRect();
    return [
      `bar: w=${Math.round(box.width)} x=[${Math.round(box.left)},${Math.round(box.right)}]`,
      info('left  ', q('[class*="_left_"]')),
      info('pills ', q('[class*="pills"]')),
      ...[...el.querySelectorAll('[class*="_left_"] > *')].map((n, i) => info('  L' + i + '  ', n)),
      ...[...el.querySelectorAll('[class*="_filterSet_"] > *')].map((n, i) => info('    S' + i + '  ', n.firstElementChild || n)),
      info('acts  ', q('[class*="_actions_"]')),
    ].join('\n    ');
  });
  console.log(`@${w}\n    ${d}`);
}
await b.close();
