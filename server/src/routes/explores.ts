import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { friendIdsOf, toPublicUser, PUBLIC_USER_SELECT, PublicUser } from '../lib/friends';
import { isWalledOff } from '../lib/blocks';

// Reading a *shared* explore thread.
//
// Separate from research.ts because that router applies requireAuth to
// everything under it, and the whole point of a shared thread is that a link to
// one opens for whoever it was sent to — including someone with no account, if
// its author put it on 'public'. Writing an explore, and every route that costs
// a model call, stays over there behind auth.
//
// Nothing here can widen a thread; it only reads one that has already been
// widened. See lib/exploredPaths.ts for why that distinction is handled
// carefully: a transcript can quote its author's private notes back at them.

const router = Router();
router.use(optionalAuth);

// GET /api/v1/explores/:id — one shared thread and its whole conversation.
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const thread = await prisma.researchThread.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, title: true, sourceUrl: true, sourceTitle: true,
        visibility: true, sharedAt: true, createdAt: true, updatedAt: true,
        userId: true, origin: true,
        user: { select: PUBLIC_USER_SELECT },
      },
    });

    // One 404 for "no such thread" and for "not shared with you". Telling them
    // apart would confirm that a given id exists, which is the one thing the
    // owner of a private thread is entitled to keep to themselves.
    if (!thread) { res.status(404).json({ error: 'Not found' }); return; }

    const own = !!req.userId && thread.userId === req.userId;
    let allowed = own || thread.visibility === 'public';
    // A generated thread (origin 'auto') has no owner, so there is nobody to be
    // friends with — the friends tier is unreachable for one by construction,
    // and the null check below is what makes that explicit rather than implicit.
    if (!allowed && thread.visibility === 'friends' && req.userId && thread.userId) {
      allowed = (await friendIdsOf(req.userId)).has(thread.userId);
    }
    // A private thread is unreachable here even for its author: the owner reads
    // it through the research routes, which carry the controls for it. Serving
    // it from the *shared* endpoint would make a private thread look shareable.
    if (thread.visibility === 'private') allowed = false;
    if (!allowed) { res.status(404).json({ error: 'Not found' }); return; }

    // A block hides the thread in both directions, the same mutual wall the
    // rest of the app raises.
    // No owner means no block relationship to check: a generated thread is not
    // anybody's, so it cannot be walled off from anybody.
    if (!own && thread.userId && await isWalledOff(req.userId, thread.userId)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const messages = await prisma.researchMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
      // No `sources` and no `suggestions`: the first is a list of the reader's
      // own feed items, which is their library rather than the conversation,
      // and the second is a set of buttons only the owner can press.
      select: { id: true, role: true, body: true, createdAt: true },
    });

    res.json({
      thread: {
        id: thread.id,
        title: thread.title,
        sourceUrl: thread.sourceUrl,
        sourceTitle: thread.sourceTitle,
        visibility: thread.visibility,
        sharedAt: thread.sharedAt?.toISOString() ?? null,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
        author: thread.user ? toPublicUser(thread.user as PublicUser) : null,
        // A generated thread has no author, and the page must say so rather
        // than simply omitting the byline — an unattributed transcript reads as
        // anonymous rather than as machine-written.
        origin: thread.origin === 'auto' ? 'auto' : 'user',
        own,
      },
      messages: messages.map(m => ({
        id: m.id,
        role: m.role,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error(err, 'Shared explore read error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
