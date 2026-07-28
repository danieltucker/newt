import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import { PUBLIC_USER_SELECT, toPublicUser, friendIdsOf } from '../lib/friends';
import { wallDirection, isWalledOff } from '../lib/blocks';
import { blogFeedUrlFor } from '../lib/blogFeed';
import logger from '../lib/logger';

// Public profile pages: /u/<username>. Served with optionalAuth so a logged-out
// visitor sees only the owner's public comments, while a signed-in friend (or the
// owner) also sees friends-only ones. Private comments and deleted tombstones are
// never exposed here.
const router = Router();
router.use(optionalAuth);

const PAGE_SIZE = 25;

// Owner-centric visibility filter: this user's comments, minus tombstones, scoped
// to what the viewer is allowed to see. `canSeeFriends` is true for the owner
// themselves and for accepted friends.
function profileCommentWhere(ownerId: string, canSeeFriends: boolean) {
  return {
    userId: ownerId,
    deletedAt: null,
    visibility: canSeeFriends ? { in: ['public', 'friends'] } : 'public',
  };
}

// Owner-centric post filter. Drafts ('private') belong to nobody but the author,
// so only they ever see them here; friends-only posts need `canSeeFriends`.
// Drafts are never on a profile - not even the owner's own. A profile is the
// page you hand to someone else; a draft is unfinished work, and the place to
// find it is My posts. Before this, `isSelf` dropped the filter entirely, so an
// author's own drafts appeared in their Posts and Activity tabs and were counted
// in the header's post count.
//
// This governs the count and the activity feed; the Posts tab is listed by
// blogs.ts, which excludes drafts for the same reason.
function profilePostWhere(ownerId: string, isSelf: boolean, canSeeFriends: boolean) {
  return {
    userId: ownerId,
    visibility: isSelf || canSeeFriends ? { in: ['public', 'friends'] } : 'public',
  };
}

// The viewer's relationship to the profile owner, for the Add-friend control.
// Only meaningful when the viewer is signed in and looking at someone else.
async function relationTo(viewerId: string, ownerId: string): Promise<'none' | 'friends' | 'incoming' | 'outgoing'> {
  const fr = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: viewerId, addresseeId: ownerId },
        { requesterId: ownerId, addresseeId: viewerId },
      ],
    },
    select: { requesterId: true, status: true },
  });
  if (!fr) return 'none';
  if (fr.status === 'accepted') return 'friends';
  return fr.requesterId === viewerId ? 'outgoing' : 'incoming';
}

// Look up a non-banned user by username (case-insensitive). Returns null so the
// caller can 404 without distinguishing "no such user" from "banned".
async function findOwner(username: string) {
  return prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' }, bannedAt: null },
    select: { ...PUBLIC_USER_SELECT, createdAt: true },
  });
}

async function canSeeFriendsOf(ownerId: string, viewerId: string | undefined): Promise<boolean> {
  if (!viewerId) return false;
  if (viewerId === ownerId) return true;
  return (await friendIdsOf(ownerId)).has(viewerId);
}

// GET /api/v1/profiles/:username — profile header
router.get('/:username', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const owner = await findOwner(req.params.username);
    if (!owner) { res.status(404).json({ error: 'Profile not found' }); return; }

    const isSelf = req.userId === owner.id;

    // The one place the two sides of a wall are told apart. Whoever raised it
    // gets a stub profile carrying the Unblock button — they chose this and
    // need a way back. Whoever was blocked gets a plain 404, identical to a
    // username that was never registered.
    const wall = await wallDirection(req.userId, owner.id);
    if (wall === 'they-blocked-you') { res.status(404).json({ error: 'Profile not found' }); return; }
    if (wall === 'you-blocked-them') {
      res.json({
        ...toPublicUser(owner),
        createdAt: owner.createdAt,
        commentCount: 0,
        postCount: 0,
        isSelf: false,
        relation: 'none' as const,
        blocked: true,
        blogFeedUrl: '',
      });
      return;
    }

    const canSeeFriends = await canSeeFriendsOf(owner.id, req.userId);
    const [commentCount, postCount, relation] = await Promise.all([
      prisma.comment.count({ where: profileCommentWhere(owner.id, canSeeFriends) }),
      prisma.blogPost.count({ where: profilePostWhere(owner.id, isSelf, canSeeFriends) }),
      req.userId && !isSelf ? relationTo(req.userId, owner.id) : Promise.resolve('none' as const),
    ]);

    res.json({
      ...toPublicUser(owner),
      createdAt: owner.createdAt,
      commentCount,
      postCount,
      isSelf,
      relation,
      blocked: false,
      blogFeedUrl: blogFeedUrlFor(owner.username),
    });
  } catch (err) {
    logger.error(err, 'Profile header error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/profiles/:username/comments?cursor=<id> — the owner's comments,
// newest first, page by page.
router.get('/:username/comments', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const owner = await findOwner(req.params.username);
    if (!owner) { res.status(404).json({ error: 'Profile not found' }); return; }

    if (await isWalledOff(req.userId, owner.id)) { res.json({ comments: [], nextCursor: null }); return; }

    const canSeeFriends = await canSeeFriendsOf(owner.id, req.userId);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const rows = await prisma.comment.findMany({
      where: profileCommentWhere(owner.id, canSeeFriends),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, title: true, body: true, visibility: true,
        articleUrl: true, articleTitle: true, createdAt: true, updatedAt: true,
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const comments = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    res.json({ comments, nextCursor: hasMore ? comments[comments.length - 1].id : null });
  } catch (err) {
    logger.error(err, 'Profile comments error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/profiles/:username/activity — the profile's main page: what this
// person has put out, blog posts and shared comments together, newest first.
//
// Both halves are over-fetched to PAGE_SIZE, merged, then truncated: that yields
// a correct newest-first page without a cursor that has to encode two positions.
// It caps at one page, which is what a profile landing view wants — the Posts
// and Comments tabs are where you go to read further back.
router.get('/:username/activity', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const owner = await findOwner(req.params.username);
    if (!owner) { res.status(404).json({ error: 'Profile not found' }); return; }

    if (await isWalledOff(req.userId, owner.id)) { res.json({ items: [] }); return; }

    const isSelf = req.userId === owner.id;
    const canSeeFriends = await canSeeFriendsOf(owner.id, req.userId);

    const [posts, comments] = await Promise.all([
      prisma.blogPost.findMany({
        where: profilePostWhere(owner.id, isSelf, canSeeFriends),
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE,
        select: {
          id: true, title: true, slug: true, excerpt: true, heroImage: true, visibility: true,
          commentsEnabled: true, url: true, publishedAt: true, updatedAt: true,
        },
      }),
      prisma.comment.findMany({
        where: profileCommentWhere(owner.id, canSeeFriends),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE,
        select: {
          id: true, title: true, body: true, visibility: true,
          articleUrl: true, articleTitle: true, createdAt: true, updatedAt: true,
        },
      }),
    ]);

    const items = [
      ...posts.map(p => ({ kind: 'post' as const, at: p.publishedAt, post: p })),
      ...comments.map(c => ({ kind: 'comment' as const, at: c.createdAt, comment: c })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, PAGE_SIZE);

    res.json({ items });
  } catch (err) {
    logger.error(err, 'Profile activity error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
