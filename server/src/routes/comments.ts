import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import {
  canonicalArticleKey,
  sanitizeCommentHtml,
  isBlankHtml,
  isHttpUrl,
  commentTextLength,
  MAX_COMMENT_BODY,
  MAX_COMMENT_TEXT,
  MAX_COMMENT_TITLE,
} from '../lib/comments';
import { deleteCommentPreservingThread } from '../lib/commentDeletion';
import { friendIdsOf } from '../lib/friends';
import { blockWallOf, notWalledWhere } from '../lib/blocks';
import { Visibility, isVisibility, visibilityWhere, canModerateComment } from '../lib/commentVisibility';
import { assembleThread } from '../lib/commentTree';
import { canSeePost } from '../lib/blog';
import { exploredPathCounts } from '../lib/exploredPaths';
import { perUserLimiter } from '../lib/rateLimit';
import { limitsForUser } from '../lib/trust';

const router = Router();
// Reads (list a thread, counts, a comment's history) are public so a shared
// thread link works logged-out; writes below opt back in with requireAuth.
router.use(optionalAuth);

const MAX_URLS_PER_COUNT = 200;

// Read prefs, friends and blocks for whoever is viewing. An anonymous viewer
// sees public comments only: prefs default to showing them, and they have
// neither friends nor blocks.
async function viewerContext(userId: string | undefined): Promise<{
  showPublic: boolean; sort: 'newest' | 'oldest'; friendIds: Set<string>; wall: Set<string>;
}> {
  if (!userId) return { showPublic: true, sort: 'newest', friendIds: new Set(), wall: new Set() };
  const [{ showPublic, sort }, friendIds, wall] = await Promise.all([
    viewerPrefs(userId),
    friendIdsOf(userId),
    blockWallOf(userId),
  ]);
  return { showPublic, sort, friendIds, wall };
}

// Per-user write limits (keyed on userId, so a single account can't spam even
// across IPs). A burst cap for fast back-and-forth, plus an hourly ceiling.
// These also bound notification fan-out, since a friends-comment notifies every
// friend and a reply notifies the parent author.
// Both scale with the account's trust level (lib/trust.ts): an hour-old account
// can still join a conversation, just not flood one. The 'established' numbers
// are the values that previously applied to everyone, so this is not a
// tightening for ordinary users.
const commentBurstLimiter = perUserLimiter({
  windowMs: 60_000,
  max: async (req) => (await limitsForUser(req.userId)).commentsPerMinute,
  message: "You're posting comments too fast — take a breather and try again in a moment.",
});
const commentHourlyLimiter = perUserLimiter({
  windowMs: 60 * 60_000,
  max: async (req) => (await limitsForUser(req.userId)).commentsPerHour,
  message: "You've hit the hourly comment limit — please try again later.",
});

// Author fields exposed on every comment. Never the email or anything else
// private — public comments are readable by every signed-in user.
const AUTHOR_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatar: true,
  // Every comment says whether its author is an AI persona. Selected here rather
  // than looked up when rendering, because this is the one query in the app that
  // returns hundreds of authors at once and the badge must never be the thing
  // that got left off. See User.isPersona.
  isPersona: true,
} as const;

type CommentRow = {
  id: string;
  userId: string;
  articleUrl: string;
  parentId: string | null;
  title: string | null;
  body: string;
  visibility: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; username: string; firstName: string | null; lastName: string | null; avatar: string | null; isPersona: boolean };
};

interface CommentNode {
  id: string;
  parentId: string | null;
  title: string | null;
  body: string;
  visibility: string;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  mine: boolean;
  // True only when the viewer is an admin looking at somebody *else's* live
  // comment. Decided here rather than in the client so the moderation controls
  // can never be conjured up by a non-admin editing their own state — and so a
  // comment you wrote yourself offers the ordinary Delete, not a mod action.
  canModerate: boolean;
  // isPersona travels with the author on every node, replies included. The
  // client draws the "AI" badge from it; nothing else in the payload discloses
  // that the writer is a persona.
  author: { username: string; displayName: string; avatar: string | null; isPersona: boolean };
  replies: CommentNode[];
}

function displayName(u: CommentRow['user']): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.username;
}

function toNode(row: CommentRow, viewerId: string | undefined, viewerIsAdmin = false): CommentNode {
  // A tombstone exposes no content or author identity — only its place in the
  // tree, so replies beneath it still read in order. There is nothing left to
  // moderate on one either.
  if (row.deletedAt) {
    return {
      id: row.id,
      parentId: row.parentId,
      title: null,
      body: '',
      visibility: row.visibility,
      deleted: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      mine: false,
      canModerate: false,
      author: { username: '', displayName: '[deleted]', avatar: null, isPersona: false },
      replies: [],
    };
  }
  const mine = row.userId === viewerId;
  const canModerate = canModerateComment({ viewerIsAdmin: viewerIsAdmin, isOwn: mine, deleted: false });
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    deleted: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mine,
    canModerate,
    author: {
      username: row.user.username,
      displayName: displayName(row.user),
      avatar: row.user.avatar,
      isPersona: row.user.isPersona === true,
    },
    replies: [],
  };
}

// Builds the reply tree. The assembly (including what happens to a reply whose
// parent isn't in the list) lives in lib/commentTree, shared with the
// moderator's thread view; this only decides what each row looks like.
function buildTree(
  rows: CommentRow[],
  viewerId: string | undefined,
  sort: 'newest' | 'oldest',
  viewerIsAdmin = false,
): CommentNode[] {
  return assembleThread(rows.map(r => toNode(r, viewerId, viewerIsAdmin)), sort);
}

// Whether this viewer wants other people's public comments in their threads.
async function viewerPrefs(userId: string): Promise<{ showPublic: boolean; sort: 'newest' | 'oldest' }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const s = (user?.settings ?? {}) as Record<string, unknown>;
  return {
    showPublic: s.commentsShowPublic !== false,
    sort: s.commentsSort === 'oldest' ? 'oldest' : 'newest',
  };
}

// ── Blog-post threads ────────────────────────────────────────────────────────
// Most articleKeys belong to feed items, which nobody owns and which anyone may
// discuss. A key that resolves to a BlogPost is different: the thread has to
// inherit the post's own visibility, because comment visibility alone doesn't
// cover it — a *public* comment on a *friends-only* post would otherwise be
// readable by the whole world. Posts can also switch commenting off entirely.
//
// These helpers no-op for every non-blog key, so article threads behave exactly
// as they did before.

type BlogGate =
  | { kind: 'not-blog' }              // an ordinary article — no extra rules
  | { kind: 'hidden' }                // a post this viewer may not read
  | { kind: 'ok'; commentsEnabled: boolean };

async function blogGate(articleKey: string, viewerId: string | undefined, friendIds: Set<string>): Promise<BlogGate> {
  const post = await prisma.blogPost.findUnique({
    where: { articleKey },
    select: { userId: true, visibility: true, commentsEnabled: true },
  });
  if (!post) return { kind: 'not-blog' };
  if (!canSeePost(post, viewerId, friendIds)) return { kind: 'hidden' };
  return { kind: 'ok', commentsEnabled: post.commentsEnabled };
}

// Batch form for the counts endpoint: which of these keys are blog posts the
// viewer may not read. One query regardless of how many keys are in play.
async function hiddenBlogKeys(
  keys: string[],
  viewerId: string | undefined,
  friendIds: Set<string>,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const posts = await prisma.blogPost.findMany({
    where: { articleKey: { in: keys } },
    select: { articleKey: true, userId: true, visibility: true },
  });
  return new Set(
    posts.filter(p => !canSeePost(p, viewerId, friendIds)).map(p => p.articleKey),
  );
}

// Fan out notifications for a freshly-created comment: the author of a comment
// you reply to hears about it, and when you post a friends-only comment your
// friends do. Public comments notify no one — that would be noise.
async function notifyOnComment(
  authorId: string,
  commentId: string,
  visibility: Visibility,
  articleUrl: string,
  articleTitle: string,
  parentAuthorId: string | null,
): Promise<void> {
  const key = canonicalArticleKey(articleUrl);
  const rows: {
    userId: string; type: string; actorId: string;
    articleKey: string; articleUrl: string; articleTitle: string; commentId: string;
  }[] = [];
  const recipients = new Set<string>();

  if (parentAuthorId && parentAuthorId !== authorId) {
    recipients.add(parentAuthorId);
    rows.push({ userId: parentAuthorId, type: 'comment_reply', actorId: authorId, articleKey: key, articleUrl, articleTitle, commentId });
  }

  if (visibility === 'friends') {
    const friendIds = await friendIdsOf(authorId);
    for (const fid of friendIds) {
      if (fid === authorId || recipients.has(fid)) continue; // don't double-notify the parent author
      recipients.add(fid);
      rows.push({ userId: fid, type: 'friend_comment', actorId: authorId, articleKey: key, articleUrl, articleTitle, commentId });
    }
  }

  if (rows.length > 0) {
    await prisma.notification.createMany({ data: rows });
  }
}

// GET /api/v1/comments?url=<article url>
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const url = req.query.url;
  if (!isHttpUrl(url)) { res.status(400).json({ error: 'url must be an http(s) URL' }); return; }

  try {
    const { showPublic, sort, friendIds, wall } = await viewerContext(req.userId);
    const key = canonicalArticleKey(url);

    // A post they can't read answers as an empty thread rather than a 403 — the
    // same shape an article with no comments returns, so the response doesn't
    // reveal that anything is being withheld.
    const gate = await blogGate(key, req.userId, friendIds);
    if (gate.kind === 'hidden') { res.json({ comments: [], total: 0 }); return; }

    // Comments by anyone behind the wall never load. buildTree already lifts a
    // reply whose parent is missing up to root level, so removing someone
    // mid-thread leaves the replies to them readable rather than orphaned.
    const rows = await prisma.comment.findMany({
      where: {
        articleKey: key,
        ...visibilityWhere(req.userId, showPublic, friendIds),
        ...notWalledWhere(wall),
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
      include: { user: { select: AUTHOR_SELECT } },
    });
    const tree = buildTree(rows as CommentRow[], req.userId, sort, req.isAdmin);
    res.json({ comments: tree, total: rows.length });
  } catch (err) {
    logger.error(err, 'List comments error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/comments/counts  { urls: [...] }
//   -> { counts: { "<url>": total }, paths: { "<url>": n } }
//
// One round-trip for a screenful of cards instead of a request per card.
//
// `counts` is the whole discussion: comments, plus the posts and shared
// explores about the article (see lib/exploredPaths). A card says how much
// there is to come back for, and before this it said only how many replies -
// so an article somebody had written a whole post about reported nothing.
//
// `paths` is that second half on its own. The client needs it because posting a
// comment reports a new *comment* total, and without knowing what the rest of
// the discussion came to, adding a reply would wipe the posts and explores out
// of the number until the next reload.
router.post('/counts', async (req: AuthRequest, res: Response): Promise<void> => {
  const urls: unknown = req.body?.urls;
  if (!Array.isArray(urls)) { res.status(400).json({ error: 'urls must be an array' }); return; }

  const valid = (urls as unknown[]).filter(isHttpUrl).slice(0, MAX_URLS_PER_COUNT);
  if (valid.length === 0) { res.json({ counts: {}, paths: {} }); return; }

  try {
    const { showPublic, friendIds, wall } = await viewerContext(req.userId);
    // Several URLs can share one key, so count by key then fan back out
    const keyByUrl = new Map(valid.map(u => [u, canonicalArticleKey(u)]));
    const keys = [...new Set(keyByUrl.values())];
    const [grouped, pathsByKey, hidden] = await Promise.all([
      prisma.comment.groupBy({
        by: ['articleKey'],
        where: {
          articleKey: { in: keys },
          ...visibilityWhere(req.userId, showPublic, friendIds),
          // Counts follow the thread: a card must not advertise comments that
          // vanish when the thread opens.
          ...notWalledWhere(wall),
        },
        _count: { _all: true },
      }),
      // Scoped by the same rules the reader's Explored paths list uses, so the
      // number on the card and the rows on the page cannot disagree.
      exploredPathCounts(keys, req.userId),
      // Blog posts the viewer can't read report zero — a count is a small leak,
      // but it still tells them a post exists behind the URL.
      hiddenBlogKeys(keys, req.userId, friendIds),
    ]);
    const byKey = new Map(grouped.map(g => [g.articleKey, g._count._all]));
    const counts: Record<string, number> = {};
    const paths: Record<string, number> = {};
    for (const [url, key] of keyByUrl) {
      // A hidden post reports nothing at all, not merely no comments: the
      // explores and posts about it would leak its existence just as readily.
      const n = hidden.has(key) ? 0 : (pathsByKey.get(key) ?? 0);
      paths[url] = n;
      counts[url] = hidden.has(key) ? 0 : (byKey.get(key) ?? 0) + n;
    }
    res.json({ counts, paths });
  } catch (err) {
    logger.error(err, 'Comment counts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/comments
router.post('/', requireAuth, commentBurstLimiter, commentHourlyLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { url, articleTitle, parentId, title, body, visibility } = req.body as Record<string, unknown>;

  if (!isHttpUrl(url)) { res.status(400).json({ error: 'url must be an http(s) URL' }); return; }
  if (typeof body !== 'string' || body.length > MAX_COMMENT_BODY) {
    res.status(400).json({ error: `body must be a string of ≤${MAX_COMMENT_BODY} characters` }); return;
  }
  if (isBlankHtml(body)) { res.status(400).json({ error: 'Comment is empty' }); return; }
  if (commentTextLength(body) > MAX_COMMENT_TEXT) {
    res.status(400).json({ error: `Comment is too long — keep it under ${MAX_COMMENT_TEXT.toLocaleString()} characters` }); return;
  }
  if (title !== undefined && title !== null && typeof title !== 'string') {
    res.status(400).json({ error: 'title must be a string' }); return;
  }
  if (typeof title === 'string' && title.length > MAX_COMMENT_TITLE) {
    res.status(400).json({ error: `title must be ≤${MAX_COMMENT_TITLE} characters` }); return;
  }
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    res.status(400).json({ error: 'parentId must be a string' }); return;
  }
  if (visibility !== undefined && !isVisibility(visibility)) {
    res.status(400).json({ error: "visibility must be 'public', 'friends', or 'private'" }); return;
  }

  const key = canonicalArticleKey(url);
  const vis: Visibility = isVisibility(visibility) ? visibility : 'private';
  const titleText = typeof articleTitle === 'string' ? articleTitle.slice(0, 500) : '';

  try {
    // Blog posts govern their own threads. A post this user can't read answers
    // 404 rather than 403, so posting can't be used to probe for its existence.
    const friendIds = await friendIdsOf(req.userId!);
    const gate = await blogGate(key, req.userId!, friendIds);
    if (gate.kind === 'hidden') { res.status(404).json({ error: 'Not found' }); return; }
    if (gate.kind === 'ok' && !gate.commentsEnabled) {
      res.status(403).json({ error: 'Comments are turned off for this post' }); return;
    }

    // A reply must hang off a comment on the same article that this user is
    // actually allowed to see — otherwise replies could probe private threads.
    // The wall applies here too: replying is the main way to reach someone, so a
    // blocked pair must not be able to answer each other. The parent reads as
    // "not found", the same as a private one.
    let parentAuthorId: string | null = null;
    if (typeof parentId === 'string') {
      const [{ showPublic }, wall] = await Promise.all([
        viewerPrefs(req.userId!),
        blockWallOf(req.userId!),
      ]);
      const parent = await prisma.comment.findFirst({
        where: {
          id: parentId,
          articleKey: key,
          ...visibilityWhere(req.userId!, showPublic, friendIds),
          ...notWalledWhere(wall),
        },
        select: { id: true, userId: true, deletedAt: true },
      });
      if (!parent) { res.status(404).json({ error: 'Parent comment not found' }); return; }
      if (parent.deletedAt) { res.status(409).json({ error: 'You can’t reply to a deleted comment' }); return; }
      parentAuthorId = parent.userId;
    }

    const created = await prisma.comment.create({
      data: {
        userId: req.userId!,
        articleKey: key,
        articleUrl: url,
        articleTitle: titleText,
        // Only a root comment carries a title; replies inherit their thread's
        parentId: typeof parentId === 'string' ? parentId : null,
        title: typeof parentId === 'string' ? null : (typeof title === 'string' && title.trim() ? title.trim() : null),
        body: sanitizeCommentHtml(body),
        visibility: vis,
      },
      include: { user: { select: AUTHOR_SELECT } },
    });

    // Best-effort notifications — never fail the comment over these.
    await notifyOnComment(req.userId!, created.id, vis, url, titleText, parentAuthorId).catch(err =>
      logger.warn(err, 'Comment notification failed')
    );

    res.status(201).json(toNode(created as CommentRow, req.userId!));
  } catch (err) {
    logger.error(err, 'Create comment error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/v1/comments/:id — author only
router.patch('/:id', requireAuth, commentBurstLimiter, commentHourlyLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { title, body, visibility } = req.body as Record<string, unknown>;

  try {
    const existing = await prisma.comment.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true, parentId: true, title: true, body: true, visibility: true, deletedAt: true },
    });
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
    if (existing.deletedAt) { res.status(409).json({ error: 'This comment has been deleted' }); return; }

    const data: Record<string, unknown> = {};
    if (body !== undefined) {
      if (typeof body !== 'string' || body.length > MAX_COMMENT_BODY) {
        res.status(400).json({ error: `body must be a string of ≤${MAX_COMMENT_BODY} characters` }); return;
      }
      if (isBlankHtml(body)) { res.status(400).json({ error: 'Comment is empty' }); return; }
      if (commentTextLength(body) > MAX_COMMENT_TEXT) {
        res.status(400).json({ error: `Comment is too long — keep it under ${MAX_COMMENT_TEXT.toLocaleString()} characters` }); return;
      }
      data.body = sanitizeCommentHtml(body);
    }
    if (title !== undefined) {
      if (title !== null && typeof title !== 'string') {
        res.status(400).json({ error: 'title must be a string or null' }); return;
      }
      if (typeof title === 'string' && title.length > MAX_COMMENT_TITLE) {
        res.status(400).json({ error: `title must be ≤${MAX_COMMENT_TITLE} characters` }); return;
      }
      // Replies never carry a title, however the client asks
      data.title = existing.parentId ? null : (typeof title === 'string' && title.trim() ? title.trim() : null);
    }
    if (visibility !== undefined) {
      if (!isVisibility(visibility)) { res.status(400).json({ error: "visibility must be 'public', 'friends', or 'private'" }); return; }
      data.visibility = visibility;
    }
    if (Object.keys(data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    // A real change (not a no-op re-save) snapshots the pre-edit content into the
    // history, so the "edited" marker always has something to show. Snapshot +
    // update run together so history can't be recorded without the edit landing.
    const changed =
      ('body' in data && data.body !== existing.body) ||
      ('title' in data && data.title !== existing.title) ||
      ('visibility' in data && data.visibility !== existing.visibility);

    const updated = changed
      ? await prisma.$transaction(async tx => {
          await tx.commentRevision.create({
            data: {
              commentId: existing.id,
              title: existing.title,
              body: existing.body,
              visibility: existing.visibility,
            },
          });
          return tx.comment.update({
            where: { id: req.params.id },
            data,
            include: { user: { select: AUTHOR_SELECT } },
          });
        })
      : await prisma.comment.update({
          where: { id: req.params.id },
          data,
          include: { user: { select: AUTHOR_SELECT } },
        });

    res.json(toNode(updated as CommentRow, req.userId!));
  } catch (err) {
    logger.error(err, 'Update comment error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/comments/:id/history — the comment's prior versions, newest first.
// Visible to anyone allowed to see the comment itself (same visibility rule).
router.get('/:id/history', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { showPublic, friendIds, wall } = await viewerContext(req.userId);
    const comment = await prisma.comment.findFirst({
      where: {
        id: req.params.id,
        ...visibilityWhere(req.userId, showPublic, friendIds),
        ...notWalledWhere(wall),
      },
      select: { title: true, body: true, visibility: true, updatedAt: true },
    });
    if (!comment) { res.status(404).json({ error: 'Not found' }); return; }

    const revisions = await prisma.commentRevision.findMany({
      where: { commentId: req.params.id },
      orderBy: { editedAt: 'desc' },
      select: { title: true, body: true, visibility: true, editedAt: true },
    });

    res.json({
      current: { title: comment.title, body: comment.body, visibility: comment.visibility, editedAt: comment.updatedAt },
      revisions,
    });
  } catch (err) {
    logger.error(err, 'Comment history error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/comments/:id — author only. A comment with replies is
// tombstoned (content + edit history wiped, row kept) so the replies survive; a
// leaf comment is removed outright.
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await deleteCommentPreservingThread(req.params.id, req.userId!);
    if (result === 'not-found') { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true, ...(result === 'removed' ? {} : { deleted: true }) });
  } catch (err) {
    logger.error(err, 'Delete comment error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
