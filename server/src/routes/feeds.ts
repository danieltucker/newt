import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { ensureFeeds, refreshStaleFeeds } from '../lib/feedRefresh';
import { syncBookmarkBadges } from '../lib/unread';
import { canonicalFeedKey } from '../lib/feedUtils';
import { resolveFeedUrl } from '../lib/feedDiscovery';
import { perUserLimiter } from '../lib/rateLimit';
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

// The curated starter list, minus anything already subscribed to.
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
    if (body.skipValidation === true) {
      const normalized = normalizeFeedUrl(rawUrl);
      if (!normalized) { res.status(400).json({ error: 'A valid http(s) feed URL is required' }); return; }
      url = normalized;
    } else {
      const resolved = await resolveFeedUrl(rawUrl);
      if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }
      url = resolved.url;
      discoveredTitle = resolved.title;
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

router.get('/articles', async (req: AuthRequest, res: Response): Promise<void> => {
  const offset     = Math.max(0, parseInt(req.query.offset as string || '0') || 0);
  const limit      = Math.min(200, Math.max(1, parseInt(req.query.limit as string || '10') || 10));
  const includeAll = req.query.includeAll === 'true';

  try {
    const subs = await scopedFeeds(req.userId!, req.query.folder);
    if (subs.length === 0) {
      res.json({ articles: [], total: 0, unread: 0, hasMore: false });
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

    const where = {
      feedId: { in: feeds.map(f => f.id) },
      ...(includeAll ? {} : { dismissals: { none: { userId: req.userId! } } }),
    };
    // `unread` spans the whole river, not the page being returned. The client
    // shows it on the Unread filter chip, which sits next to site tiles whose
    // badges are counted the same way (see lib/unread.ts) — a chip counting only
    // the ten loaded articles would say "1" beside a tile saying "19".
    const [items, total, unread] = await Promise.all([
      prisma.feedItem.findMany({
        where,
        orderBy: [{ pubDate: 'desc' }, { fetchedAt: 'desc' }],
        skip: offset,
        take: limit,
      }),
      prisma.feedItem.count({ where }),
      prisma.feedItem.count({ where: { ...where, reads: { none: { userId: req.userId! } } } }),
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

    res.json({ articles, total, unread, hasMore: offset + articles.length < total });
  } catch (err) {
    logger.error(err, 'Feed articles error');
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
    // Only items becoming read for the first time can move a badge; a re-scroll
    // over already-read items is a no-op.
    const already = await prisma.readFeedItem.findMany({
      where: { userId: req.userId!, itemId: { in: itemIds } },
      select: { itemId: true },
    });
    const alreadyRead = new Set(already.map(r => r.itemId));
    const fresh = itemIds.filter(id => !alreadyRead.has(id));
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
async function badgesForItem(userId: string, itemId: string) {
  const item = await prisma.feedItem.findUnique({ where: { id: itemId }, select: { feedId: true } });
  if (!item) return [];
  return syncBookmarkBadges(userId, [item.feedId]);
}

router.delete('/articles/:articleId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.dismissedFeedItem.createMany({
      data: [{ userId: req.userId!, itemId: req.params.articleId }],
      skipDuplicates: true,
    });
    res.json({ ok: true, bookmarks: await badgesForItem(req.userId!, req.params.articleId) });
  } catch (err) {
    logger.error(err, 'Dismiss article error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Undo of the above. A dismissed card stays on screen greyed out until the feed
// is reloaded, and this is what its Undo calls.
router.post('/articles/:articleId/restore', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.dismissedFeedItem.deleteMany({
      where: { userId: req.userId!, itemId: req.params.articleId },
    });
    res.json({ ok: true, bookmarks: await badgesForItem(req.userId!, req.params.articleId) });
  } catch (err) {
    logger.error(err, 'Restore article error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
