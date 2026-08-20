import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { ensureFeeds, refreshStaleFeeds } from '../lib/feedRefresh';
import { syncBookmarkBadges } from '../lib/unread';
import { canonicalFeedKey } from '../lib/feedUtils';
import { resolveFeedUrl } from '../lib/feedDiscovery';
import { isSafeUrl } from '../lib/isSafeUrl';
import { blockedRuleFor, blockedMessage } from '../lib/feedBlocklist';
import { perUserLimiter } from '../lib/rateLimit';
import { toTsQuery, MIN_QUERY_LEN } from '../lib/feedSearch';
import { SUGGESTED_FEEDS, SUGGESTED_CATEGORIES } from '../lib/suggestedFeeds';
import {
  SUBSCRIPTION_SELECT, FEED_FOLDER_SELECT,
  MAX_FEEDS_PER_USER, MAX_FEED_FOLDERS, MAX_FEED_URL, MAX_FEED_NAME,
} from '../lib/feedSubscriptions';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// Adding a feed makes the server fetch an address of the user's choosing, and
// discovery can cost several requests per attempt. Metered per account so it
// survives IP rotation, the way the bookmark and comment limits do.
const feedWriteLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 240,
  message: 'Too many feed changes — please slow down for a moment.',
});
router.use((req, res, next) => {
  if (req.method === 'GET') { next(); return; }
  feedWriteLimiter(req, res, next);
});

function normalizeFeedUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url || url.length > MAX_FEED_URL) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch { return null; }
}

// How long a batch add will wait for its feeds to fetch before answering
// anyway. Long enough that a handful of ordinary feeds are populated by the
// time the picker closes; short enough that one dead origin can't stall it.
const WARMUP_MS = 6000;

// How recently a feed must have been checked for the Refresh button to leave it
// alone. Short enough that pressing it after a few minutes away really does go
// and look; long enough that repeated presses cost nothing.
const REFRESH_MIN_AGE_MS = 60_000;

const P2002 = 'P2002';
function isDuplicate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === P2002;
}

// Confirms a category belongs to this user. `undefined` means "not supplied",
// `null` means Uncategorised — a real destination, not a missing one — so the
// two can't be collapsed.
async function resolveFeedFolder(userId: string, raw: unknown): Promise<string | null | 'invalid'> {
  if (raw === null || raw === '' || raw === undefined) return null;
  if (typeof raw !== 'string') return 'invalid';
  const folder = await prisma.feedFolder.findFirst({
    where: { id: raw, userId },
    select: { id: true },
  });
  return folder ? folder.id : 'invalid';
}

// ── The subscription list ────────────────────────────────────────────────────

// Everything the manager and the filter bar need in one call: the categories,
// the subscriptions, and — for each — the shared Feed's own title and health, so
// a feed that has stopped returning anything can say so.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const [folders, subs] = await Promise.all([
    prisma.feedFolder.findMany({
      where: { userId: req.userId! },
      orderBy: { position: 'asc' },
      select: FEED_FOLDER_SELECT,
    }),
    prisma.feedSubscription.findMany({
      where: { userId: req.userId! },
      orderBy: { position: 'asc' },
      select: SUBSCRIPTION_SELECT,
    }),
  ]);

  // Resolved against the shared Feed table by canonical key, so the manager can
  // show the publisher's own title without a fetch of its own.
  const keys = [...new Set(subs.map(s => canonicalFeedKey(s.url)))];
  const feeds = keys.length === 0 ? [] : await prisma.feed.findMany({
    where: { canonicalKey: { in: keys } },
    select: { canonicalKey: true, title: true, lastCheckedAt: true },
  });
  const byKey = new Map(feeds.map(f => [f.canonicalKey, f]));

  res.json({
    folders,
    subscriptions: subs.map(s => {
      const feed = byKey.get(canonicalFeedKey(s.url));
      return {
        ...s,
        title: feed?.title ?? '',
        lastCheckedAt: feed?.lastCheckedAt ?? null,
      };
    }),
  });
});

// Bookmarks whose site has a feed the user isn't subscribed to. This is the
// "import from your bookmarks" list: discovery already ran when the bookmark was
// added, so this costs nothing but a query.
router.get('/importable', async (req: AuthRequest, res: Response): Promise<void> => {
  const [bookmarks, subs] = await Promise.all([
    prisma.bookmark.findMany({
      where: { userId: req.userId!, NOT: { feedUrl: null } },
      orderBy: { position: 'asc' },
      select: { id: true, name: true, domain: true, feedUrl: true },
    }),
    prisma.feedSubscription.findMany({
      where: { userId: req.userId! },
      select: { url: true },
    }),
  ]);
  const subscribed = new Set(subs.map(s => canonicalFeedKey(s.url)));
  res.json(
    bookmarks
      .filter(b => !subscribed.has(canonicalFeedKey(b.feedUrl!)))
      .map(b => ({ id: b.id, name: b.name, domain: b.domain, feedUrl: b.feedUrl! }))
  );
});

// The curated list, minus anything already subscribed to.
//
// One list, sent whole: the first-run picker and the manager's Discover tab both
// draw all of it, from a single fetch.
router.get('/suggested', async (req: AuthRequest, res: Response): Promise<void> => {
  const subs = await prisma.feedSubscription.findMany({
    where: { userId: req.userId! },
    select: { url: true },
  });
  const subscribed = new Set(subs.map(s => canonicalFeedKey(s.url)));
  res.json({
    categories: SUGGESTED_CATEGORIES,
    feeds: SUGGESTED_FEEDS.filter(f => !subscribed.has(canonicalFeedKey(f.url))),
  });
});

/**
 * Subscribe to a feed.
 *
 * `url` is whatever the user typed — a feed, a site's front page, or a bare
 * hostname. It is resolved and verified before anything is written, so the
 * failure mode is an explanation ("No feed found at example.com") rather than a
 * subscription that silently never produces an article. Pass `skipValidation`
 * for URLs the server itself vouched for (the suggested list, a bookmark's
 * already-discovered feed) to save the round trip.
 */
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl || rawUrl.length > MAX_FEED_URL) {
    res.status(400).json({ error: 'A feed or site address is required' });
    return;
  }

  const feedFolderId = await resolveFeedFolder(req.userId!, body.feedFolderId);
  if (feedFolderId === 'invalid') { res.status(404).json({ error: 'That category no longer exists' }); return; }

  try {
    const count = await prisma.feedSubscription.count({ where: { userId: req.userId! } });
    if (count >= MAX_FEEDS_PER_USER) {
      res.status(400).json({ error: `You can follow up to ${MAX_FEEDS_PER_USER} feeds` });
      return;
    }

    let url: string;
    let discoveredTitle = '';
    // Whether the address still has to be run past the SSRF gate. The discovery
    // branch below does it inside resolveFeedUrl; the skipValidation branch has
    // nothing that would.
    let needsAddressCheck = false;
    if (body.skipValidation === true) {
      const normalized = normalizeFeedUrl(rawUrl);
      if (!normalized) { res.status(400).json({ error: 'A valid http(s) feed URL is required' }); return; }
      url = normalized;
      needsAddressCheck = true;
    } else {
      const resolved = await resolveFeedUrl(rawUrl);
      if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }
      url = resolved.url;
      discoveredTitle = resolved.title;
    }

    // Checked against the *resolved* address, after discovery has followed
    // wherever the typed one led. Gating on the raw input instead would let a
    // shortener or a redirect through a clean host walk straight past the rule.
    // skipValidation URLs are checked too — the server vouched for those being
    // real feeds, not for them being permitted ones.
    const blocked = await blockedRuleFor(url);
    if (blocked) { res.status(403).json({ error: blockedMessage(blocked) }); return; }

    // skipValidation skips *discovery*, not the address check. Discovery is
    // where resolveFeedUrl applies the SSRF gate, so taking that branch was a
    // way to store "http://127.0.0.1:9200/" as a subscription and have the
    // scheduler poll it from then on. The flag means "I already know the feed
    // address, don't go looking"; it was never meant to mean "and don't check
    // where it points".
    //
    // After the blocklist, not before: this one resolves DNS, and a blocked
    // domain should be turned away on the rule rather than on whether it
    // happens to be up.
    if (needsAddressCheck && !(await isSafeUrl(url))) {
      res.status(400).json({ error: "That address can't be reached" }); return;
    }

    // The unique index is on the literal URL, but "the same feed spelled
    // differently" is still the same feed — and the whole point of resolving
    // above is that two people typing "npr.org" and the real feed URL land in
    // the same place. Check canonically before writing.
    const key = canonicalFeedKey(url);
    const existing = await prisma.feedSubscription.findMany({
      where: { userId: req.userId! },
      select: { id: true, url: true },
    });
    if (existing.some(s => canonicalFeedKey(s.url) === key)) {
      res.status(409).json({ error: "You're already following that feed" });
      return;
    }

    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, MAX_FEED_NAME)
      : '';

    const sub = await prisma.feedSubscription.create({
      data: { userId: req.userId!, url, name, position: count, feedFolderId },
      select: SUBSCRIPTION_SELECT,
    });

    // Pull it into the shared Feed table now so the first render of the river
    // isn't missing the thing that was just added.
    ensureFeeds([url]).then(feeds => refreshStaleFeeds(feeds)).catch(() => {});

    res.status(201).json({ ...sub, title: discoveredTitle, lastCheckedAt: null });
  } catch (err) {
    if (isDuplicate(err)) { res.status(409).json({ error: "You're already following that feed" }); return; }
    logger.error(err, 'Add feed error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Subscribe to several at once — the first-run picker and the bookmark import
// both hand over a list. Reports per-URL outcomes rather than failing the batch:
// one dead address in a list of ten shouldn't cost the other nine.
router.post('/batch', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.feeds;
  if (!Array.isArray(raw) || raw.length === 0) {
    res.status(400).json({ error: 'feeds must be a non-empty array' });
    return;
  }
  if (raw.length > 50) { res.status(400).json({ error: 'Too many feeds at once' }); return; }

  type Incoming = { url?: unknown; name?: unknown; category?: unknown; feedFolderId?: unknown };
  const items = raw as Incoming[];

  try {
    const [existing, ownFolders] = await Promise.all([
      prisma.feedSubscription.findMany({ where: { userId: req.userId! }, select: { url: true } }),
      prisma.feedFolder.findMany({ where: { userId: req.userId! }, select: { id: true, name: true } }),
    ]);
    const seen = new Set(existing.map(s => canonicalFeedKey(s.url)));
    let position = existing.length;

    // `category` is a name, not an id: the first-run picker offers categories
    // that don't exist yet ("Tech", "News"), and making the client create them
    // first would mean a half-finished set of empty categories if it stopped
    // halfway. Matched case-insensitively against what the user already has so a
    // second import doesn't produce "Tech" twice.
    const folderIdByName = new Map(ownFolders.map(f => [f.name.toLowerCase(), f.id]));
    let folderCount = ownFolders.length;

    const added: unknown[] = [];
    const skipped: { url: string; reason: string }[] = [];

    for (const item of items) {
      const url = normalizeFeedUrl(item.url);
      if (!url) { skipped.push({ url: String(item.url ?? ''), reason: 'Not a valid address' }); continue; }
      if (position >= MAX_FEEDS_PER_USER) { skipped.push({ url, reason: 'Feed limit reached' }); continue; }

      const key = canonicalFeedKey(url);
      if (seen.has(key)) { skipped.push({ url, reason: 'Already following' }); continue; }

      // Reported per URL like every other rejection here — one blocked address
      // in an OPML import shouldn't cost the other forty-nine.
      const blocked = await blockedRuleFor(url);
      if (blocked) { skipped.push({ url, reason: blockedMessage(blocked) }); continue; }

      let feedFolderId: string | null = null;
      if (typeof item.feedFolderId === 'string' && item.feedFolderId) {
        const owned = ownFolders.find(f => f.id === item.feedFolderId);
        if (owned) feedFolderId = owned.id;
      } else if (typeof item.category === 'string' && item.category.trim()) {
        const catName = item.category.trim().slice(0, 100);
        const hit = folderIdByName.get(catName.toLowerCase());
        if (hit) {
          feedFolderId = hit;
        } else if (folderCount < MAX_FEED_FOLDERS) {
          const created = await prisma.feedFolder.create({
            data: {
              userId: req.userId!,
              name: catName,
              color: colorForCategory(catName),
              position: folderCount,
            },
            select: FEED_FOLDER_SELECT,
          });
          feedFolderId = created.id;
          folderIdByName.set(catName.toLowerCase(), created.id);
          folderCount++;
        }
      }

      const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_FEED_NAME) : '';
      try {
        const sub = await prisma.feedSubscription.create({
          data: { userId: req.userId!, url, name, position, feedFolderId },
          select: SUBSCRIPTION_SELECT,
        });
        added.push(sub);
        seen.add(key);
        position++;
      } catch (err) {
        if (isDuplicate(err)) { skipped.push({ url, reason: 'Already following' }); continue; }
        throw err;
      }
    }

    // Warm the new feeds up before answering, but never hang on them.
    //
    // This is what the first-run picker calls, so the very next thing that
    // happens is the user looking at their feed. Fire-and-forget left them on an
    // empty one for the few seconds the fetches took — the worst possible first
    // impression, and indistinguishable from the thing being broken. Waiting
    // unboundedly is no good either (a dozen slow origins would hold the
    // request open), so it waits up to WARMUP_MS and then lets the rest finish
    // in the background, where the next page load will pick them up.
    const urls = (added as { url: string }[]).map(s => s.url);
    if (urls.length > 0) {
      const warmup = ensureFeeds(urls).then(feeds => refreshStaleFeeds(feeds)).catch(() => {});
      await Promise.race([warmup, new Promise(resolve => setTimeout(resolve, WARMUP_MS))]);
    }

    res.status(201).json({ added, skipped });
  } catch (err) {
    logger.error(err, 'Batch feed add error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Keeps the suggested categories looking like themselves when created by name.
function colorForCategory(name: string): string {
  const known = SUGGESTED_CATEGORIES.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (known) return known.color;
  const PALETTE = ['#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
    '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Rename a feed, re-point it at a different URL, or move it to another category.
// The row survives all three, which is the reason it exists: a feed that moves
// or changes address is still the same subscription, and keeps its name.
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const existing = await prisma.feedSubscription.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true, url: true },
    });
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

    const data: Record<string, unknown> = {};

    if ('name' in body) {
      if (typeof body.name !== 'string') { res.status(400).json({ error: 'name must be a string' }); return; }
      data.name = body.name.trim().slice(0, MAX_FEED_NAME);
    }

    if ('url' in body) {
      const url = normalizeFeedUrl(body.url);
      if (!url) { res.status(400).json({ error: 'A valid http(s) feed URL is required' }); return; }
      data.url = url;
    }

    if ('feedFolderId' in body) {
      const folderId = await resolveFeedFolder(req.userId!, body.feedFolderId);
      if (folderId === 'invalid') { res.status(404).json({ error: 'That category no longer exists' }); return; }
      data.feedFolderId = folderId;
    }

    if (Object.keys(data).length === 0) { res.json({ ok: true }); return; }

    const sub = await prisma.feedSubscription.update({
      where: { id: existing.id },
      data,
      select: SUBSCRIPTION_SELECT,
    });

    if (typeof data.url === 'string' && data.url !== existing.url) {
      ensureFeeds([data.url]).then(feeds => refreshStaleFeeds(feeds)).catch(() => {});
    }

    res.json(sub);
  } catch (err) {
    if (isDuplicate(err)) { res.status(409).json({ error: "You're already following that feed" }); return; }
    logger.error(err, 'Update feed error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await prisma.feedSubscription.deleteMany({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Delete feed error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Categories ───────────────────────────────────────────────────────────────

router.post('/folders', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) { res.status(400).json({ error: 'A name is required' }); return; }

  const count = await prisma.feedFolder.count({ where: { userId: req.userId! } });
  if (count >= MAX_FEED_FOLDERS) {
    res.status(400).json({ error: `You can have up to ${MAX_FEED_FOLDERS} categories` });
    return;
  }
  const color = typeof body.color === 'string' && body.color ? body.color.slice(0, 32) : colorForCategory(name);

  const folder = await prisma.feedFolder.create({
    data: { userId: req.userId!, name, color, position: count },
    select: FEED_FOLDER_SELECT,
  });
  res.status(201).json(folder);
});

router.patch('/folders/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 100);
  if (typeof body.color === 'string' && body.color) data.color = body.color.slice(0, 32);
  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

  const result = await prisma.feedFolder.updateMany({
    where: { id: req.params.id, userId: req.userId! },
    data,
  });
  if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});

// Deleting a category never unsubscribes you from what was in it — the feeds
// fall back to Uncategorised (ON DELETE SET NULL). Returns their ids so the
// client can re-file them without a refetch.
router.delete('/folders/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const folder = await prisma.feedFolder.findFirst({
    where: { id: req.params.id, userId: req.userId! },
    select: { id: true },
  });
  if (!folder) { res.status(404).json({ error: 'Not found' }); return; }

  const orphans = await prisma.feedSubscription.findMany({
    where: { feedFolderId: folder.id },
    select: { id: true },
  });
  await prisma.feedFolder.delete({ where: { id: folder.id } });
  res.json({ ok: true, uncategorizedIds: orphans.map(o => o.id) });
});

router.put('/folders/reorder', async (req: AuthRequest, res: Response): Promise<void> => {
  const items = req.body;
  if (!Array.isArray(items)) { res.status(400).json({ error: 'Array expected' }); return; }
  await prisma.$transaction(
    (items as { id: string; position: number }[]).map(({ id, position }) =>
      prisma.feedFolder.updateMany({ where: { id, userId: req.userId! }, data: { position } })
    )
  );
  res.json({ ok: true });
});

// Admin-only: force-refreshing every feed fans one action out into many
// outbound requests, so it stays behind requireAdmin to avoid abuse and
// amplification.
router.post('/refresh-all', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const rows = await prisma.feedSubscription.findMany({
    where: { userId: req.userId! },
    select: { url: true },
  });
  if (rows.length === 0) { res.json({ refreshed: 0 }); return; }
  const feeds = await ensureFeeds(rows.map(r => r.url));
  // Force regardless of staleness — this is an explicit user action. Still
  // claim-protected and concurrency-limited inside refreshStaleFeeds.
  await refreshStaleFeeds(feeds, { force: true });
  res.json({ refreshed: feeds.length });
});

// ── The river ────────────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Resolves the subscriptions in scope for a request. `folder` narrows to one
// category ('none' = Uncategorised); absent means everything, which is the
// point of the unified feed.
/**
 * One page of the river: one row per story, newest first.
 *
 * ── One card per story ──
 * Two feeds carrying the same article is ordinary, not exceptional: an
 * aggregator links to a piece you also follow directly, or one publisher is
 * reachable at two feed addresses (arstechnica.com/feed and
 * feeds.arstechnica.com/arstechnica/index are different subscriptions dealing
 * identical items). Each is its own FeedItem row — they have to be, since items
 * are shared and read state hangs off them — so the river would deal the story
 * once per feed.
 *
 * `linkKey` is the canonical article URL, the same key comments thread on, so it
 * identifies the story rather than the route it arrived by. It is NOT NULL
 * precisely so this cannot collapse the key-less rows together; see the column
 * note in schema.prisma.
 *
 * ── Why this is raw SQL and not `distinct: ['linkKey']` ──
 * Because Prisma's `distinct` is not a SQL DISTINCT. It emits the plain SELECT
 * with an OFFSET and **no LIMIT**, reads the entire remainder of the table into
 * the process, and dedupes and slices there. Measured on a 38-feed dev account:
 * rendering ten cards shipped **4,198 rows and 11.7MB** out of Postgres, 7.3MB
 * of which was the `content` column — full article HTML that this endpoint does
 * not even return. Every feed load and every "load more" paid it, and it grows
 * with the account.
 *
 * `DISTINCT ON` does it in the database and returns the ten rows asked for.
 * Postgres requires the ORDER BY of a DISTINCT ON to lead with the distinct
 * expression, which is why this is a subquery: the inner sort picks *which copy
 * of each story survives*, the outer one orders the river.
 *
 * The inner order is the surviving copy rule, unchanged: the most recent time
 * the story surfaced. Keeping the *earliest* copy would file a story that
 * resurfaced this morning back at its original date, halfway down the feed.
 * `firstSeenAt` is the tiebreak rather than `fetchedAt` because fetchedAt is
 * rewritten on every poll (and en masse on a 304), which made the winner flip
 * between refreshes — the card swapped its title and source, and a story you had
 * read came back unread. `id` settles the rest, so the choice is total and
 * stable.
 *
 * Only the columns the response actually uses are selected. `content` is the
 * big one and is never returned here.
 */
interface StoryRow {
  id: string;
  feedId: string;
  title: string;
  link: string;
  pubDate: Date | null;
  fetchedAt: Date;
  firstSeenAt: Date;
  readTime: number | null;
  snippet: string | null;
  imageUrl: string | null;
  categories: string[];
}

async function storyPage(
  userId: string,
  feedIds: string[],
  includeDismissed: boolean,
  offset: number,
  limit: number,
): Promise<StoryRow[]> {
  if (feedIds.length === 0) return [];
  return prisma.$queryRaw<StoryRow[]>`
    SELECT s."id", s."feedId", s."title", s."link", s."pubDate", s."fetchedAt",
           s."readTime", s."snippet", s."imageUrl", s."categories"
    FROM (
      SELECT DISTINCT ON (i."linkKey")
             i."id", i."feedId", i."title", i."link", i."pubDate", i."fetchedAt",
             i."firstSeenAt", i."readTime", i."snippet", i."imageUrl", i."categories"
      FROM "FeedItem" i
      WHERE i."feedId" = ANY(${feedIds}::text[])
        AND (${includeDismissed}::boolean OR NOT EXISTS (
          SELECT 1 FROM "DismissedFeedItem" d
          WHERE d."userId" = ${userId} AND d."itemId" = i."id"))
      ORDER BY i."linkKey", i."pubDate" DESC, i."firstSeenAt" DESC, i."id" ASC
    ) s
    -- firstSeenAt, never fetchedAt. fetchedAt is rewritten on every poll and en
    -- masse on a 304, so ordering the river by it would reshuffle the cards
    -- under the reader each time the scheduler ran. It is carried out of the
    -- subquery for this sort alone; the response does not return it.
    ORDER BY s."pubDate" DESC, s."firstSeenAt" DESC, s."id" ASC
    OFFSET ${offset} LIMIT ${limit}
  `;
}

// ── Counting stories rather than rows ────────────────────────────────────────
//
// The river shows one card per `linkKey` (see storyPage above), so its totals
// have to count keys, not FeedItem rows, or the counts describe a feed nobody is
// looking at: "Load more · 40 remaining" for 31 articles, and an Unread chip
// permanently ahead of the list beneath it.
//
// `COUNT(DISTINCT …)` is the one thing Prisma cannot express - `count()` takes
// no `distinct`, and doing it through `groupBy`/`findMany` means shipping one
// row per story to the process to call `.length` on.
//
// Both counts assume read and dismissed state is uniform across the copies of a
// story, which is what storyItemIds() below guarantees.
// Both numbers in one pass. They were two calls differing only in whether the
// read filter applied, which meant scanning every item in every one of the
// user's feeds twice per request - and a third time for the page itself. An
// aggregate FILTER answers the second from the same scan.
async function countStories(
  userId: string,
  feedIds: string[],
  includeDismissed: boolean,
): Promise<{ total: number; unread: number }> {
  if (feedIds.length === 0) return { total: 0, unread: 0 };
  const rows = await prisma.$queryRaw<{ total: bigint; unread: bigint }[]>`
    SELECT COUNT(DISTINCT i."linkKey") AS total,
           COUNT(DISTINCT i."linkKey") FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM "ReadFeedItem" r
               WHERE r."userId" = ${userId} AND r."itemId" = i."id")
           ) AS unread
    FROM "FeedItem" i
    WHERE i."feedId" = ANY(${feedIds}::text[])
      AND (${includeDismissed}::boolean OR NOT EXISTS (
        SELECT 1 FROM "DismissedFeedItem" d
        WHERE d."userId" = ${userId} AND d."itemId" = i."id"))
  `;
  return {
    total: Number(rows[0]?.total ?? 0),
    unread: Number(rows[0]?.unread ?? 0),
  };
}

/**
 * Stories whose *every* copy arrived after `since` — what "new since you
 * loaded" means once the river is deduped.
 *
 * The `MIN(firstSeenAt) > since` is the whole point of grouping here rather than
 * counting rows: an article you have had all week, arriving a second time
 * through another feed, is not news. Counting rows would announce it, and then
 * nothing would visibly change when the reader pressed the pill, because
 * dedupe would fold it straight back into the card already on screen.
 */
async function countNewStories(userId: string, feedIds: string[], since: Date): Promise<number> {
  if (feedIds.length === 0) return 0;
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM (
      SELECT i."linkKey"
      FROM "FeedItem" i
      WHERE i."feedId" = ANY(${feedIds}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM "DismissedFeedItem" d
          WHERE d."userId" = ${userId} AND d."itemId" = i."id")
      GROUP BY i."linkKey"
      HAVING MIN(i."firstSeenAt") > ${since}
    ) fresh
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Every row that is the same story as the given ones, the given ones included.
 *
 * Read and dismissed state hangs off a FeedItem, but a FeedItem is one feed's
 * copy of an article and the river now shows one card for all of them. Without
 * this, dismissing that card would hide the copy you pressed and promote its
 * twin into the same slot on the next load - the story would come back, once,
 * for no reason the reader could see. Marking read had the quieter version of
 * the same fault: the Unread chip counted a story that the list showed as read.
 *
 * Deliberately not scoped to the feeds this user follows. "I'm done with this"
 * is about the article, and if they subscribe to something else carrying it
 * next month they still are.
 */
async function storyItemIds(itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const rows = await prisma.feedItem.findMany({
    where: { id: { in: itemIds } },
    select: { linkKey: true },
  });
  const linkKeys = [...new Set(rows.map(r => r.linkKey))];
  if (linkKeys.length === 0) return itemIds;
  const siblings = await prisma.feedItem.findMany({
    where: { linkKey: { in: linkKeys } },
    select: { id: true },
  });
  return [...new Set([...itemIds, ...siblings.map(s => s.id)])];
}

async function scopedFeeds(userId: string, folderParam: unknown) {
  const where: { userId: string; feedFolderId?: string | null } = { userId };
  if (typeof folderParam === 'string' && folderParam && folderParam !== 'all') {
    where.feedFolderId = folderParam === 'none' ? null : folderParam;
  }
  const subs = await prisma.feedSubscription.findMany({
    where,
    orderBy: { position: 'asc' },
    select: { url: true, name: true, feedFolderId: true },
  });
  return subs;
}

// ── Search ───────────────────────────────────────────────────────────────────

// Metered even though it's a GET, which the write limiter above deliberately
// lets through. Search is the one read a user can fire on every keystroke, and
// each one is a GIN lookup; the client debounces, but the client is not the
// thing to trust about how often the server is asked.
const searchLimiter = perUserLimiter({
  windowMs: 60_000, max: 120,
  message: 'Too many searches — please slow down for a moment.',
});

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 25;

/** `%` and `_` are wildcards to LIKE; a tag containing one should match itself. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

/**
 * The feeds this user subscribes to, and nothing else.
 *
 * **This is the whole boundary between "search my feeds" and "search Newt's
 * database", so it is worth being blunt about.** Feed and FeedItem rows are
 * shared across every account on the instance — that is the point of the
 * design, one fetch per feed no matter how many people follow it — which means
 * FeedItem carries no userId to filter on and a query that forgets to scope by
 * feed silently searches every article anyone here has ever ingested. That is a
 * disclosure bug and a spam surface at once: it would let anyone read the
 * contents of feeds they don't follow, and let a subscriber to one junk feed
 * inject results into everybody's search box.
 *
 * Scoping therefore starts from FeedSubscription, which *is* per-user, and the
 * feed ids it resolves to are the only ones any search query is allowed to see.
 *
 * Read-only on purpose: unlike the river's loader this does not call
 * ensureFeeds(). Searching is not a reason to create Feed rows, mark demand, or
 * kick off a refresh — a search should never be the thing that causes an
 * outbound fetch.
 */
async function subscribedFeeds(userId: string) {
  const subs = await prisma.feedSubscription.findMany({
    where: { userId },
    select: { url: true, name: true },
  });
  if (subs.length === 0) return { feedIds: [], feedById: new Map(), subByKey: new Map() };

  const subByKey = new Map(subs.map(s => [canonicalFeedKey(s.url), s]));
  const feeds = await prisma.feed.findMany({
    where: { canonicalKey: { in: [...subByKey.keys()] } },
    select: { id: true, fetchUrl: true, title: true },
  });
  return {
    feedIds: feeds.map(f => f.id),
    feedById: new Map(feeds.map(f => [f.id, f])),
    subByKey,
  };
}

type SearchRow = {
  id: string;
  title: string;
  link: string;
  feedId: string;
  pubDate: Date | null;
  categories: string[];
  rank: number;
};

/**
 * Search across everything the user follows — the whole archive, not the page
 * the reader happens to be looking at.
 *
 * `mode=tag` matches the article's categories instead of its text, which is what
 * the search box's `#tag` prefix asks for.
 *
 * Dismissed articles are included. Dismissing is "I'm done with this" said to a
 * river flowing past; typing a search is going and looking for one specific
 * thing, and answering "you waved that away in March" with silence is how a
 * search box loses someone's trust.
 */
router.get('/search', searchLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const raw   = typeof req.query.q === 'string' ? req.query.q : '';
  const tagged = req.query.mode === 'tag';
  const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1,
    parseInt(req.query.limit as string || '') || SEARCH_LIMIT_DEFAULT));

  try {
    const trimmed = raw.trim();
    // Guarded before any query: a one-character prefix search matches a large
    // share of the corpus and is never what someone means.
    if (trimmed.length < MIN_QUERY_LEN) { res.json({ articles: [] }); return; }

    const tsq = tagged ? null : toTsQuery(trimmed);
    if (!tagged && !tsq) { res.json({ articles: [] }); return; }

    const { feedIds, feedById, subByKey } = await subscribedFeeds(req.userId!);
    if (feedIds.length === 0) { res.json({ articles: [] }); return; }

    // One row per story, not per copy — the same dedupe the river does, and for
    // the same reason: two feeds carrying one article is ordinary, and a result
    // list that shows it twice looks broken. DISTINCT ON needs linkKey to lead
    // the inner sort, so the ranking sort has to happen in an outer query.
    // Against the archive, not the river.
    //
    // Two things fall out of that, both good. The corpus is years deep rather
    // than the fortnight FeedItem holds — which is what this route always
    // claimed in its own docblock ("the whole archive") and could not deliver.
    // And the DISTINCT ON is gone: the archive is keyed on articleKey, so one
    // article is one row and the dedupe happened at write time. That removes a
    // full sort of every matching row from a query whose LIMIT is applied last
    // and so could never short-circuit it — the one thing that would otherwise
    // have made a deeper corpus feel slower rather than better.
    //
    // Scoped through ArticleArchiveFeed. The archive is deduped instance-wide,
    // so without the join a search would answer with articles from feeds the
    // reader has never subscribed to. The scalar subquery picks which of the
    // reader's own feeds to attribute it to; the EXISTS guarantees there is one.
    const rows = tagged
      ? await prisma.$queryRaw<SearchRow[]>`
          SELECT a."articleKey" AS "id", a."title", a."link", a."pubDate", a."categories",
                 0::real AS "rank",
                 (SELECT f."feedId" FROM "ArticleArchiveFeed" f
                   WHERE f."articleKey" = a."articleKey"
                     AND f."feedId" = ANY(${feedIds}::text[]) LIMIT 1) AS "feedId"
          FROM "ArticleArchive" a
          WHERE EXISTS (SELECT 1 FROM "ArticleArchiveFeed" f
                         WHERE f."articleKey" = a."articleKey"
                           AND f."feedId" = ANY(${feedIds}::text[]))
            AND EXISTS (
              SELECT 1 FROM unnest(a."categories") c
              WHERE c ILIKE ${escapeLike(trimmed) + '%'} ESCAPE '\\')
          ORDER BY a."pubDate" DESC NULLS LAST
          LIMIT ${limit}`
      : await prisma.$queryRaw<SearchRow[]>`
          SELECT a."articleKey" AS "id", a."title", a."link", a."pubDate", a."categories",
                 ts_rank(a."searchVector", to_tsquery('english', ${tsq})) AS "rank",
                 (SELECT f."feedId" FROM "ArticleArchiveFeed" f
                   WHERE f."articleKey" = a."articleKey"
                     AND f."feedId" = ANY(${feedIds}::text[]) LIMIT 1) AS "feedId"
          FROM "ArticleArchive" a
          WHERE EXISTS (SELECT 1 FROM "ArticleArchiveFeed" f
                         WHERE f."articleKey" = a."articleKey"
                           AND f."feedId" = ANY(${feedIds}::text[]))
            AND a."searchVector" @@ to_tsquery('english', ${tsq})
          -- Relevance first, recency only to settle ties. A local paper and a
          -- national one both matching "school closures" should be separated by
          -- how well they match, not by which polled most recently.
          ORDER BY "rank" DESC, a."pubDate" DESC NULLS LAST
          LIMIT ${limit}`;

    // Same naming ladder as the river, so a result and the card it corresponds
    // to are attributed identically: the subscription's own name, then the
    // publisher's title, then the hostname.
    const articles = rows.map(r => {
      const feed = feedById.get(r.feedId);
      const sub  = feed ? subByKey.get(canonicalFeedKey(feed.fetchUrl)) : undefined;
      return {
        id: r.id,
        title: r.title,
        url: r.link,
        source: sub?.name || feed?.title || hostOf(feed?.fetchUrl ?? ''),
        categories: r.categories,
        pubDate: r.pubDate,
      };
    });

    res.json({ articles });
  } catch (err) {
    logger.error(err, 'Feed search error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/articles', async (req: AuthRequest, res: Response): Promise<void> => {
  const offset     = Math.max(0, parseInt(req.query.offset as string || '0') || 0);
  const limit      = Math.min(200, Math.max(1, parseInt(req.query.limit as string || '10') || 10));
  const includeAll = req.query.includeAll === 'true';
  // Stamped before the query, not after: anything that lands between here and
  // the read is genuinely not in this response, and the client will be told
  // about it by /articles/new-count rather than silently missing it.
  const loadedAt   = new Date();

  try {
    const subs = await scopedFeeds(req.userId!, req.query.folder);
    if (subs.length === 0) {
      res.json({ articles: [], total: 0, unread: 0, hasMore: false, loadedAt: loadedAt.toISOString() });
      return;
    }

    const feeds = await ensureFeeds(subs.map(s => s.url));
    const neverFetched = feeds.some(f => !f.lastCheckedAt);
    if (neverFetched) {
      // First load of at least one feed — wait so the user doesn't see an empty list
      await refreshStaleFeeds(feeds);
    } else {
      // Data exists — serve immediately, refresh stale feeds behind the scenes
      refreshStaleFeeds(feeds).catch(() => {});
    }

    // A subscription's own name wins over the publisher's title, and its
    // category rides along on every article: the filter bar groups by both
    // without a second request.
    const subByKey = new Map(subs.map(s => [canonicalFeedKey(s.url), s]));
    const feedById = new Map(feeds.map(f => [f.id, f]));

    const feedIds = feeds.map(f => f.id);
    // `unread` spans the whole river, not the page being returned. The client
    // shows it on the Unread filter chip, which sits next to site tiles whose
    // badges are counted the same way (see lib/unread.ts) — a chip counting only
    // the ten loaded articles would say "1" beside a tile saying "19".
    const [items, { total, unread }] = await Promise.all([
      storyPage(req.userId!, feedIds, includeAll, offset, limit),
      countStories(req.userId!, feedIds, includeAll),
    ]);

    const reads = await prisma.readFeedItem.findMany({
      where: { userId: req.userId!, itemId: { in: items.map(i => i.id) } },
      select: { itemId: true },
    });
    const readIds = new Set(reads.map(r => r.itemId));

    const articles = items.map(i => {
      const feed = feedById.get(i.feedId);
      const sub = feed ? subByKey.get(canonicalFeedKey(feed.fetchUrl)) : undefined;
      return {
        read: readIds.has(i.id),
        id: i.id,
        feedUrl: feed?.fetchUrl ?? '',
        title: i.title,
        link: i.link,
        // Falls through to the hostname rather than to nothing: some feeds
        // carry no <title>, and a card with a blank byline reads as broken.
        source: sub?.name || feed?.title || hostOf(feed?.fetchUrl ?? ''),
        feedFolderId: sub?.feedFolderId ?? null,
        pubDate: i.pubDate,
        fetchedAt: i.fetchedAt,
        readTime: i.readTime,
        snippet: i.snippet,
        imageUrl: i.imageUrl,
        categories: i.categories,
      };
    });

    res.json({
      articles, total, unread,
      hasMore: offset + articles.length < total,
      // The watermark the client hands back to /articles/new-count. Only page 0
      // is a load; a "load more" is the same view reaching further down it, and
      // adopting its timestamp would quietly forgive everything that arrived in
      // between.
      loadedAt: loadedAt.toISOString(),
    });
  } catch (err) {
    logger.error(err, 'Feed articles error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── New since you loaded ─────────────────────────────────────────────────────
//
// The feed deliberately does not restock itself. Articles appearing under the
// cursor while you're reading push down whatever you were looking at and change
// what your next click lands on, so arrivals are counted here and inserted only
// when the reader asks for them.
//
// Counts against `firstSeenAt`, which is written once when an item is created.
// `fetchedAt` would be wrong: a 304 rewrites it for every item in the feed at
// once, so an unchanged feed would report its whole contents as new.
router.get('/articles/new-count', async (req: AuthRequest, res: Response): Promise<void> => {
  const raw = req.query.since;
  const since = typeof raw === 'string' ? new Date(raw) : null;
  if (!since || isNaN(since.getTime())) {
    res.status(400).json({ error: 'since must be an ISO timestamp' });
    return;
  }

  try {
    const subs = await scopedFeeds(req.userId!, req.query.folder);
    if (subs.length === 0) { res.json({ count: 0 }); return; }

    // ensureFeeds, not a plain lookup: it records the demand that keeps the
    // background scheduler interested in these feeds, and polling for new
    // articles is exactly the demand it should be measuring.
    const feeds = await ensureFeeds(subs.map(s => s.url));
    // Stories, not rows — the river deals one card per story, so a count of
    // rows would promise more than pressing the pill could deliver.
    const count = await countNewStories(req.userId!, feeds.map(f => f.id), since);
    res.json({ count });
  } catch (err) {
    logger.error(err, 'Feed new-count error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Go and fetch this user's own feeds now, rather than waiting out the 30-minute
// staleness window or the scheduler's next tick. This is what the Refresh button
// calls, and it answers only once the fetches are done — the point of pressing
// it is to find out whether there is anything new, so returning before looking
// would make it a button that lies.
//
// Scoped to the active category for the same reason mark-all-read is: what you
// are looking at is what you meant.
//
// `refresh-all` above stays admin-only and is a different thing: it forces every
// feed on the instance. This one is bounded by one account's subscriptions, and
// metered by the same per-user limiter as every other feed write.
router.post('/refresh', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const subs = await scopedFeeds(req.userId!, req.body?.folder ?? req.query.folder);
    if (subs.length === 0) { res.json({ checked: 0 }); return; }

    const feeds = await ensureFeeds(subs.map(s => s.url));
    // Forced, but not unconditionally: a feed checked seconds ago has nothing
    // to tell us, and without this floor holding the button down would fan one
    // account's fifty subscriptions into fifty outbound requests per press.
    // Everything older than the floor is fetched regardless of the ordinary
    // 30-minute staleness window, which is the point of asking.
    const cutoff = Date.now() - REFRESH_MIN_AGE_MS;
    const due = feeds.filter(f => !f.lastCheckedAt || f.lastCheckedAt.getTime() < cutoff);
    await refreshStaleFeeds(due, { force: true });
    res.json({ checked: due.length });
  } catch (err) {
    logger.error(err, 'Feed refresh error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Marks items read for this user (idempotent) and redraws the unread badge on
// the site tiles whose feed those items belong to. The badge is recomputed from
// read-state rather than decremented, so it always matches what the feed shows.
// Returns the bookmarks whose counts changed so the client can sync badges
// without a refetch.
router.post('/articles/read', async (req: AuthRequest, res: Response): Promise<void> => {
  const ids: unknown = req.body?.itemIds;
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
    res.status(400).json({ error: 'itemIds must be an array of strings' });
    return;
  }
  const itemIds = (ids as string[]).slice(0, 200);
  if (itemIds.length === 0) { res.json({ bookmarks: [] }); return; }

  try {
    // Every copy of each story, not just the card that was scrolled past — the
    // river shows one card per story and the Unread chip counts stories, so
    // marking one row read has to mean the story is read. See storyItemIds.
    const allIds = await storyItemIds(itemIds);

    // Only items becoming read for the first time can move a badge; a re-scroll
    // over already-read items is a no-op.
    const already = await prisma.readFeedItem.findMany({
      where: { userId: req.userId!, itemId: { in: allIds } },
      select: { itemId: true },
    });
    const alreadyRead = new Set(already.map(r => r.itemId));
    const fresh = allIds.filter(id => !alreadyRead.has(id));
    if (fresh.length === 0) { res.json({ bookmarks: [] }); return; }

    const items = await prisma.feedItem.findMany({
      where: { id: { in: fresh } },
      select: { id: true, feedId: true },
    });
    await prisma.readFeedItem.createMany({
      data: items.map(i => ({ userId: req.userId!, itemId: i.id })),
      skipDuplicates: true,
    });

    const feedIds = [...new Set(items.map(i => i.feedId))];
    res.json({ bookmarks: await syncBookmarkBadges(req.userId!, feedIds) });
  } catch (err) {
    logger.error(err, 'Mark articles read error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Marks everything in scope read in one shot — including the pages the client
// hasn't scrolled to yet, which is the point of "mark all read". Honours the
// active category filter, so "mark all read" while looking at Tech doesn't
// silently clear the news you hadn't got to.
router.post('/articles/read-all', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const subs = await scopedFeeds(req.userId!, req.body?.folder ?? req.query.folder);
    if (subs.length === 0) { res.json({ itemIds: [], bookmarks: [] }); return; }

    const feeds = await ensureFeeds(subs.map(s => s.url));
    const items = await prisma.feedItem.findMany({
      where: {
        feedId: { in: feeds.map(f => f.id) },
        dismissals: { none: { userId: req.userId! } },
        reads: { none: { userId: req.userId! } },
      },
      select: { id: true, feedId: true },
      take: 5000,
    });
    if (items.length === 0) { res.json({ itemIds: [], bookmarks: [] }); return; }

    await prisma.readFeedItem.createMany({
      data: items.map(i => ({ userId: req.userId!, itemId: i.id })),
      skipDuplicates: true,
    });

    const feedIds = [...new Set(items.map(i => i.feedId))];
    res.json({
      itemIds: items.map(i => i.id),
      bookmarks: await syncBookmarkBadges(req.userId!, feedIds),
    });
  } catch (err) {
    logger.error(err, 'Mark all articles read error');
    res.status(500).json({ error: 'Server error' });
  }
});

// A site tile's badge counts items that are neither read nor dismissed, so
// dismissing one has to recompute it — otherwise the tile keeps advertising an
// article the feed no longer shows, and only a later read-flush (which calls
// syncBookmarkBadges) would quietly put it right.
// Takes every copy of the story, not one item: dismissing and restoring both
// act on all of them now, so the badges that change are those of every feed
// that was carrying it.
async function badgesForItems(userId: string, itemIds: string[]) {
  if (itemIds.length === 0) return [];
  const items = await prisma.feedItem.findMany({
    where: { id: { in: itemIds } },
    select: { feedId: true },
  });
  if (items.length === 0) return [];
  return syncBookmarkBadges(userId, [...new Set(items.map(i => i.feedId))]);
}

router.delete('/articles/:articleId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // All copies. Dismissing only the one the card happened to be drawn from
    // would promote its twin into the same slot on the next load, and the
    // article you just threw away would come back.
    const ids = await storyItemIds([req.params.articleId]);
    await prisma.dismissedFeedItem.createMany({
      data: ids.map(itemId => ({ userId: req.userId!, itemId })),
      skipDuplicates: true,
    });
    res.json({ ok: true, bookmarks: await badgesForItems(req.userId!, ids) });
  } catch (err) {
    logger.error(err, 'Dismiss article error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Undo of the above. A dismissed card stays on screen greyed out until the feed
// is reloaded, and this is what its Undo calls.
router.post('/articles/:articleId/restore', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Undo has to cover exactly what the dismissal covered, or a restored
    // article stays half-dismissed and never comes back.
    const ids = await storyItemIds([req.params.articleId]);
    await prisma.dismissedFeedItem.deleteMany({
      where: { userId: req.userId!, itemId: { in: ids } },
    });
    res.json({ ok: true, bookmarks: await badgesForItems(req.userId!, ids) });
  } catch (err) {
    logger.error(err, 'Restore article error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
