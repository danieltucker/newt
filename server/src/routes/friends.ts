import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { PUBLIC_USER_SELECT, toPublicUser, friendIdsOf } from '../lib/friends';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// Search is the user-enumeration surface; requests are the spam/harassment one.
// Both keyed per user (see lib/rateLimit) so they survive IP rotation.
const searchLimiter = perUserLimiter({
  windowMs: 60_000, max: 30,
  message: 'Too many searches — slow down a moment.',
});
const requestLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 30,
  message: "You've sent a lot of friend requests — please try again later.",
});

// GET /api/v1/friends — accepted friends
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.friendship.findMany({
      where: { status: 'accepted', OR: [{ requesterId: req.userId! }, { addresseeId: req.userId! }] },
      include: { requester: { select: PUBLIC_USER_SELECT }, addressee: { select: PUBLIC_USER_SELECT } },
      orderBy: { respondedAt: 'desc' },
    });
    const friends = rows.map(r => toPublicUser(r.requesterId === req.userId! ? r.addressee : r.requester));
    res.json({ friends });
  } catch (err) {
    logger.error(err, 'List friends error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/friends/requests — pending, split by direction
router.get('/requests', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.friendship.findMany({
      where: { status: 'pending', OR: [{ requesterId: req.userId! }, { addresseeId: req.userId! }] },
      include: { requester: { select: PUBLIC_USER_SELECT }, addressee: { select: PUBLIC_USER_SELECT } },
      orderBy: { createdAt: 'desc' },
    });
    const incoming = rows
      .filter(r => r.addresseeId === req.userId!)
      .map(r => ({ id: r.id, user: toPublicUser(r.requester), createdAt: r.createdAt }));
    const outgoing = rows
      .filter(r => r.requesterId === req.userId!)
      .map(r => ({ id: r.id, user: toPublicUser(r.addressee), createdAt: r.createdAt }));
    res.json({ incoming, outgoing });
  } catch (err) {
    logger.error(err, 'List friend requests error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/friends/search?q= — find users to befriend, tagged with our
// current relationship so the UI can show Add / Requested / Friends.
router.get('/search', searchLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) { res.json({ results: [] }); return; }
  try {
    const users = await prisma.user.findMany({
      where: {
        username: { contains: q, mode: 'insensitive' },
        bannedAt: null,
        NOT: { id: req.userId! },
      },
      select: PUBLIC_USER_SELECT,
      take: 10,
      orderBy: { username: 'asc' },
    });
    if (users.length === 0) { res.json({ results: [] }); return; }

    const rels = await prisma.friendship.findMany({
      where: {
        OR: [
          { requesterId: req.userId!, addresseeId: { in: users.map(u => u.id) } },
          { addresseeId: req.userId!, requesterId: { in: users.map(u => u.id) } },
        ],
      },
      select: { requesterId: true, addresseeId: true, status: true },
    });
    const relByUser = new Map<string, 'friends' | 'incoming' | 'outgoing'>();
    for (const r of rels) {
      const otherId = r.requesterId === req.userId! ? r.addresseeId : r.requesterId;
      if (r.status === 'accepted') relByUser.set(otherId, 'friends');
      else relByUser.set(otherId, r.requesterId === req.userId! ? 'outgoing' : 'incoming');
    }

    res.json({
      results: users.map(u => ({ ...toPublicUser(u), relation: relByUser.get(u.id) ?? 'none' })),
    });
  } catch (err) {
    logger.error(err, 'Friend search error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/friends/requests { username } — send a request. If the target has
// already requested us, this accepts theirs instead of stacking a second row.
router.post('/requests', requestLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username) { res.status(400).json({ error: 'username required' }); return; }

  try {
    const target = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' }, bannedAt: null },
      select: { id: true },
    });
    if (!target) { res.status(404).json({ error: 'No such user' }); return; }
    if (target.id === req.userId!) { res.status(400).json({ error: "You can't friend yourself" }); return; }

    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: req.userId!, addresseeId: target.id },
          { requesterId: target.id, addresseeId: req.userId! },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'accepted') { res.status(409).json({ error: 'Already friends' }); return; }
      if (existing.requesterId === req.userId!) { res.status(409).json({ error: 'Request already sent' }); return; }
      // They already requested us — accept it
      await prisma.friendship.update({
        where: { id: existing.id },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      await prisma.notification.create({
        data: { userId: existing.requesterId, type: 'friend_accept', actorId: req.userId! },
      });
      res.status(200).json({ ok: true, accepted: true });
      return;
    }

    await prisma.friendship.create({
      data: { requesterId: req.userId!, addresseeId: target.id, status: 'pending' },
    });
    await prisma.notification.create({
      data: { userId: target.id, type: 'friend_request', actorId: req.userId! },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error(err, 'Send friend request error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/friends/requests/:id/accept — addressee only
router.post('/requests/:id/accept', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const fr = await prisma.friendship.findFirst({
      where: { id: req.params.id, addresseeId: req.userId!, status: 'pending' },
    });
    if (!fr) { res.status(404).json({ error: 'Request not found' }); return; }
    await prisma.friendship.update({
      where: { id: fr.id },
      data: { status: 'accepted', respondedAt: new Date() },
    });
    await prisma.notification.create({
      data: { userId: fr.requesterId, type: 'friend_accept', actorId: req.userId! },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Accept friend request error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/friends/requests/:id/decline — decline an incoming request or
// cancel an outgoing one; either way the pending row is removed.
router.post('/requests/:id/decline', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await prisma.friendship.deleteMany({
      where: {
        id: req.params.id,
        status: 'pending',
        OR: [{ addresseeId: req.userId! }, { requesterId: req.userId! }],
      },
    });
    if (result.count === 0) { res.status(404).json({ error: 'Request not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Decline friend request error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/friends/:userId — unfriend
router.delete('/:userId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await prisma.friendship.deleteMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: req.userId!, addresseeId: req.params.userId },
          { requesterId: req.params.userId, addresseeId: req.userId! },
        ],
      },
    });
    if (result.count === 0) { res.status(404).json({ error: 'Not friends' }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Unfriend error');
    res.status(500).json({ error: 'Server error' });
  }
});

export { friendIdsOf };
export default router;
