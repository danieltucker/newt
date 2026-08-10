import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ensureFeeds, refreshStaleFeeds } from '../lib/feedRefresh';
import { discoverFeed } from '../lib/feedDiscovery';
import { addFeedSubscription, MAX_FEEDS_PER_USER } from '../lib/feedSubscriptions';
import { blockedRuleFor, blockedMessage } from '../lib/feedBlocklist';
import { canonicalFeedKey } from '../lib/feedUtils';
import { feedUnreadCount } from '../lib/unread';
import { perUserLimiter } from '../lib/rateLimit';

const router = Router();
router.use(requireAuth);

// A ceiling on how much of the database one account can occupy. /import accepts
// 500 rows a call and nothing stopped an account from calling it repeatedly, so
// row growth was bounded only by the per-IP request limiter — which an authed
// client rotating IPs sidesteps entirely. Every bookmark also becomes feed work
// later (discovery, then polling forever), so this cap is as much about outbound
// fetch load as about disk.
const MAX_BOOKMARKS_PER_USER = 2000;

// Per-account, so it survives IP rotation the way the comment and friend limits
// do. Generous, because ordinary browsing writes: /:id/visited fires on every
// bookmark click and pin/unpin are one-tap actions.
const bookmarkWriteLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 600,
  message: 'Too many changes — please slow down for a moment.',
});
router.use((req, res, next) => {
  // Reads stay on the shared per-IP limiter; only writes are metered per account.
  if (req.method === 'GET') { next(); return; }
  bookmarkWriteLimiter(req, res, next);
});

// Returns all bookmarks for the user in one query — used for the initial bulk load
router.get('/all', async (req: AuthRequest, res: Response): Promise<void> => {
  const bookmarks = await prisma.bookmark.findMany({
    where: { userId: req.userId! },
    orderBy: { position: 'asc' },
  });
  res.json(bookmarks);
});

router.post('/import', async (req: AuthRequest, res: Response): Promise<void> => {
  const { folderId, bookmarks } = req.body;
  if (!folderId || !Array.isArray(bookmarks) || bookmarks.length === 0) {
    res.status(400).json({ error: 'folderId and bookmarks array required' }); return;
  }
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: req.userId! } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const existing = await prisma.bookmark.findMany({
    where: { folderId, userId: req.userId! },
    select: { domain: true, position: true },
  });
  const existingDomains = new Set(existing.map(b => b.domain));
  const nextPosition = existing.length > 0 ? Math.max(...existing.map(b => b.position)) + 1 : 0;

  // Trim to whatever room is left in the account's budget rather than rejecting
  // the whole import: a browser export is usually mostly duplicates, and failing
  // the entire call because the tail would overflow is a worse answer than
  // importing what fits and reporting the rest as skipped.
  const totalOwned = await prisma.bookmark.count({ where: { userId: req.userId! } });
  const remaining = Math.max(0, MAX_BOOKMARKS_PER_USER - totalOwned);

  const toCreate = (bookmarks as { name: string; domain: string; color: string }[])
    .filter(b => b.domain && b.name && !existingDomains.has(b.domain))
    .slice(0, Math.min(500, remaining));

  if (toCreate.length > 0) {
    await prisma.bookmark.createMany({
      data: toCreate.map((b, i) => ({
        folderId,
        userId: req.userId!,
        domain: b.domain,
        name: b.name,
        faviconUrl: `https://www.google.com/s2/favicons?domain=${b.domain}&sz=128`,
        color: b.color || '#5E6AD2',
        position: nextPosition + i,
      })),
    });
  }

  res.json({
    created: toCreate.length,
    skipped: bookmarks.length - toCreate.length,
    // Lets the client say "you've reached the limit" instead of silently
    // dropping the tail of the file the user just picked.
    atCap: remaining === 0,
    limit: MAX_BOOKMARKS_PER_USER,
  });
});

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { folderId } = req.query;
  if (!folderId) { res.status(400).json({ error: 'folderId required' }); return; }
  const bookmarks = await prisma.bookmark.findMany({
    where: { folderId: folderId as string, userId: req.userId! },
    orderBy: { position: 'asc' },
  });
  res.json(bookmarks);
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { folderId, domain, name, faviconUrl, color } = req.body;
  if (!folderId || !domain || !name) {
    res.status(400).json({ error: 'folderId, domain, and name required' });
    return;
  }
  const owned = await prisma.bookmark.count({ where: { userId: req.userId! } });
  if (owned >= MAX_BOOKMARKS_PER_USER) {
    res.status(409).json({ error: `You've reached the limit of ${MAX_BOOKMARKS_PER_USER} bookmarks.` });
    return;
  }
  if (typeof name !== 'string' || name.length > 100) { res.status(400).json({ error: 'name must be ≤100 characters' }); return; }
  if (typeof domain !== 'string' || domain.length > 253) { res.status(400).json({ error: 'domain must be ≤253 characters' }); return; }
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: req.userId! } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  const count = await prisma.bookmark.count({ where: { folderId, userId: req.userId! } });
  const bookmark = await prisma.bookmark.create({
    data: {
      folderId,
      userId: req.userId!,
      domain,
      name,
      faviconUrl: faviconUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      color: color || '#5E6AD2',
      position: count,
    },
  });
  // No feed work here. Discovery is an outbound fetch of an attacker-chosen host
  // and takes seconds; the tile should appear the moment it is saved. The client
  // asks /discover-feed straight afterwards and prompts from the answer.
  res.status(201).json(bookmark);
});

/**
 * Does this bookmark's site publish a feed the user could follow?
 *
 * This used to subscribe on its own the moment a bookmark was saved, which
 * meant adding a link to a shop or a bank quietly filled the river with its
 * blog. Following a publisher is a reading decision, so it is now asked rather
 * than assumed — the client shows the answer as a prompt with a Follow button.
 *
 * Answers `{ offer: null }` for every "nothing to ask about" case rather than an
 * error: no feed, RSS turned off, the address is blocklisted, or the user
 * already follows it. The caller has one thing to decide (prompt or don't) and
 * a 404 for "this site has no feed" would make an ordinary outcome look broken.
 *
 * POST, not GET, because it writes what it learns — `feedUrl` drives the tile's
 * unread badge whether or not the offer is taken — and because it belongs on
 * the per-account write limiter, being the one route here that reaches out to
 * the open internet.
 */
router.post('/:id/discover-feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const bookmark = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!bookmark) { res.status(404).json({ error: 'Not found' }); return; }

  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { settings: true } });
  const settings = user?.settings as { rssEnabled?: boolean } | null;
  if (settings?.rssEnabled === false) { res.json({ offer: null }); return; }

  // Already known (the periodic check-feed sweep discovers too) means no second
  // round trip. Recorded either way, including the miss, so a site with no feed
  // isn't re-probed on every sweep.
  let feedUrl = bookmark.feedUrl ?? null;
  if (!feedUrl) {
    feedUrl = await discoverFeed(bookmark.domain);
    await prisma.bookmark.updateMany({
      where: { id: bookmark.id, userId: req.userId! },
      data: { feedUrl, feedCheckedAt: new Date() },
    });
  }
  if (!feedUrl) { res.json({ offer: null }); return; }

  if (await blockedRuleFor(feedUrl)) { res.json({ offer: null }); return; }

  // Canonical, for the same reason /feeds does it: the discovered address and a
  // subscription the user typed themselves are often the same feed spelled two
  // ways, and offering to follow something they already follow is noise.
  const key = canonicalFeedKey(feedUrl);
  const existing = await prisma.feedSubscription.findMany({
    where: { userId: req.userId! },
    select: { url: true },
  });
  if (existing.some(s => canonicalFeedKey(s.url) === key)) { res.json({ offer: null }); return; }

  // The publisher's own name for itself if we've ever fetched the feed, else the
  // name on the tile — which is the name the user just typed, so never worse
  // than a hostname.
  const feed = await prisma.feed.findUnique({ where: { canonicalKey: key }, select: { title: true } });
  res.json({ offer: { url: feedUrl, title: feed?.title || bookmark.name } });
});

/**
 * Take the offer above: follow the feed found for this bookmark.
 *
 * Reads the URL off the bookmark rather than the request body, so accepting a
 * prompt can only ever subscribe to the address the server itself discovered.
 * The blocklist is re-checked here because /discover-feed and this call are
 * separate requests and a rule can land between them.
 */
router.post('/:id/follow-feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const bookmark = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!bookmark) { res.status(404).json({ error: 'Not found' }); return; }

  const feedUrl = bookmark.feedUrl;
  if (!feedUrl) { res.status(404).json({ error: 'No feed found for that site' }); return; }

  const blocked = await blockedRuleFor(feedUrl);
  if (blocked) { res.status(403).json({ error: blockedMessage(blocked) }); return; }

  const count = await prisma.feedSubscription.count({ where: { userId: req.userId! } });
  if (count >= MAX_FEEDS_PER_USER) {
    res.status(400).json({ error: `You can follow up to ${MAX_FEEDS_PER_USER} feeds` });
    return;
  }

  // Lands Uncategorised — a bookmark's folder says where the *link* belongs,
  // which is no guide at all to how its publisher should be filed in a reader.
  // addFeedSubscription dedupes canonically and respects the per-user cap.
  const added = await addFeedSubscription(req.userId!, feedUrl, bookmark.name);

  // Pull it in now so the river isn't missing what was just followed.
  ensureFeeds([feedUrl]).then(feeds => refreshStaleFeeds(feeds)).catch(() => {});

  res.json({ ok: true, added, feedUrl });
});

router.put('/reorder', async (req: AuthRequest, res: Response): Promise<void> => {
  const items: { id: string; position: number }[] = req.body;
  if (!Array.isArray(items)) { res.status(400).json({ error: 'Array expected' }); return; }
  await prisma.$transaction(
    items.map(({ id, position }) =>
      prisma.bookmark.updateMany({ where: { id, userId: req.userId! }, data: { position } })
    )
  );
  res.json({ ok: true });
});

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, domain, faviconUrl, color, folderId } = req.body;
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await prisma.bookmark.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(domain !== undefined && { domain }),
      ...(faviconUrl !== undefined && { faviconUrl }),
      ...(color !== undefined && { color }),
      ...(folderId !== undefined && { folderId }),
    },
  });
  res.json(updated);
});

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await prisma.bookmark.deleteMany({
    where: { id: req.params.id, userId: req.userId! },
  });
  if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});

// Updates a bookmark's unread badge. The feed itself is fetched through the
// shared Feed table, so two users watching the same site (or a site that's also
// a folder feed) trigger at most one outbound request — the per-bookmark fetch
// this used to do is gone.
router.post('/:id/check-feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const bookmark = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!bookmark) { res.status(404).json({ error: 'Not found' }); return; }

  let feedUrl = bookmark.feedUrl ?? null;
  if (!feedUrl) feedUrl = await discoverFeed(bookmark.domain);

  if (!feedUrl) {
    // No feed — just record the check so we don't re-run discovery every cycle.
    const updated = await prisma.bookmark.update({
      where: { id: bookmark.id },
      data: { feedCheckedAt: new Date() },
    });
    res.json(updated);
    return;
  }

  // Resolve to the shared Feed row and make sure it has items. First time we
  // wait so the badge is meaningful; otherwise refresh in the background — both
  // paths are claim-protected, so concurrent callers don't duplicate the fetch.
  const [feed] = await ensureFeeds([feedUrl]);
  if (feed) {
    if (!feed.lastCheckedAt) await refreshStaleFeeds([feed]);
    else refreshStaleFeeds([feed]).catch(() => {});
  }

  // Unread = shared items in this feed the user hasn't read or dismissed — the
  // same read-state the RSS reader writes, so the badge and the feed's "new"
  // outlines never disagree and a background check can't resurrect a count the
  // user already cleared. Idempotent by construction.
  let unreadCount = 0;
  let feedLatestAt: Date | undefined;
  if (feed) {
    unreadCount = await feedUnreadCount(req.userId!, feed.id);
    const latest = await prisma.feedItem.findFirst({
      where: { feedId: feed.id },
      orderBy: { pubDate: 'desc' },
      select: { pubDate: true },
    });
    feedLatestAt = latest?.pubDate ?? undefined;
  }

  const updated = await prisma.bookmark.update({
    where: { id: bookmark.id },
    data: {
      feedUrl,
      feedCheckedAt: new Date(),
      unreadCount,
      ...(feedLatestAt && { feedLatestAt }),
    },
  });
  res.json(updated);
});

// Pin a bookmark: surface it in the sidebar's top pin grid. The bookmark keeps
// its folder — pinning is a view flag, not a move. Position orders the pin grid.
router.post('/:id/pin', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const pinnedCount = await prisma.bookmark.count({ where: { userId: req.userId!, pinned: true } });
  const updated = await prisma.bookmark.update({
    where: { id: existing.id },
    data: { pinned: true, position: pinnedCount },
  });
  res.json(updated);
});

// Unpin: drop it from the pin grid. It reappears in its (retained) folder,
// appended to the end of that folder's list.
router.post('/:id/unpin', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const count = await prisma.bookmark.count({
    where: { userId: req.userId!, folderId: existing.folderId, pinned: false },
  });
  const updated = await prisma.bookmark.update({
    where: { id: existing.id },
    data: { pinned: false, position: count },
  });
  res.json(updated);
});

// Opening a site clears its badge. To keep that durable — and to keep the badge
// in step with the RSS reader — visiting also marks the site's feed items read,
// so the next check-feed recomputes to zero instead of resurrecting the count.
router.post('/:id/visited', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  if (existing.feedUrl) {
    const [feed] = await ensureFeeds([existing.feedUrl]);
    if (feed) {
      const items = await prisma.feedItem.findMany({
        where: { feedId: feed.id, reads: { none: { userId: req.userId! } } },
        select: { id: true },
        take: 5000,
      });
      if (items.length > 0) {
        await prisma.readFeedItem.createMany({
          data: items.map(i => ({ userId: req.userId!, itemId: i.id })),
          skipDuplicates: true,
        });
      }
    }
  }

  await prisma.bookmark.update({
    where: { id: req.params.id },
    data: { lastVisitedAt: new Date(), unreadCount: 0 },
  });
  res.json({ ok: true });
});

export default router;
