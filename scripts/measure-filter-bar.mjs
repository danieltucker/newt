// Sweeps the feed's control bar across viewport widths and reports, at each
// one, the bar's own width, how tall it came out, and whether its contents
// overflow it.
//
//   node scripts/measure-filter-bar.mjs                 # the default sweep
//   node scripts/measure-filter-bar.mjs 320 360 900     # just those widths
//   node scripts/measure-filter-bar.mjs --filtered      # with two pills showing
//
// The bar promises to be exactly one line at every width (`flex-wrap: nowrap`
// on .bar), which makes two things failures and they are different failures:
//
//   WRAPPED   - the row is taller than one control. Should be impossible now;
//               if it happens, something inside the bar re-introduced a wrap.
//   OVERFLOW  - scrollWidth exceeds clientWidth. The row stayed one line by
//               running off the end of its box, which widens the document and
//               makes mobile Safari scale the whole page out. Worse than a wrap.
//
// Both are cured by moving one of the thresholds in FeedFilterBar.tsx. Run this
// after touching either half of the bar, and re-derive EXPAND_AT /
// FOLD_ACTIONS_AT / GLYPH_FILTERS_AT from what it prints rather than by
// arithmetic - the numbers depend on font metrics, on --ctl-h, and on how long
// the reader's own category names happen to be.
//
// Needs the dev server and a signed-in showcase account, same as shots.mjs.
import { chromium } from 'playwright';

const BASE = process.env.BAR_BASE || 'http://localhost:5173';
const USER = process.env.BAR_USER || 'maren';
const PASSWORD = process.env.SHOTS_PASSWORD || 'ShowcaseNewt!2026';

const FILTERED = process.argv.includes('--filtered');
const args = process.argv.slice(2).map(Number).filter(n => Number.isFinite(n));
const SWEEP = [];
for (let w = 300; w <= 1500; w += 10) SWEEP.push(w);
const WIDTHS = args.length ? args : SWEEP;

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
await page.getByPlaceholder('yourname').fill(USER);
await page.locator('input[type="password"]').fill(PASSWORD);
const [res] = await Promise.all([
  page.waitForResponse(r => r.url().includes('/auth/login'), { timeout: 30000 }),
  page.locator('button[type="submit"]').click(),
]);
if (res.status() === 429) {
  const wait = Number(res.headers()['ratelimit-reset'] || 60) + 2;
  console.error(`rate limited on sign-in; wait ${wait}s and re-run`);
  await b.close();
  process.exit(1);
}
if (!res.ok()) throw new Error(`sign-in failed: HTTP ${res.status()}`);
await page.getByRole('button', { name: 'Today' }).first().waitFor({ timeout: 45000 });
await page.waitForTimeout(3000);


/**
 * Turn on the worst case before sweeping: a category and the longest topic the
 * feed has published, so the bar is carrying two active pills and the longest
 * label it will ever have to render. An empty bar fitting proves very little -
 * the pills are what used to force the second line.
 */
async function applyWorstCaseFilters(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(400);
  const bar = page.locator('[class*="_filterBox_"]').first();
  await bar.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);

  for (const group of ['Category', 'Topic']) {
    const chip = page.getByRole('button', { name: new RegExp(`^${group}$`) }).first();
    if (!(await chip.count())) continue;
    await chip.click();
    await page.waitForTimeout(350);
    // The longest option in the open panel, which is the one that stresses the
    // row hardest.
    const picked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[class*="_optionPick_"], [class*="_option_"]')]
        // Buttons only. A starrable row is a span wrapping the button, and it
        // has the same text - sorting by length picks the span, and clicking a
        // span does nothing at all.
        .filter(r => r.tagName === 'BUTTON' && r.offsetParent !== null && r.textContent.trim() && !/^All /.test(r.textContent.trim()));
      if (rows.length === 0) return null;
      const longest = rows.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length)[0];
      longest.click();
      return longest.textContent.trim();
    });
    console.log(`  ${group}: ${picked ?? '(nothing to pick)'}`);
    await page.waitForTimeout(700);
  }
}

const bar = page.locator('[class*="_filterBox_"]').first();
await bar.evaluate(el => el.scrollIntoView({ block: "center" }));

if (FILTERED) { console.log('worst case: two filters on'); await applyWorstCaseFilters(page); }

console.log('  vp    bar    h  shape                                    verdict');
let bad = 0;
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 860 });
  await page.waitForTimeout(350);
  await bar.evaluate(el => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);

  const m = await bar.evaluate(el => {
    const cs = getComputedStyle(el);
    const rowH = Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ctl-h')) || 32);
    const box = el.getBoundingClientRect();
    // The consumer's class lands on the same element as .bar, so the feed's
    // filterBox padding is this element's padding. Measure the content box.
    const padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom);
    const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);

    // Every control the bar is showing, as laid out. Buttons inside an open
    // menu are somebody else's problem - they are allowed to sit over the row.
    //
    // A split chip is one control wearing two buttons, and the layout switch is
    // one wearing three, so the box to test is the outermost match rather than
    // each button: testing the halves would both miss overlaps involving the
    // chip as a whole and report its own two halves as overlapping each other.
    const SEL = 'button, [class*="_splitChip_"], [class*="_switch_"]';
    const all = [...el.querySelectorAll(SEL)].filter(k => !k.closest('[role="menu"]'));
    const controls = all.filter(k =>
      k.getBoundingClientRect().width > 0 &&
      !all.some(o => o !== k && o.contains(k))
    );
    const name = k => (k.getAttribute('aria-label') || k.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 18) || '(glyph)';

    // Not a failure, but worth seeing: which labels have been ellipsised. The
    // bar is allowed to truncate a chip's value - its dropdown says the whole
    // of it - but truncating a control's own name means a threshold is set too
    // low somewhere.
    const trunc = [...el.querySelectorAll('[class*="_chipText_"], [class*="_chipValue_"]')]
      .filter(t => t.scrollWidth - t.clientWidth > 1)
      .map(t => t.textContent.trim().slice(0, 14));

    // Overlap is the failure the row's own scrollWidth cannot see. When .left
    // is squeezed past what its children can give up, they spill out of it and
    // paint straight over .actions - the box never got any wider, so nothing
    // the row can be asked about reports a problem.
    const hits = [];
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
        const over = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (over > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          hits.push(`${name(controls[i])}↔${name(controls[j])} ${Math.round(over)}px`);
        }
      }
    }

    // And the same fault seen from the other side: anything sticking out past
    // the bar's own padding box.
    const spill = Math.max(0, ...controls.map(k => Math.round(k.getBoundingClientRect().right - (box.right - padR))));

    return {
      w: Math.round(box.width),
      h: Math.round(box.height - padT - padB),
      rowH,
      overflow: el.scrollWidth - el.clientWidth,
      hits,
      spill,
      trunc,
      shape: controls.map(name).join(' | '),
    };
  });

  // One line means the bar's content box is no taller than a single control.
  // Anything more and something inside it stacked.
  const wrapped = m.h > m.rowH + 4;
  const overflowed = m.overflow > 1 || m.spill > 1;
  const verdict = wrapped ? 'WRAPPED'
    : m.hits.length ? `OVERLAP ${m.hits.join(', ')}`
    : overflowed ? `OVERFLOW +${Math.max(m.overflow, m.spill)}`
    : m.trunc.length ? 'ok (cut: ' + m.trunc.join(', ') + ')' : 'ok';
  if (wrapped || overflowed || m.hits.length) bad++;
  console.log(
    `${String(width).padStart(4)} ${String(m.w).padStart(6)} ${String(m.h).padStart(4)}  ${m.shape.padEnd(38).slice(0, 38)} ${verdict}`
  );
}

await b.close();
console.log(bad === 0 ? '\nall widths one line, nothing overflowing' : `\n${bad} width(s) failed`);
process.exit(bad === 0 ? 0 : 1);
