import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ensureFeeds, refreshStaleFeeds } from '../lib/feedRefresh';
import { discoverFeed } from '../lib/feedDiscovery';
import { addFeedSubscription } from '../lib/feedSubscriptions';
import { feedUnreadCount } from '../lib/unread';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';

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
  res.status(201).json(bookmark);

  // Fire-and-forget: discover the site's RSS feed and subscribe to it, so its
  // articles turn up in the feed automatically. Manageable from the feed
  // manager; disabled entirely when the user turns RSS off in settings.
  autoAddFeed(req.userId!, bookmark.id, name, domain).catch(err =>
    logger.warn(err, 'Feed auto-add failed')
  );
});

async function autoAddFeed(userId: string, bookmarkId: string, bookmarkName: string, domain: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = user?.settings as { rssEnabled?: boolean } | null;
  if (settings?.rssEnabled === false) return;

  const feedUrl = await discoverFeed(domain);
  if (!feedUrl) return;

  // Remembered on the bookmark whatever happens next: it drives the tile's
  // unread badge, and it is what makes the site offerable in the manager's
  // "from your bookmarks" list if the subscription is later removed.
  await prisma.bookmark.updateMany({ where: { id: bookmarkId, userId }, data: { feedUrl } });

  // Lands Uncategorised — a bookmark's folder says where the *link* belongs,
  // which is no guide at all to how its publisher should be filed in a reader.
  // addFeedSubscription dedupes canonically and respects the per-user cap.
  await addFeedSubscription(userId, feedUrl, bookmarkName);
}

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
