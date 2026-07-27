import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { PUBLIC_USER_SELECT, toPublicUser } from '../lib/friends';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';

// Blocking. See lib/blocks.ts for what a block means here — in short, a wall
// enforced in both directions from a row that remembers who raised it.
const router = Router();
router.use(requireAuth);

// Blocking is cheap to undo and costly to spam (each one tears down a
// friendship), so the ceiling is generous but present.
const blockLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 60,
  message: 'Too many changes to your blocked list — please try again later.',
});

// GET /api/v1/blocks — the people *you* blocked, newest first.
//
// Only your own side is ever listed. Who has blocked you is deliberately
// unknowable: it is the one fact that would make a block worth evading.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.block.findMany({
      where: { blockerId: req.userId! },
      include: { blocked: { select: PUBLIC_USER_SELECT } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      blocked: rows.map(r => ({ ...toPublicUser(r.blocked), blockedAt: r.createdAt })),
    });
  } catch (err) {
    logger.error(err, 'List blocks error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/blocks { username } — raise the wall.
//
// Blocking is not a weaker unfriending: it ends the friendship, cancels any
// pending request either way, and clears the notifications the pair sent each
// other. All in one transaction, so there is no instant where a Block row and a
// Friendship row both describe the same pair.
router.post('/', blockLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username) { res.status(400).json({ error: 'username required' }); return; }

  try {
    // Banned accounts are excluded everywhere else, but not here: someone
    // blocked while banned should stay blocked if they are ever unbanned.
    const target = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true, username: true },
    });
    if (!target) { res.status(404).json({ error: 'No such user' }); return; }
    if (target.id === req.userId!) { res.status(400).json({ error: "You can't block yourself" }); return; }

    const existing = await prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId: req.userId!, blockedId: target.id } },
      select: { id: true },
    });
    if (existing) { res.json({ ok: true, alreadyBlocked: true }); return; }

    await prisma.$transaction(async tx => {
      await tx.block.create({ data: { blockerId: req.userId!, blockedId: target.id } });
      await tx.friendship.deleteMany({
        where: {
          OR: [
            { requesterId: req.userId!, addresseeId: target.id },
            { requesterId: target.id, addresseeId: req.userId! },
          ],
        },
      });
      // The bell should not keep showing "they replied to you" for someone the
      // reader has just walled off.
      await tx.notification.deleteMany({
        where: {
          OR: [
            { userId: req.userId!, actorId: target.id },
            { userId: target.id, actorId: req.userId! },
          ],
        },
      });
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error(err, 'Block user error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/blocks/:userId — take the wall down.
//
// Only the blocker's own row is removed. Unblocking restores nothing else: the
// friendship stays gone, which is the honest outcome — the two are strangers
// again, not friends again.
router.delete('/:userId', blockLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await prisma.block.deleteMany({
      where: { blockerId: req.userId!, blockedId: req.params.userId },
    });
    if (result.count === 0) { res.status(404).json({ error: 'Not blocked' }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Unblock user error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
