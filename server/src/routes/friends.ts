import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { PUBLIC_USER_SELECT, toPublicUser, friendIdsOf, friendPairKey, isDeclineCooldownActive } from '../lib/friends';
import { blockWallOf, wallDirection, notWalledWhere } from '../lib/blocks';
import { perUserLimiter } from '../lib/rateLimit';
import { limitsForUser } from '../lib/trust';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// Search is the user-enumeration surface; requests are the spam/harassment one.
// Both keyed per user (see lib/rateLimit) so they survive IP rotation.
const searchLimiter = perUserLimiter({
  windowMs: 60_000, max: 30,
  message: 'Too many searches — slow down a moment.',
});
// Scaled by trust: an account in its first day gets a much smaller hourly
// allowance than an established one, and enrolling in 2FA lifts it immediately.
// Nobody is blocked from sending requests — only from sending them in bulk.
const requestLimiter = perUserLimiter({
  windowMs: 60 * 60_000,
  max: async (req) => (await limitsForUser(req.userId)).friendRequestsPerHour,
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
    // Anyone behind a block wall is simply not in the directory — for both
    // sides. Searching is where an unwanted approach starts, so it is the first
    // place the wall has to hold.
    const wall = await blockWallOf(req.userId!);
    const users = await prisma.user.findMany({
      where: {
        // startsWith, not contains. A substring match turns this endpoint into a
        // directory of the whole userbase: at 30 searches/min, sweeping all 1296
        // two-character pairs takes about 40 minutes and every username contains
        // one, so the entire site's real names and avatars can be harvested by
        // any account. A prefix match still finds someone whose username you were
        // told — which is the actual use case — but gives an enumerator nothing
        // better than guessing prefixes.
        username: { startsWith: q, mode: 'insensitive' },
        bannedAt: null,
        NOT: { id: req.userId! },
        ...notWalledWhere(wall, 'id'),
      },
      select: PUBLIC_USER_SELECT,
      take: 10,
      orderBy: { username: 'asc' },
    });
    if (users.length === 0) { res.json({ results: [] }); return; }

    const rels = await prisma.friendship.findMany({
      where: {
        // Only live relationships. A 'declined' row is a cooldown tombstone, not
        // a relationship — including it here would label the declined person
        // "Requested" in the other's search results and quietly leak the refusal.
        status: { in: ['pending', 'accepted'] },
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

// What to do when a row for this pair already exists. Shared by the ordinary
// path and by the P2002 retry, so a request that loses the insert race gets the
// identical answer to one that simply read the row first.
type ExistingFriendship = {
  id: string; status: string; requesterId: string; respondedAt: Date | null;
};

async function respondToExisting(
  existing: ExistingFriendship,
  userId: string,
  targetId: string,
  res: Response,
): Promise<void> {
  if (existing.status === 'accepted') {
    res.status(409).json({ error: 'Already friends' }); return;
  }

  if (existing.status === 'declined') {
    // Declined, and this is the person who was declined asking again. Answer
    // exactly as a successful send would: a distinguishable error would confirm
    // both that the account exists and that they were turned down, which is the
    // signal that provokes the second account. The cost is that the request looks
    // sent until the page is reloaded — worth it to keep the refusal silent.
    if (isDeclineCooldownActive(existing, userId)) {
      res.status(201).json({ ok: true }); return;
    }
    // Either the cooldown has expired, or this is the *decliner* changing their
    // mind. Re-open the row in the new direction — pairKey is unique, so reusing
    // it is the only way to record the fresh request.
    await prisma.friendship.update({
      where: { id: existing.id },
      data: {
        requesterId: userId, addresseeId: targetId,
        status: 'pending', createdAt: new Date(), respondedAt: null,
      },
    });
    await prisma.notification.create({
      data: { userId: targetId, type: 'friend_request', actorId: userId },
    });
    res.status(201).json({ ok: true }); return;
  }

  // pending
  if (existing.requesterId === userId) {
    res.status(409).json({ error: 'Request already sent' }); return;
  }
  // They already requested us — accept theirs rather than stacking a second row.
  await prisma.friendship.update({
    where: { id: existing.id },
    data: { status: 'accepted', respondedAt: new Date() },
  });
  await prisma.notification.create({
    data: { userId: existing.requesterId, type: 'friend_accept', actorId: userId },
  });
  res.status(200).json({ ok: true, accepted: true });
}

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

    // A wall in either direction stops the request, but the two answers differ
    // on purpose. Someone who blocked this person is told so, because they can
    // undo it. Someone who *was* blocked gets the same 404 a made-up username
    // returns — telling them would hand back exactly the signal that blocking
    // exists to withhold, and it is the signal that provokes a second account.
    const wall = await wallDirection(req.userId!, target.id);
    if (wall === 'you-blocked-them') {
      res.status(409).json({ error: 'You’ve blocked this person. Unblock them first.' }); return;
    }
    if (wall === 'they-blocked-you') { res.status(404).json({ error: 'No such user' }); return; }

    // One row per pair, found by the direction-independent key, so the reciprocal
    // request finds *our* row rather than missing it and inserting a second one.
    const pairKey = friendPairKey(req.userId!, target.id);
    const existing = await prisma.friendship.findUnique({ where: { pairKey } });
    if (existing) {
      await respondToExisting(existing, req.userId!, target.id, res);
      return;
    }

    try {
      await prisma.friendship.create({
        data: { requesterId: req.userId!, addresseeId: target.id, status: 'pending', pairKey },
      });
    } catch (err) {
      // Lost the insert race: between our read and our write the other person's
      // request landed on the same pairKey. That is not an error — it is exactly
      // the "they already asked us" case, one moment later. Re-read and answer as
      // if we had seen their row all along, which accepts their request.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const raced = await prisma.friendship.findUnique({ where: { pairKey } });
      if (!raced) { res.status(409).json({ error: 'Could not send request — try again' }); return; }
      await respondToExisting(raced, req.userId!, target.id, res);
      return;
    }

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
// cancel an outgoing one. These look alike in the UI but must not behave alike:
//
//   declining  keeps the row as a 'declined' tombstone, which starts the
//              re-request cooldown. Deleting it (the old behaviour) let the
//              requester re-send instantly, and again, and again — the whole
//              point of declining was to stop that.
//   cancelling deletes the row outright. It is your own request being withdrawn,
//              so there is nobody to protect and no reason to lock yourself out.
router.post('/requests/:id/decline', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const fr = await prisma.friendship.findFirst({
      where: {
        id: req.params.id,
        status: 'pending',
        OR: [{ addresseeId: req.userId! }, { requesterId: req.userId! }],
      },
      select: { id: true, addresseeId: true },
    });
    if (!fr) { res.status(404).json({ error: 'Request not found' }); return; }

    if (fr.addresseeId === req.userId!) {
      await prisma.friendship.update({
        where: { id: fr.id },
        data: { status: 'declined', respondedAt: new Date() },
      });
    } else {
      await prisma.friendship.delete({ where: { id: fr.id } });
    }
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
