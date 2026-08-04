// Bookmark folders only. Feeds moved out of here in v1.11.0 — they live under
// /api/v1/feeds now, filed into their own categories, because being *in* a
// folder should never have been the price of seeing what a site published.
import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ensureFeeds } from '../lib/feedRefresh';
import { canonicalFeedKey } from '../lib/feedUtils';
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
  const { name, color, backgroundImage } = req.body;
  try {
    const data: Record<string, unknown> = {};
    if (name) data.name = name;
    if (color) data.color = color;
    if ('backgroundImage' in req.body) data.backgroundImage = backgroundImage || null;

    const result = await prisma.folder.updateMany({
      where: { id: req.params.id, userId: req.userId! },
      data,
    });
    if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }

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

// Clears the unread badges on every bookmark in the folder. The badge derives
// from read-state, so clearing it durably means marking those sites' feed items
// read too — which keeps the feed in step, and is why this reaches for feed
// rows at all now that folders don't own any. The sites in question come from
// the bookmarks themselves: a bookmark records the feed discovery found for it,
// whether or not the user subscribed to it in the reader.
router.post('/:id/mark-read', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const folder = await prisma.folder.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true },
    });
    if (!folder) { res.status(404).json({ error: 'Not found' }); return; }

    const bookmarks = await prisma.bookmark.findMany({
      where: { folderId: folder.id, userId: req.userId!, NOT: { feedUrl: null } },
      select: { feedUrl: true },
    });

    const urls = [...new Set(bookmarks.map(b => b.feedUrl!))];
    if (urls.length > 0) {
      // Resolve through the shared Feed table rather than re-fetching: the items
      // are already there, and this must not fan out into one request per tile.
      const keys = new Set(urls.map(canonicalFeedKey));
      const feeds = await ensureFeeds(urls);
      const feedIds = feeds.filter(f => keys.has(canonicalFeedKey(f.fetchUrl))).map(f => f.id);

      if (feedIds.length > 0) {
        const items = await prisma.feedItem.findMany({
          where: {
            feedId: { in: feedIds },
            reads: { none: { userId: req.userId! } },
            dismissals: { none: { userId: req.userId! } },
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
    }

    await prisma.bookmark.updateMany({
      where: { folderId: folder.id, userId: req.userId! },
      data: { unreadCount: 0 },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Folder mark-read error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

