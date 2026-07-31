// Captures the marketing screenshots specified in
// client/src/marketing/sections.ts, against a local dev server holding the
// showcase data from `npm run seed-showcase --workspace=server`.
//
//   node scripts/shots.mjs               # every shot
//   node scripts/shots.mjs hero feeds    # just those
//   node scripts/shots.mjs --debug feeds # also dump the page's structure
//   node scripts/shots.mjs --headed      # watch it happen, leave the browser open
//
// Files land in client/public/shots/, which is where `src: '/shots/<id>.png'`
// in marketing/sections.ts points.
//
// Re-seed immediately before capturing. The unread state the hero and feeds
// shots depend on is perishable: the background feed scheduler keeps pulling in
// new items, and every one of those arrives unread.
//
// Captured at deviceScaleFactor 2, so a 1200x800 shot is a 2400x1600 file —
// the frames are viewed on retina displays and the README asks for 2x.
//
// Eight shots for seven specs: `social` cannot satisfy its own spec, which asks
// for the Friends tab and an un-followed Follow button in one frame. ProfilePage
// renders the first only when `profile.isSelf` and the second only when it
// isn't. Both readings are captured — see the two entries at the end of SHOTS.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'client', 'public', 'shots');
const BASE = process.env.SHOTS_BASE || 'http://localhost:5173';
const PASSWORD = process.env.SHOTS_PASSWORD || 'ShowcaseNewt!2026';

const args = process.argv.slice(2);
// --debug dumps each page's structure (text, buttons, classes) so a selector can
// be written against what is actually there. --headed additionally shows the
// browser, and is the one that leaves it open at the end.
const DEBUG = args.includes('--debug');
const HEADED = args.includes('--headed');
const only = args.filter(a => !a.startsWith('--'));

// Size per the spec sheet in marketing/sections.ts.
const SIZES = {
  hero: [1600, 1000],
  bookmarks: [1200, 800],
  feeds: [1200, 800],
  reading: [1200, 900],
  notes: [1400, 900],
  blog: [1200, 900],
  social: [1200, 800],
  'social-friends': [1200, 800],
};

async function signIn(page, username) {
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('yourname').fill(username);
  await page.locator('input[type="password"]').fill(PASSWORD);

  // The auth endpoints allow 20 requests per 15 minutes per IP, and a run that
  // trips it otherwise fails as an opaque selector timeout. Surface it, and
  // wait it out rather than making the caller guess.
  const [res] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/auth/login'), { timeout: 30000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  if (res.status() === 429) {
    const wait = Number(res.headers()['ratelimit-reset'] || 60) + 2;
    console.log(`  rate limited on sign-in; waiting ${wait}s for the window to reset`);
    await page.waitForTimeout(wait * 1000);
    return signIn(page, username);
  }
  if (!res.ok()) throw new Error(`sign-in failed: HTTP ${res.status()}`);
  // Wait for the shell rather than a URL change: signing in leaves the path
  // alone for a beat. The notes launcher is the marker — it only renders once
  // signed in, and it survives navigating to a profile or a post, which the
  // search bar's animated hint (spans, not a placeholder attribute) does not
  // give us a stable handle on.
  await page.getByRole('button', { name: 'Open notes' })
    .waitFor({ state: 'visible', timeout: 45000 });
  await settle(page);
}

/**
 * Track the session-refresh calls a full page load makes.
 *
 * The access token lives in JS memory, so every navigation re-authenticates
 * from the refresh cookie — and /auth/refresh sits behind the same 20-per-15-
 * minutes limiter as /auth/login. When it is refused the app simply renders its
 * signed-out view, which is how a shot of a post came out showing a "Sign in"
 * link where the toolbar should be. Silent, and plausible enough to miss.
 */
function watchAuth(page) {
  const state = { lastRefresh: null, retryAfter: 60 };
  page.on('response', r => {
    if (!r.url().includes('/auth/refresh')) return;
    state.lastRefresh = r.status();
    if (r.status() === 429) state.retryAfter = Number(r.headers()['ratelimit-reset'] || 60);
  });
  return state;
}

/** Assert the signed-in shell is up, waiting out a throttled refresh if needed. */
async function ensureSignedIn(page, auth) {
  const launcher = page.getByRole('button', { name: 'Open notes' });
  try {
    await launcher.waitFor({ state: 'visible', timeout: 10000 });
    return;
  } catch { /* fall through to the retry below */ }

  if (auth.lastRefresh !== 429) {
    throw new Error('signed-in shell never appeared after navigation');
  }
  const wait = auth.retryAfter + 2;
  console.log(`  session refresh rate limited; waiting ${wait}s`);
  await page.waitForTimeout(wait * 1000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await launcher.waitFor({ state: 'visible', timeout: 45000 });
}

/** Navigate, then confirm we are still signed in on the other side. */
async function go(page, url, auth) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await ensureSignedIn(page, auth);
  await settle(page);
}

/** Wait for the network to go quiet and every visible image to have decoded. */
async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(async () => {
    await Promise.all([...document.images]
      .filter(i => !i.complete)
      .map(i => i.decode().catch(() => {})));
    document.documentElement.scrollTop = 0;
  });
  await page.waitForTimeout(ms);
}

/** Blur focus rings and stop the caret blinking, both of which read as noise. */
async function calm(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after { animation-duration: 0s !important;
      animation-delay: 0s !important; transition-duration: 0s !important; }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }`,
  });
}

/**
 * What the frame actually contains, counted from the DOM rather than judged by
 * eye. Each shot's spec names things that must be *visible* — unread outlines,
 * gold favourite chips, a drag overlay — and several of them are subtle enough
 * at a glance to pass a review they should have failed.
 */
async function audit(page) {
  return page.evaluate(() => {
    const inFrame = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    };
    const visible = (sel) => [...document.querySelectorAll(sel)].filter(inFrame);
    // Class names are CSS-module hashed, so match on the readable stem.
    const byStem = (stem) => visible(`[class*="${stem}"]`);
    return {
      brokenImages: [...document.images]
        .filter(i => i.complete && i.naturalWidth === 0).map(i => i.src),
      unreadCards: byStem('_unread_').length,
      favCards: byStem('_favCard_').length,
      favChips: byStem('_favChip_').length + byStem('_favTag_').length,
      dragOverlay: document.querySelectorAll('[class*="_dragOverlay_"], [data-dnd-overlay]').length,
      articleTitles: byStem('_title_').slice(0, 4).map(e => e.textContent.trim().slice(0, 48)),
    };
  });
}

async function shoot(page, id) {
  await calm(page);
  const file = path.join(OUT, `${id}.png`);
  await page.screenshot({ path: file });
  const a = await audit(page);
  console.log(`  ✓ ${id}.png`);
  console.log(`      in frame: ${a.unreadCards} unread, ${a.favCards} favourited card(s), ` +
    `${a.favChips} gold chip(s)`);
  if (a.brokenImages.length) {
    console.log(`      ${a.brokenImages.length} BROKEN image(s):`);
    a.brokenImages.slice(0, 5).forEach(b => console.log(`        ${b.slice(0, 110)}`));
  }
  return file;
}

/** Dump enough structure to write a selector against, when --debug is on. */
async function describe(page, label) {
  if (!DEBUG) return;
  const info = await page.evaluate(() => {
    const seen = new Set();
    const classes = [...document.querySelectorAll('[class]')]
      .flatMap(e => [...e.classList])
      .filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
    return {
      url: location.href,
      text: document.body.innerText.slice(0, 2500),
      buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim() || b.getAttribute('aria-label')).filter(Boolean).slice(0, 60),
      classes: classes.slice(0, 220),
    };
  });
  console.log(`\n──── ${label} ────`);
  console.log(JSON.stringify(info, null, 1).slice(0, 6000));
}

/** Scroll `locator` to `offset` px below the top of the viewport. */
async function scrollTo(page, locator, offset = 90) {
  await locator.evaluate((el, off) => {
    const y = el.getBoundingClientRect().top + window.scrollY - off;
    window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
  }, offset);
  await page.waitForTimeout(500);
}

const centre = (box) => [box.x + box.width / 2, box.y + box.height / 2];

// ── The shots ─────────────────────────────────────────────────────────

// Each entry names the account it is taken from; the runner groups by that and
// signs in once per account. The auth endpoints allow 20 requests per quarter
// hour, and a sign-in per shot burned through that fast enough to start failing
// runs halfway.
//
// Order matters within an account: `notes` types into a real note and the
// editor autosaves, so it goes last.
const SHOTS = {
  // The whole new tab: bookmarks, sidebar, reading list with artwork, an RSS
  // folder carrying unread dots, and an empty search bar.
  hero: { user: 'maren', async run(page) {
    await describe(page, 'hero / new tab');
    await shoot(page, 'hero');
  } },

  // Colour-coded folders and the pinned row are on screen from the start; the
  // part that has to be staged is a tile mid-drag. dnd-kit's PointerSensor
  // arms at 6px of travel, so the pointer goes down, moves in steps, and the
  // capture happens before it ever comes up — that is the only moment the drop
  // gap is open.
  bookmarks: { user: 'maren', async run(page) {
    const from = await page.getByText('Todoist', { exact: true }).boundingBox();
    const to = await page.getByText('Calendar', { exact: true }).last().boundingBox();
    if (!from || !to) throw new Error('could not find the tiles to drag between');

    const [fx, fy] = centre(from);
    const [tx, ty] = centre(to);
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    // Past the activation distance first, then to the gap, so the sensor arms
    // before the big move rather than during it.
    await page.mouse.move(fx + 12, fy + 4, { steps: 5 });
    await page.mouse.move(tx + 30, ty + 6, { steps: 25 });
    await page.waitForTimeout(600);

    await describe(page, 'bookmarks mid-drag');
    await shoot(page, 'bookmarks');
    await page.mouse.up();
  } },

  // The Reading folder's article list. Its unread items and the gold favourite
  // chips are already in the seed; this only has to open the folder and put
  // the list in frame.
  feeds: { user: 'maren', async run(page) {
    await page.getByText('Reading', { exact: true }).first().click();
    await settle(page);

    // FolderArticles labels itself "Feed Articles" — that heading is the top of
    // the section this shot is about, and it sits below the folder's bookmark
    // grid and the reading list.
    // Not an exact match: once loaded the label carries an article count in a
    // child span, so its text is "Feed Articles" followed by a number.
    const heading = page.getByText(/^Feed Articles/).first();
    await heading.waitFor({ state: 'attached', timeout: 20000 });
    await scrollTo(page, heading, 110);

    await describe(page, 'feeds');
    await shoot(page, 'feeds');
  } },

  // Magazine layout. The seed floats a feature-worthy article to the top; this
  // scrolls so the list fills the frame instead of the bookmark grid.
  reading: { user: 'maren', async run(page) {
    // 110px clears the sticky top bar — at a smaller offset the section header
    // slides under it and shows through the translucency as a smear.
    await scrollTo(page, page.getByText('READING LIST').first(), 110);
    await describe(page, 'reading');
    await shoot(page, 'reading');
  } },

  // The post needs four things in one 900px frame: hero, byline, the reference
  // card in the body, and the thread underneath. They only coexist if the hero
  // is cropped to a band at the top, so this scrolls rather than sitting at 0.
  blog: { user: 'maren', async run(page, auth) {
    await go(page, `${BASE}/u/maren/a-homepage-you-actually-chose`, auth);
    // Anchored on the thread, not on the post. The reference card's height
    // follows the artwork of whichever real article the seed picked, so
    // measuring down from the top put the comments below the fold whenever that
    // article happened to have a tall image. Pinning the thread near the bottom
    // instead makes the one thing most easily lost the one thing guaranteed,
    // and lets the hero, byline and card fill whatever is left above it.
    await scrollTo(page, page.getByRole('heading', { name: /^Comments/ }).first(), 790);
    await describe(page, 'blog post');
    await shoot(page, 'blog');
  } },

  // The notes console over the dimmed page, with the slash menu open. Typing
  // "/" on a fresh line is what opens it — see RichEditor's slashOpen.
  notes: { user: 'maren', async run(page) {
    // The launcher button rather than the `n` shortcut: the shortcut stands
    // down whenever focus is in a text field, and after a fresh navigation
    // there is no guarantee about where focus has landed.
    await page.getByRole('button', { name: 'Open notes' }).click();
    await page.waitForTimeout(1200);

    // Maximised. At its default height the console body is ~480px, and the
    // slash menu alone is ~430px of that — so the menu covered the entire note
    // it was supposed to be demonstrating. The dimmed page still shows around
    // the edges, which is what the spec actually asks for.
    await page.getByRole('button', { name: 'Maximize notes' }).click();
    await page.waitForTimeout(700);

    await page.getByText('Homepage rewrite', { exact: false }).first()
      .click({ timeout: 15000 });
    await page.waitForTimeout(900);

    // The note ends with an empty paragraph, so Ctrl+End lands below the
    // reference card with nothing to split — no Enter, which is what used to
    // push the card down under the menu.
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('/', { delay: 120 });
    await page.waitForTimeout(900);

    await describe(page, 'notes');
    await shoot(page, 'notes');
  } },

  // Taken as Theo rather than Maren: the Follow button only has an un-followed
  // state to show when the viewer is somebody else.
  //
  // Note this cannot also show the Friends tab, which the spec asks for in the
  // same breath. ProfilePage only renders that tab when `profile.isSelf` — so
  // "the Friends tab" and "the Follow button un-followed" are mutually
  // exclusive states of one page. `social-friends` below is the other half, so
  // the choice is yours rather than mine.
  social: { user: 'theovance', async run(page, auth) {
    await go(page, `${BASE}/u/maren`, auth);
    // Left at the top deliberately. The profile header runs ~700px and the
    // lead post carries a full-width cover of its own, so a post *title* only
    // comes into an 800px frame at a scroll depth that has already pushed the
    // name and the Follow button up under the toolbar. Identity and the Follow
    // state are what this section is arguing for, so they win; the post count
    // and the Posts tab carry "a few posts".
    await describe(page, 'profile');
    await shoot(page, 'social');
  } },

  // The alternative reading of the same spec: Maren's own profile, where the
  // Friends tab exists. No Follow button here — you cannot follow yourself.
  'social-friends': { user: 'maren', async run(page, auth) {
    await go(page, `${BASE}/u/maren?tab=friends`, auth);
    await describe(page, 'own profile, friends tab');
    await shoot(page, 'social-friends');
  } },
};

const requested = only.length ? only : Object.keys(SHOTS);
const unknown = requested.filter(id => !SHOTS[id]);
unknown.forEach(id => console.log(`  ? no shot called "${id}"`));

// Group by account, preserving the declaration order within each — which is
// what keeps `notes` (the one shot that writes) last.
const byUser = new Map();
for (const id of Object.keys(SHOTS)) {
  if (!requested.includes(id)) continue;
  const user = SHOTS[id].user;
  if (!byUser.has(user)) byUser.set(user, []);
  byUser.get(user).push(id);
}

const browser = await chromium.launch({ headless: !HEADED });
let failures = 0;

for (const [user, shotIds] of byUser) {
  // deviceScaleFactor is fixed for the life of a context, so one context per
  // account and the viewport resized per shot.
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`  [page error] ${String(e).slice(0, 160)}`));
  const auth = watchAuth(page);

  try {
    console.log(`\nsigning in as ${user}`);
    await signIn(page, user);
  } catch (err) {
    console.log(`  ✗ could not sign in as ${user}: ${err.message.split('\n')[0]}`);
    failures += shotIds.length;
    if (!HEADED) await ctx.close();
    continue;
  }

  for (const id of shotIds) {
    const [width, height] = SIZES[id];
    console.log(`${id} (${width}×${height})`);
    try {
      await page.setViewportSize({ width, height });
      // Back to a known state — the previous shot may have left the page
      // scrolled, a folder open, or the notes console up.
      await go(page, BASE, auth);
      await SHOTS[id].run(page, auth);
    } catch (err) {
      console.log(`  ✗ ${id}: ${err.message.split('\n')[0]}`);
      failures++;
    }
  }

  if (!HEADED) await ctx.close();
}

console.log(failures ? `\n${failures} shot(s) failed.` : '\nAll shots captured.');
if (!HEADED) await browser.close();
process.exit(failures ? 1 : 0);
