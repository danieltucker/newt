import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
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
import { friendIdsOf } from '../lib/friends';
import { Visibility, isVisibility, visibilityWhere } from '../lib/commentVisibility';
import { perUserLimiter } from '../lib/rateLimit';

const router = Router();
router.use(requireAuth);

const MAX_URLS_PER_COUNT = 200;

// Per-user write limits (keyed on userId, so a single account can't spam even
// across IPs). A burst cap for fast back-and-forth, plus an hourly ceiling.
// These also bound notification fan-out, since a friends-comment notifies every
// friend and a reply notifies the parent author.
const commentBurstLimiter = perUserLimiter({
  windowMs: 60_000, max: 8,
  message: "You're posting comments too fast — take a breather and try again in a moment.",
});
const commentHourlyLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 60,
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
} as const;

type CommentRow = {
  id: string;
  userId: string;
  articleUrl: string;
  parentId: string | null;
  title: string | null;
  body: string;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; username: string; firstName: string | null; lastName: string | null; avatar: string | null };
};

interface CommentNode {
  id: string;
  parentId: string | null;
  title: string | null;
  body: string;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
  mine: boolean;
  author: { username: string; displayName: string; avatar: string | null };
  replies: CommentNode[];
}

function displayName(u: CommentRow['user']): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.username;
}

function toNode(row: CommentRow, viewerId: string): CommentNode {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mine: row.userId === viewerId,
    author: {
      username: row.user.username,
      displayName: displayName(row.user),
      avatar: row.user.avatar,
    },
    replies: [],
  };
}

// Builds the reply tree. Rows whose parent isn't visible to this viewer (a
// private parent, or one deleted mid-flight) are surfaced at root level rather
// than silently dropped, so no one loses a comment they can see.
function buildTree(rows: CommentRow[], viewerId: string, sort: 'newest' | 'oldest'): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const r of rows) byId.set(r.id, toNode(r, viewerId));

  const roots: CommentNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }

  const dir = sort === 'oldest' ? 1 : -1;
  const byDate = (a: CommentNode, b: CommentNode) =>
    dir * (a.createdAt.getTime() - b.createdAt.getTime());
  // Replies always read oldest-first — a conversation only makes sense in order
  const sortReplies = (n: CommentNode) => {
    n.replies.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    n.replies.forEach(sortReplies);
  };
  roots.sort(byDate);
  roots.forEach(sortReplies);
  return roots;
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
    const [{ showPublic, sort }, friendIds] = await Promise.all([
      viewerPrefs(req.userId!),
      friendIdsOf(req.userId!),
    ]);
    const rows = await prisma.comment.findMany({
      where: {
        articleKey: canonicalArticleKey(url),
        ...visibilityWhere(req.userId!, showPublic, friendIds),
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
      include: { user: { select: AUTHOR_SELECT } },
    });
    const tree = buildTree(rows as CommentRow[], req.userId!, sort);
    res.json({ comments: tree, total: rows.length });
  } catch (err) {
    logger.error(err, 'List comments error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/comments/counts  { urls: [...] } -> { "<url>": n }
// One round-trip for a screenful of cards instead of a request per card.
router.post('/counts', async (req: AuthRequest, res: Response): Promise<void> => {
  const urls: unknown = req.body?.urls;
  if (!Array.isArray(urls)) { res.status(400).json({ error: 'urls must be an array' }); return; }

  const valid = (urls as unknown[]).filter(isHttpUrl).slice(0, MAX_URLS_PER_COUNT);
  if (valid.length === 0) { res.json({ counts: {} }); return; }

  try {
    const [{ showPublic }, friendIds] = await Promise.all([
      viewerPrefs(req.userId!),
      friendIdsOf(req.userId!),
    ]);
    // Several URLs can share one key, so count by key then fan back out
    const keyByUrl = new Map(valid.map(u => [u, canonicalArticleKey(u)]));
    const grouped = await prisma.comment.groupBy({
      by: ['articleKey'],
      where: {
        articleKey: { in: [...new Set(keyByUrl.values())] },
        ...visibilityWhere(req.userId!, showPublic, friendIds),
      },
      _count: { _all: true },
    });
    const byKey = new Map(grouped.map(g => [g.articleKey, g._count._all]));
    const counts: Record<string, number> = {};
    for (const [url, key] of keyByUrl) counts[url] = byKey.get(key) ?? 0;
    res.json({ counts });
  } catch (err) {
    logger.error(err, 'Comment counts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/comments
router.post('/', commentBurstLimiter, commentHourlyLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
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
    // A reply must hang off a comment on the same article that this user is
    // actually allowed to see — otherwise replies could probe private threads.
    let parentAuthorId: string | null = null;
    if (typeof parentId === 'string') {
      const [{ showPublic }, friendIds] = await Promise.all([
        viewerPrefs(req.userId!),
        friendIdsOf(req.userId!),
      ]);
      const parent = await prisma.comment.findFirst({
        where: { id: parentId, articleKey: key, ...visibilityWhere(req.userId!, showPublic, friendIds) },
        select: { id: true, userId: true },
      });
      if (!parent) { res.status(404).json({ error: 'Parent comment not found' }); return; }
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
router.patch('/:id', commentBurstLimiter, commentHourlyLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { title, body, visibility } = req.body as Record<string, unknown>;

  try {
    const existing = await prisma.comment.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true, parentId: true },
    });
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

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

    const updated = await prisma.comment.update({
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

// DELETE /api/v1/comments/:id — author only; replies cascade with the parent
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await prisma.comment.deleteMany({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Delete comment error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
