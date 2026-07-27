import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { PUBLIC_USER_SELECT, toPublicUser } from '../lib/friends';
import { blockWallOf, notWalledNullableWhere } from '../lib/blocks';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// Blocking clears the notifications already exchanged with that person (see
// routes/blocks.ts), so this filter is for the rest: anything that arrived in
// the window between the block landing and a queued write completing, and
// anything a shared thread produces afterwards.
async function wallFilter(userId: string) {
  return notWalledNullableWhere(await blockWallOf(userId), 'actorId');
}

// GET /api/v1/notifications — recent notifications plus the unread count
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const notWalled = await wallFilter(req.userId!);
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.userId!, ...notWalled },
        include: { actor: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.notification.count({ where: { userId: req.userId!, read: false, ...notWalled } }),
    ]);
    const notifications = rows.map(n => ({
      id: n.id,
      type: n.type,
      actor: n.actor ? toPublicUser(n.actor) : null,
      articleUrl: n.articleUrl,
      articleTitle: n.articleTitle,
      commentId: n.commentId,
      reportId: n.reportId,
      read: n.read,
      createdAt: n.createdAt,
    }));
    res.json({ notifications, unread });
  } catch (err) {
    logger.error(err, 'List notifications error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/notifications/count — cheap poll for the top-bar badge
router.get('/count', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Must match the list above, or the badge counts things the panel won't show
    const unread = await prisma.notification.count({
      where: { userId: req.userId!, read: false, ...(await wallFilter(req.userId!)) },
    });
    res.json({ unread });
  } catch (err) {
    logger.error(err, 'Notification count error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/notifications/read-all
router.post('/read-all', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.userId!, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Mark notifications read error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/notifications/read { ids }
router.post('/read', async (req: AuthRequest, res: Response): Promise<void> => {
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
    res.status(400).json({ error: 'ids must be an array of strings' }); return;
  }
  try {
    await prisma.notification.updateMany({
      where: { userId: req.userId!, id: { in: (ids as string[]).slice(0, 100) } },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Mark notifications read error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
