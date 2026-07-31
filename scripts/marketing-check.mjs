// Checks the public marketing pages for the two ways they fail *silently* —
// where the page still renders, still looks deliberate, and is simply missing
// something no error would ever report:
//
//   1. A screenshot frame with no image falls back to its own spec sheet, which
//      looks like a designed empty state rather than a broken reference. A shot
//      wired up under the wrong filename looks exactly like one not yet taken.
//
//   2. Reveal-on-scroll elements start at `opacity: 0` and are only shown once
//      an IntersectionObserver has seen them. Anything the observer misses is
//      permanently invisible — the copy is in the DOM, passes every test, and
//      is never once seen by a reader.
//
// Both are checked through *in-app navigation*, not just direct loads, because
// (2) only ever happened on the navigation path: the six feature pages are all
// <FeaturePage>, so React reconciles rather than remounts, and a one-shot scan
// on mount observed the first page's elements and none of the next page's.
//
//   node scripts/marketing-check.mjs        (or: npm run marketing:check)
//
// Runs signed-out and costs no auth requests.
import { chromium } from 'playwright';

const BASE = process.env.SHOTS_BASE || 'http://localhost:5173';

// The nav menu labels that lead to each feature page.
const FEATURES = ['Bookmarks', 'Feeds', 'Reading list', 'Notes', 'Posts', 'Together'];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
const page = await ctx.newPage();

/** Walk the whole page so every lazy image and reveal group gets its chance. */
async function settle() {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 70));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
}

async function audit() {
  return page.evaluate(() => {
    const shots = [...document.querySelectorAll('img')]
      .filter(i => i.src.includes('/shots/'))
      .map(i => ({ src: new URL(i.src).pathname, ok: i.complete && i.naturalWidth > 0 }));
    const hidden = [...document.querySelectorAll('[data-reveal]')]
      .filter(el => Number(getComputedStyle(el).opacity) < 0.05);
    return {
      path: location.pathname,
      shots: shots.length,
      brokenShots: shots.filter(s => !s.ok).map(s => s.src),
      // The spec-sheet fallback only renders when a frame has no src.
      placeholders: (document.body.innerText.match(/still to take|Must show/gi) || []).length,
      hidden: hidden.length,
      firstHidden: hidden[0]?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 46) ?? null,
    };
  });
}

let bad = 0;

function report(r) {
  const problems = [];
  if (r.brokenShots.length) problems.push(`${r.brokenShots.length} broken image(s)`);
  if (r.placeholders) problems.push(`${r.placeholders} placeholder frame(s)`);
  if (r.hidden) problems.push(`${r.hidden} element(s) never revealed`);
  if (problems.length) {
    bad++;
    console.log(`✗ ${r.path.padEnd(22)} ${problems.join(', ')}`);
    r.brokenShots.forEach(s => console.log(`    broken: ${s}`));
    if (r.firstHidden) console.log(`    first unrevealed: "${r.firstHidden}"`);
  } else {
    console.log(`✓ ${r.path.padEnd(22)} ${r.shots} shot(s), all copy revealed`);
  }
}

// Landing page, loaded directly.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await settle();
report(await audit());

// Every feature page, reached through the nav menu rather than by URL.
for (const label of FEATURES) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: /What.s in it/i }).hover();
  await page.waitForTimeout(400);
  await page.getByRole('link', { name: new RegExp(`^${label}`, 'i') }).first().click();
  await page.waitForTimeout(700);
  await settle();
  report(await audit());
}

// And self-hosting, also from the nav.
await page.evaluate(() => window.scrollTo(0, 0));
await page.getByRole('link', { name: 'Self-hosting' }).first().click();
await page.waitForTimeout(700);
await settle();
report(await audit());

await browser.close();
console.log(bad ? `\n${bad} page(s) with problems.` : '\nAll marketing pages check out.');
process.exit(bad ? 1 : 0);
