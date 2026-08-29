import { chromium } from 'playwright';
const OUT = 'C:/Users/danie/AppData/Local/Temp/claude/c--Users-danie-dev-newTab/208b09b0-583d-4b69-906d-edb4dc5c0768/scratchpad';
const BASE = 'http://localhost:5174';
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
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

// Worst case on: longest category + longest topic.
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

for (const w of [320, 390, 500, 720, 1280]) {
  await page.setViewportSize({ width: w, height: 800 });
  await page.waitForTimeout(450);
  await bar.evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  const box = await bar.boundingBox();
  await page.screenshot({ path: `${OUT}/fit-${w}.png`, clip: { x: 0, y: Math.max(0, box.y - 10), width: w, height: 72 } });
}

// The unread caret menu.
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(450);
await bar.evaluate(el => el.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Read actions' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/unread-menu.png`, clip: { x: 0, y: 0, width: 390, height: 300 } });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
// And the ⋯ menu, now that Manage feeds is a glyph in the row.
await page.getByRole('button', { name: 'Feed actions' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/more-menu.png`, clip: { x: 0, y: 0, width: 390, height: 300 } });
await b.close();
console.log('done');
