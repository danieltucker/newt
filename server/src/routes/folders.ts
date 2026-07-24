import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { ensureFeeds, refreshStaleFeeds } from '../lib/feedRefresh';
import { syncBookmarkBadges } from '../lib/unread';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const folders = await prisma.folder.findMany({
    where: { userId: req.userId! },
    orderBy: { position: 'asc' },
  });
  res.json(folders);
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, color } = req.body;
  if (!name || !color) { res.status(400).json({ error: 'name and color required' }); return; }
  if (typeof name !== 'string' || name.length > 100) { res.status(400).json({ error: 'name must be ≤100 characters' }); return; }
  const count = await prisma.folder.count({ where: { userId: req.userId! } });
  const folder = await prisma.folder.create({
    data: { userId: req.userId!, name, color, position: count },
  });
  res.status(201).json(folder);
});

router.put('/reorder', async (req: AuthRequest, res: Response): Promise<void> => {
  const items: { id: string; position: number }[] = req.body;
  if (!Array.isArray(items)) { res.status(400).json({ error: 'Array expected' }); return; }
  await prisma.$transaction(
    items.map(({ id, position }) =>
      prisma.folder.updateMany({ where: { id, userId: req.userId! }, data: { position } })
    )
  );
  res.json({ ok: true });
});

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, color, feedUrls, backgroundImage } = req.body;
  try {
    const data: Record<string, unknown> = {};
    if (name) data.name = name;
    if (color) data.color = color;
    if (Array.isArray(feedUrls)) {
      if (feedUrls.length > 20) { res.status(400).json({ error: 'Maximum 20 feed URLs per folder' }); return; }
      data.feedUrls = feedUrls.filter((u: unknown) => typeof u === 'string' && (u as string).length <= 2048);
    }
    if ('backgroundImage' in req.body) data.backgroundImage = backgroundImage || null;

    const result = await prisma.folder.updateMany({
      where: { id: req.params.id, userId: req.userId! },
      data,
    });
    if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }

    // If feeds were updated, reset the check timer so next article load refreshes
    if (Array.isArray(feedUrls)) {
      await prisma.folder.updateMany({
        where: { id: req.params.id, userId: req.userId! },
        data: { feedLastCheckedAt: null },
      });
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await prisma.folder.deleteMany({
    where: { id: req.params.id, userId: req.userId! },
  });
  if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});

// Clears the unread badges on every bookmark in the folder. Because the badge
// now derives from read-state, clearing it durably means marking the folder's
// feed items read too — which also keeps the RSS reader in step, so "mark read"
// on the bookmarks side and the feed side mean the same thing.
router.post('/:id/mark-read', async (req: AuthRequest, res: Response): Promise<void> => {
  const folder = await prisma.folder.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!folder) { res.status(404).json({ error: 'Not found' }); return; }

  if (folder.feedUrls.length > 0) {
    const feeds = await ensureFeeds(folder.feedUrls);
    const items = await prisma.feedItem.findMany({
      where: {
        feedId: { in: feeds.map(f => f.id) },
        reads: { none: { userId: req.userId! } },
        dismissals: { none: { userId: req.userId!, folderId: req.params.id } },
      },
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

  await prisma.bookmark.updateMany({
    where: { folderId: req.params.id, userId: req.userId! },
    data: { unreadCount: 0 },
  });
  res.json({ ok: true });
});

// Admin-only: force-refreshing every feed fans one action out into many
// outbound requests, so it stays behind requireAdmin to avoid abuse/amplification.
router.post('/refresh-all', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const folders = await prisma.folder.findMany({
    where: { userId: req.userId!, NOT: { feedUrls: { isEmpty: true } } },
    select: { feedUrls: true },
  });
  if (folders.length === 0) {
    res.json({ refreshed: 0 });
    return;
  }
  const feeds = await ensureFeeds(folders.flatMap(f => f.feedUrls));
  // Force refresh regardless of staleness — this is an explicit user action.
  // Still claim-protected + concurrency-limited inside refreshStaleFeeds.
  await refreshStaleFeeds(feeds, { force: true });
  res.json({ refreshed: feeds.length });
});

router.get('/:id/articles', async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const offset     = Math.max(0, parseInt(req.query.offset as string || '0') || 0);
  const limit      = Math.min(200, Math.max(1, parseInt(req.query.limit as string || '10') || 10));
  const includeAll = req.query.includeAll === 'true';

  try {
    const folder = await prisma.folder.findFirst({ where: { id, userId: req.userId! } });
    if (!folder) { res.status(404).json({ error: 'Not found' }); return; }

    if (folder.feedUrls.length === 0) {
      res.json({ articles: [], total: 0, hasMore: false });
      return;
    }

    const feeds = await ensureFeeds(folder.feedUrls);
    const neverFetched = feeds.some(f => !f.lastCheckedAt);
    if (neverFetched) {
      // First load of at least one feed — wait so the user doesn't see an empty list
      await refreshStaleFeeds(feeds);
    } else {
      // Data exists — serve immediately, refresh stale feeds behind the scenes
      refreshStaleFeeds(feeds).catch(() => {});
    }

    const feedIds = feeds.map(f => f.id);
    const feedById = new Map(feeds.map(f => [f.id, f]));
    const where = {
      feedId: { in: feedIds },
      ...(includeAll ? {} : { dismissals: { none: { userId: req.userId!, folderId: id } } }),
    };
    const [items, total] = await Promise.all([
      prisma.feedItem.findMany({
        where,
        orderBy: [{ pubDate: 'desc' }, { fetchedAt: 'desc' }],
        skip: offset,
        take: limit,
      }),
      prisma.feedItem.count({ where }),
    ]);

    const reads = await prisma.readFeedItem.findMany({
      where: { userId: req.userId!, itemId: { in: items.map(i => i.id) } },
      select: { itemId: true },
    });
    const readIds = new Set(reads.map(r => r.itemId));

    const articles = items.map(i => {
      const feed = feedById.get(i.feedId);
      return {
        read: readIds.has(i.id),
        id: i.id,
        feedUrl: feed?.fetchUrl ?? '',
        title: i.title,
        link: i.link,
        source: feed?.title || '',
        pubDate: i.pubDate,
        fetchedAt: i.fetchedAt,
        readTime: i.readTime,
        snippet: i.snippet,
        imageUrl: i.imageUrl,
        categories: i.categories,
      };
    });

    res.json({ articles, total, hasMore: offset + articles.length < total });
  } catch (err) {
    logger.error(err, 'Feed articles error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Marks every article in the folder's feeds read in one shot — including the
// pages the client hasn't scrolled to yet, which is the point of "mark all
// read". Badge clearing is left to POST /:id/mark-read so the two concerns stay
// separate; the client fires both. Returns the ids so the open feed can drop
// its unread outlines without a refetch.
router.post('/:id/articles/read-all', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const folder = await prisma.folder.findFirst({ where: { id: req.params.id, userId: req.userId! } });
    if (!folder) { res.status(404).json({ error: 'Not found' }); return; }
    if (folder.feedUrls.length === 0) { res.json({ itemIds: [] }); return; }

    const feeds = await ensureFeeds(folder.feedUrls);
    const items = await prisma.feedItem.findMany({
      where: {
        feedId: { in: feeds.map(f => f.id) },
        dismissals: { none: { userId: req.userId!, folderId: req.params.id } },
      },
      select: { id: true },
      take: 5000,
    });
    if (items.length === 0) { res.json({ itemIds: [] }); return; }

    await prisma.readFeedItem.createMany({
      data: items.map(i => ({ userId: req.userId!, itemId: i.id })),
      skipDuplicates: true,
    });

    res.json({ itemIds: items.map(i => i.id) });
  } catch (err) {
    logger.error(err, 'Mark all articles read error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Marks items read for this user (idempotent) and redraws the unread badge on
// the site tiles whose feed those items belong to. The badge is recomputed from
// read-state rather than decremented, so it always matches what the feed reader
// shows. Returns the bookmarks whose counts changed so the client can sync
// badges without a refetch.
router.post('/:id/articles/read', async (req: AuthRequest, res: Response): Promise<void> => {
  const ids: unknown = req.body?.itemIds;
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
    res.status(400).json({ error: 'itemIds must be an array of strings' });
    return;
  }
  const itemIds = (ids as string[]).slice(0, 200);
  if (itemIds.length === 0) { res.json({ bookmarks: [] }); return; }

  try {
    const folder = await prisma.folder.findFirst({ where: { id: req.params.id, userId: req.userId! } });
    if (!folder) { res.status(404).json({ error: 'Not found' }); return; }

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
    const updates = await syncBookmarkBadges(req.userId!, feedIds);
    res.json({ bookmarks: updates });
  } catch (err) {
    logger.error(err, 'Mark articles read error');
    res.status(500).json({ error: 'Server error' });
  }
});

// "Dismiss" marks the shared item hidden for this user+folder only
router.delete('/:id/articles/:articleId', async (req: AuthRequest, res: Response): Promise<void> => {
  const { id, articleId } = req.params;
  try {
    const folder = await prisma.folder.findFirst({ where: { id, userId: req.userId! } });
    if (!folder) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.dismissedFeedItem.createMany({
      data: [{ userId: req.userId!, folderId: id, itemId: articleId }],
      skipDuplicates: true,
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
