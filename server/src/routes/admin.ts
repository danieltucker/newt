import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { deleteCommentPreservingThread } from '../lib/commentDeletion';
import { assembleThread } from '../lib/commentTree';
import { canonicalArticleKey } from '../lib/comments';
import { excerptOf } from '../lib/blog';
import { recordAdminAction, ADMIN_ACTIONS, actionLabel, isDestructive } from '../lib/adminAudit';
import { categoryLabel, isResolution, MAX_REPORT_NOTE } from '../lib/reports';
import { ERROR_LOG_RETENTION_DAYS } from '../lib/errorLog';
import { FEED_LOG_RETENTION_DAYS } from '../lib/feedLog';
import { FEED_FAILURE_ALERT_THRESHOLD } from '../lib/adminAlerts';
import { canonicalFeedKey } from '../lib/feedUtils';
import { DEMAND_WINDOW_MS } from '../lib/feedScheduler';

const router = Router();
router.use(requireAuth, requireAdmin);

// The acting admin's username, denormalised into every audit row so the record
// stays readable if that account is later deleted. Resolved once per request,
// outside the transaction — it's a read, and holding the tx open for it buys
// nothing.
async function actorName(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
  return u?.username ?? 'unknown';
}

const SIGNUP_WINDOW_DAYS = 30;
const HISTORY_DAYS = 90;
// Detail tables are for spot-checking and moderation, not archaeology — cap the
// rows so a busy instance can't turn the admin panel into a full table dump.
const DETAIL_LIMIT = 200;
const SNIPPET_CHARS = 160;
// The audit view pages instead of capping — see GET /audit.
const AUDIT_PAGE = 50;
// The report queue pages for the same reason: it is work to get through, and a
// cap would silently hide the oldest thing waiting.
const REPORT_PAGE = 50;
// The error log pages too — the first occurrence of a fault is often the most
// informative one, and it's the one a cap would cut.
const ERROR_PAGE = 50;
// Failing feeds don't page: the list is standing state, not history, and if it
// is longer than this the problem isn't a particular feed.
const FAILING_FEED_LIMIT = 100;
// The full feed list and the refresh log both page — every feed on the instance
// is a long list, and the log is longer still.
const FEED_PAGE = 50;
const FEED_LOG_PAGE = 50;
// How far back the log's outcome tallies look. A day covers roughly 48 checks
// of a feed at the 30-minute stale window, which is enough to see a pattern
// without the number being dominated by last week.
const FEED_LOG_SUMMARY_MS = 24 * 60 * 60 * 1000;

const VISIBILITIES = ['public', 'friends', 'private'] as const;
type VisibilityCounts = Record<(typeof VISIBILITIES)[number], number>;

// groupBy returns only the visibilities actually present; zero-fill the rest so
// the client can render a stable three-part meter.
function visibilityCounts(rows: { visibility: string; _count: { _all: number } }[]): VisibilityCounts {
  const counts: VisibilityCounts = { public: 0, friends: 0, private: 0 };
  for (const row of rows) {
    if (row.visibility in counts) counts[row.visibility as keyof VisibilityCounts] = row._count._all;
  }
  return counts;
}

// Daily buckets of "date → cumulative total", zero-filled across the window.
// Deletions aren't tracked historically, so totals reflect rows that still
// exist, bucketed by when they were created.
function cumulativeSeries(baseline: number, created: { createdAt: Date }[], start: Date, days: number): { date: string; total: number }[] {
  const perDay = new Map<string, number>();
  for (const row of created) {
    const key = row.createdAt.toISOString().slice(0, 10);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const series: { date: string; total: number }[] = [];
  let running = baseline;
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    running += perDay.get(key) ?? 0;
    series.push({ date: key, total: running });
  }
  return series;
}

router.get('/stats', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (SIGNUP_WINDOW_DAYS - 1));

    const histStart = new Date();
    histStart.setHours(0, 0, 0, 0);
    histStart.setDate(histStart.getDate() - (HISTORY_DAYS - 1));

    // Tombstoned comments are rows without content — they're structural, so they
    // never count as comments and are reported on their own.
    const liveComments = { deletedAt: null };

    const [
      users, admins, totpUsers, bookmarks, folders, readingItems, feedArticles,
      comments, deletedComments, commentReplies, commentEdits,
      blogPosts, publishedPosts, images, imageBytes, friendships,
      blocks, openReports,
      recentUsers, activeTokens,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isAdmin: true } }),
      prisma.user.count({ where: { totpEnabled: true } }),
      prisma.bookmark.count(),
      prisma.folder.count(),
      prisma.readingListItem.count(),
      prisma.feedItem.count(),
      prisma.comment.count({ where: liveComments }),
      prisma.comment.count({ where: { deletedAt: { not: null } } }),
      prisma.comment.count({ where: { ...liveComments, parentId: { not: null } } }),
      prisma.commentRevision.count(),
      prisma.blogPost.count(),
      prisma.blogPost.count({ where: { visibility: { not: 'private' } } }),
      prisma.image.count(),
      prisma.image.aggregate({ _sum: { size: true } }),
      prisma.friendship.count({ where: { status: 'accepted' } }),
      prisma.block.count(),
      prisma.report.count({ where: { status: 'open' } }),
      prisma.user.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      // Sessions created in the last 7 days ≈ recently active users
      prisma.refreshToken.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    // Cumulative history: baseline before the window + per-day additions within it
    const [
      userBaseline, userCreated,
      bookmarkBaseline, bookmarkCreated,
      commentBaseline, commentCreated,
      postBaseline, postCreated,
      commentVisibility, postVisibility,
    ] = await Promise.all([
      prisma.user.count({ where: { createdAt: { lt: histStart } } }),
      prisma.user.findMany({ where: { createdAt: { gte: histStart } }, select: { createdAt: true } }),
      prisma.bookmark.count({ where: { createdAt: { lt: histStart } } }),
      prisma.bookmark.findMany({ where: { createdAt: { gte: histStart } }, select: { createdAt: true } }),
      prisma.comment.count({ where: { ...liveComments, createdAt: { lt: histStart } } }),
      prisma.comment.findMany({ where: { ...liveComments, createdAt: { gte: histStart } }, select: { createdAt: true } }),
      prisma.blogPost.count({ where: { createdAt: { lt: histStart } } }),
      prisma.blogPost.findMany({ where: { createdAt: { gte: histStart } }, select: { createdAt: true } }),
      prisma.comment.groupBy({ by: ['visibility'], where: liveComments, _count: { _all: true } }),
      prisma.blogPost.groupBy({ by: ['visibility'], _count: { _all: true } }),
    ]);

    // Bucket signups per day over the window (zero-filled)
    const signups: { date: string; count: number }[] = [];
    for (let i = 0; i < SIGNUP_WINDOW_DAYS; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      signups.push({ date: d.toISOString().slice(0, 10), count: 0 });
    }
    const byDate = new Map(signups.map(s => [s.date, s]));
    for (const u of recentUsers) {
      const key = u.createdAt.toISOString().slice(0, 10);
      const bucket = byDate.get(key);
      if (bucket) bucket.count++;
    }

    res.json({
      totals: {
        users, admins, totpUsers, bookmarks, folders, readingItems, feedArticles,
        comments, deletedComments, commentReplies, commentEdits,
        blogPosts, publishedPosts,
        images, imageBytes: imageBytes._sum.size ?? 0,
        friendships, blocks, openReports,
      },
      activeUsers7d: activeTokens.length,
      signups,
      history: {
        users: cumulativeSeries(userBaseline, userCreated, histStart, HISTORY_DAYS),
        bookmarks: cumulativeSeries(bookmarkBaseline, bookmarkCreated, histStart, HISTORY_DAYS),
        comments: cumulativeSeries(commentBaseline, commentCreated, histStart, HISTORY_DAYS),
        blogPosts: cumulativeSeries(postBaseline, postCreated, histStart, HISTORY_DAYS),
      },
      visibility: {
        comments: visibilityCounts(commentVisibility),
        blogPosts: visibilityCounts(postVisibility),
      },
    });
  } catch (err) {
    logger.error(err, 'Admin stats error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/users', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        username: true,
        email: true,
        isAdmin: true,
        bannedAt: true,
        totpEnabled: true,
        createdAt: true,
        _count: { select: { bookmarks: true, folders: true, readingList: true, comments: true, blogPosts: true } },
        refreshTokens: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    res.json(users.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      isAdmin: u.isAdmin,
      bannedAt: u.bannedAt,
      totpEnabled: u.totpEnabled,
      createdAt: u.createdAt,
      bookmarks: u._count.bookmarks,
      folders: u._count.folders,
      readingItems: u._count.readingList,
      comments: u._count.comments,
      blogPosts: u._count.blogPosts,
      lastActiveAt: u.refreshTokens[0]?.createdAt ?? null,
    })));
  } catch (err) {
    logger.error(err, 'Admin users error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/comments — newest comments across every user, ignoring the
// visibility rules that govern the rest of the app: moderation can't work on a
// filtered view. Tombstones are included (flagged) so a moderator can see where
// content was removed without loading the bodies that no longer exist.
router.get('/comments', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.comment.findMany({
      orderBy: { createdAt: 'desc' },
      take: DETAIL_LIMIT,
      select: {
        id: true,
        articleTitle: true,
        articleUrl: true,
        title: true,
        body: true,
        visibility: true,
        parentId: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { username: true } },
        _count: { select: { replies: true, revisions: true } },
      },
    });
    res.json(rows.map(c => ({
      id: c.id,
      author: c.user.username,
      articleTitle: c.articleTitle,
      articleUrl: c.articleUrl,
      title: c.title,
      // Bodies are sanitized HTML; the table wants a short plain-text line
      snippet: c.deletedAt ? '' : excerptOf(c.body, SNIPPET_CHARS),
      visibility: c.visibility,
      isReply: c.parentId !== null,
      replies: c._count.replies,
      edits: c._count.revisions,
      deleted: c.deletedAt !== null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })));
  } catch (err) {
    logger.error(err, 'Admin comments error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/blog-posts — newest posts across every user, drafts included
// (a draft is just visibility === 'private'). commentCount joins through
// articleKey, the same key Comment threads on.
router.get('/blog-posts', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.blogPost.findMany({
      orderBy: { createdAt: 'desc' },
      take: DETAIL_LIMIT,
      select: {
        id: true,
        title: true,
        slug: true,
        excerpt: true,
        body: true,
        visibility: true,
        commentsEnabled: true,
        url: true,
        articleKey: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { username: true } },
      },
    });

    // One grouped count for the whole page rather than a per-row subquery
    const threadCounts = await prisma.comment.groupBy({
      by: ['articleKey'],
      where: { articleKey: { in: rows.map(r => r.articleKey) }, deletedAt: null },
      _count: { _all: true },
    });
    const byKey = new Map(threadCounts.map(t => [t.articleKey, t._count._all]));

    res.json(rows.map(p => ({
      id: p.id,
      author: p.user.username,
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt || excerptOf(p.body, SNIPPET_CHARS),
      visibility: p.visibility,
      commentsEnabled: p.commentsEnabled,
      url: p.url,
      comments: byKey.get(p.articleKey) ?? 0,
      publishedAt: p.publishedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })));
  } catch (err) {
    logger.error(err, 'Admin blog posts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/comments/thread?commentId=<id>  |  ?url=<article url>
//
// The whole conversation a comment sits in, unfiltered — every tier, every
// author, tombstones included. A reported comment read on its own is very often
// unjudgeable: "you too" is a pleasantry or an insult depending entirely on what
// it answers, and the report's snapshot can only ever hold the one comment.
//
// Two ways in, because a report can outlive its target. `commentId` is the
// direct route; `url` is the fallback for a report whose comment has since been
// deleted, resolved through the same canonical key comments thread on.
//
// Declared before DELETE /comments/:id — "thread" is not an id.
router.get('/comments/thread', async (req: AuthRequest, res: Response): Promise<void> => {
  const { commentId, url } = req.query as Record<string, string | undefined>;

  try {
    let articleKey: string | null = null;

    if (commentId) {
      const anchor = await prisma.comment.findUnique({
        where: { id: commentId },
        select: { articleKey: true },
      });
      articleKey = anchor?.articleKey ?? null;
    }
    // Either no commentId was given, or the comment is gone — fall back to the
    // URL the report captured.
    if (!articleKey && url) {
      articleKey = canonicalArticleKey(url);
    }
    if (!articleKey) { res.status(404).json({ error: 'Not found' }); return; }

    const rows = await prisma.comment.findMany({
      where: { articleKey },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        id: true, parentId: true, title: true, body: true, visibility: true,
        articleTitle: true, articleUrl: true, deletedAt: true,
        createdAt: true, updatedAt: true,
        user: { select: { username: true } },
        _count: { select: { revisions: true } },
      },
    });

    // A tombstone keeps its place in the tree but has no content left to show.
    // Unlike the reader's view it keeps its author here: who wrote the comment
    // that was removed is exactly the sort of thing a moderator is looking for.
    const nodes = rows.map(c => ({
      id: c.id,
      parentId: c.parentId,
      author: c.user.username,
      title: c.deletedAt ? null : c.title,
      body: c.deletedAt ? '' : c.body,
      visibility: c.visibility,
      deleted: c.deletedAt !== null,
      edits: c._count.revisions,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      replies: [] as unknown[],
    }));

    const meta = rows.find(r => r.articleTitle) ?? rows[0];
    res.json({
      articleTitle: meta?.articleTitle ?? '',
      articleUrl: meta?.articleUrl ?? url ?? '',
      total: rows.length,
      // Oldest-first: a moderator is reading a conversation, not a feed.
      comments: assembleThread(nodes, 'oldest'),
    });
  } catch (err) {
    logger.error(err, 'Admin comment thread error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/admin/comments/:id — moderation delete of anyone's comment.
// Shares deleteCommentPreservingThread with the author's own delete, so replies
// below a removed comment survive here exactly as they do there.
router.delete('/comments/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Read before deleting: afterwards there is no body left to describe, and
    // the audit row is the only place this comment will still exist.
    const before = await prisma.comment.findUnique({
      where: { id: req.params.id },
      select: {
        articleTitle: true, articleUrl: true, body: true, visibility: true,
        user: { select: { username: true } },
      },
    });
    if (!before) { res.status(404).json({ error: 'Not found' }); return; }
    const actorUsername = await actorName(req.userId!);

    const result = await prisma.$transaction(async tx => {
      const outcome = await deleteCommentPreservingThread(req.params.id, undefined, tx);
      if (outcome === 'not-found') return outcome;
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername,
        action: ADMIN_ACTIONS.commentDelete,
        targetType: 'comment',
        targetId: req.params.id,
        targetLabel: `@${before.user.username} on ${before.articleTitle || before.articleUrl}`,
        metadata: {
          outcome,
          visibility: before.visibility,
          snippet: excerptOf(before.body, SNIPPET_CHARS),
        },
      });
      return outcome;
    });

    if (result === 'not-found') { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true, deleted: result !== 'removed' });
  } catch (err) {
    logger.error(err, 'Admin delete comment error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/v1/admin/blog-posts/:id/visibility — moderation takedown. Narrowing
// to 'private' unpublishes without destroying the author's draft; widening is
// deliberately not offered, since publishing on someone's behalf isn't
// moderation.
router.patch('/blog-posts/:id/visibility', async (req: AuthRequest, res: Response): Promise<void> => {
  const { visibility } = req.body as { visibility?: unknown };
  if (visibility !== 'private') {
    res.status(400).json({ error: 'Admins may only unpublish a post (visibility: "private")' });
    return;
  }
  try {
    const before = await prisma.blogPost.findUnique({
      where: { id: req.params.id },
      select: { title: true, visibility: true, slug: true, user: { select: { username: true } } },
    });
    if (!before) { res.status(404).json({ error: 'Not found' }); return; }
    // Already private — nothing changed, so nothing to record. Without this an
    // idle click would write an audit row describing a no-op.
    if (before.visibility === 'private') { res.json({ ok: true }); return; }
    const actorUsername = await actorName(req.userId!);

    await prisma.$transaction(async tx => {
      await tx.blogPost.update({ where: { id: req.params.id }, data: { visibility } });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername,
        action: ADMIN_ACTIONS.postUnpublish,
        targetType: 'blogPost',
        targetId: req.params.id,
        targetLabel: `“${before.title}” by @${before.user.username}`,
        metadata: { slug: before.slug, visibility: { from: before.visibility, to: 'private' } },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Admin blog visibility error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/users/:id/admin', async (req: AuthRequest, res: Response): Promise<void> => {
  const { isAdmin } = req.body as { isAdmin?: unknown };
  if (typeof isAdmin !== 'boolean') {
    res.status(400).json({ error: 'isAdmin (boolean) required' });
    return;
  }
  // Self-demotion is blocked so the system can never end up with zero admins
  if (req.params.id === req.userId && !isAdmin) {
    res.status(400).json({ error: 'You cannot remove your own admin access' });
    return;
  }
  try {
    const before = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { username: true, isAdmin: true },
    });
    if (!before) { res.status(404).json({ error: 'Not found' }); return; }
    if (before.isAdmin === isAdmin) { res.json({ ok: true }); return; }   // no-op
    const actorUsername = await actorName(req.userId!);

    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: req.params.id }, data: { isAdmin } });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername,
        action: isAdmin ? ADMIN_ACTIONS.userPromote : ADMIN_ACTIONS.userDemote,
        targetType: 'user',
        targetId: req.params.id,
        targetLabel: `@${before.username}`,
        metadata: { isAdmin: { from: before.isAdmin, to: isAdmin } },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Admin toggle error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/users/:id/ban', async (req: AuthRequest, res: Response): Promise<void> => {
  const { banned } = req.body as { banned?: unknown };
  if (typeof banned !== 'boolean') {
    res.status(400).json({ error: 'banned (boolean) required' });
    return;
  }
  if (req.params.id === req.userId) {
    res.status(400).json({ error: 'You cannot ban yourself' });
    return;
  }
  try {
    const before = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { username: true, bannedAt: true },
    });
    if (!before) { res.status(404).json({ error: 'Not found' }); return; }
    if (!!before.bannedAt === banned) { res.json({ ok: true }); return; }   // no-op
    const actorUsername = await actorName(req.userId!);

    const revoked = await prisma.$transaction(async tx => {
      await tx.user.update({
        where: { id: req.params.id },
        data: { bannedAt: banned ? new Date() : null },
      });
      // Revoke every session — combined with the ban check in requireAuth,
      // the user is locked out immediately, not at token expiry.
      const { count } = banned
        ? await tx.refreshToken.deleteMany({ where: { userId: req.params.id } })
        : { count: 0 };
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername,
        action: banned ? ADMIN_ACTIONS.userBan : ADMIN_ACTIONS.userUnban,
        targetType: 'user',
        targetId: req.params.id,
        targetLabel: `@${before.username}`,
        metadata: { sessionsRevoked: count, previouslyBannedAt: before.bannedAt },
      });
      return count;
    });

    res.json({ ok: true, sessionsRevoked: revoked });
  } catch (err) {
    logger.error(err, 'Admin ban error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/users/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.params.id === req.userId) {
    res.status(400).json({ error: 'You cannot delete your own account' });
    return;
  }
  try {
    // The heaviest action in the panel, and the only one with nothing left to
    // inspect afterwards — so the audit row carries a census of what the
    // cascade took with it.
    const before = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        username: true, email: true, isAdmin: true, createdAt: true,
        _count: { select: { bookmarks: true, folders: true, readingList: true, comments: true, blogPosts: true } },
      },
    });
    if (!before) { res.status(404).json({ error: 'Not found' }); return; }
    const actorUsername = await actorName(req.userId!);

    await prisma.$transaction(async tx => {
      // Folders, bookmarks, reading list, feed articles, and sessions all cascade
      await tx.user.delete({ where: { id: req.params.id } });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername,
        action: ADMIN_ACTIONS.userDelete,
        targetType: 'user',
        targetId: req.params.id,
        targetLabel: `@${before.username}`,
        metadata: {
          email: before.email,
          wasAdmin: before.isAdmin,
          registeredAt: before.createdAt,
          cascaded: {
            bookmarks: before._count.bookmarks,
            folders: before._count.folders,
            readingItems: before._count.readingList,
            comments: before._count.comments,
            blogPosts: before._count.blogPosts,
          },
        },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Admin delete error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Reports ──────────────────────────────────────────────────────────────────

// One report, as the moderation UI reads it. Shared by the queue and the
// single-report fetch the bell's alert opens, so the two can't drift into
// describing the same row differently.
//
// `reportsAgainstSubject` counts every report naming this person, this one
// included — so its smallest value is 1, and anything above that is a pattern.
function toReportJson(r: Prisma.ReportGetPayload<object>, reportsAgainstSubject: number) {
  return {
    id: r.id,
    reporter: r.reporterUsername,
    // Null once that account is gone — the username above survives
    reporterExists: r.reporterId !== null,
    subject: r.subjectUsername,
    subjectExists: r.subjectId !== null,
    targetType: r.targetType,
    targetId: r.targetId,
    targetLabel: r.targetLabel,
    targetUrl: r.targetUrl,
    snapshot: r.snapshot,
    category: r.category,
    categoryLabel: categoryLabel(r.category),
    note: r.note,
    status: r.status,
    resolvedBy: r.resolvedByUsername,
    resolutionNote: r.resolutionNote,
    resolvedAt: r.resolvedAt,
    reportsAgainstSubject,
    createdAt: r.createdAt,
  };
}

// GET /api/v1/admin/reports?status=open&cursor= — the moderation queue.
//
// Paginated like the audit trail rather than capped like the detail tables: the
// queue is work to get through, and a cap would quietly hide the oldest thing
// waiting, which is exactly the one that needs attention.
//
// Each row carries `priorReports` — how many other reports name the same person.
// One report is an incident; the fifth about the same account is a pattern, and
// a moderator should not have to run a search to notice the difference.
router.get('/reports', async (req: AuthRequest, res: Response): Promise<void> => {
  const { cursor, status, category } = req.query as Record<string, string | undefined>;
  try {
    const where = {
      // Defaults to the open queue — the reason anyone opens this tab. Pass
      // status=all to read back through everything already handled.
      ...(status === 'all' ? {} : { status: status || 'open' }),
      ...(category ? { category } : {}),
    };

    const rows = await prisma.report.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: REPORT_PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const page = rows.slice(0, REPORT_PAGE);

    // One grouped count for the whole page rather than a per-row subquery.
    // Keyed on subjectId, so it follows the person rather than the content.
    const subjectIds = [...new Set(page.map(r => r.subjectId).filter((id): id is string => id !== null))];
    const priorBySubject = new Map<string, number>();
    if (subjectIds.length > 0) {
      const grouped = await prisma.report.groupBy({
        by: ['subjectId'],
        where: { subjectId: { in: subjectIds } },
        _count: { _all: true },
      });
      for (const g of grouped) {
        if (g.subjectId) priorBySubject.set(g.subjectId, g._count._all);
      }
    }

    res.json({
      reports: page.map(r =>
        toReportJson(r, r.subjectId ? (priorBySubject.get(r.subjectId) ?? 1) : 1)),
      nextCursor: rows.length > REPORT_PAGE ? page[page.length - 1].id : null,
    });
  } catch (err) {
    logger.error(err, 'Admin reports error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/reports/count — the queue depth, for the tab's badge.
router.get('/reports/count', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ open: await prisma.report.count({ where: { status: 'open' } }) });
  } catch (err) {
    logger.error(err, 'Admin report count error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/reports/:id — one report, whatever its status or age.
//
// This is what the bell's alert opens. Fetching it directly rather than hunting
// for it in the paged queue is the only approach that always works: by the time
// a moderator clicks the alert the report may have been handled by a colleague
// (so it has left the open filter) or pushed onto page three by newer arrivals.
router.get('/reports/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!r) { res.status(404).json({ error: 'Not found' }); return; }

    const reportsAgainstSubject = r.subjectId
      ? await prisma.report.count({ where: { subjectId: r.subjectId } })
      : 1;

    res.json({ report: toReportJson(r, reportsAgainstSubject) });
  } catch (err) {
    logger.error(err, 'Admin report error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/v1/admin/reports/:id { status: 'resolved' | 'dismissed', note? }
//
// Closing a report records *the moderator's judgement*, nothing more. Acting on
// the content — deleting the comment, unpublishing the post, banning the author
// — stays with the endpoints that already do those things, each writing its own
// audit row. Folding them together here would make one click mean two different
// things and leave the audit trail unable to say which.
router.patch('/reports/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { status, note } = req.body as { status?: unknown; note?: unknown };
  if (!isResolution(status)) {
    res.status(400).json({ error: "status must be 'resolved' or 'dismissed'" });
    return;
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    res.status(400).json({ error: 'note must be a string' });
    return;
  }
  const resolutionNote = typeof note === 'string' ? note.trim().slice(0, MAX_REPORT_NOTE) : '';

  try {
    const before = await prisma.report.findUnique({
      where: { id: req.params.id },
      select: { status: true, category: true, targetLabel: true, targetType: true, subjectUsername: true, reporterUsername: true },
    });
    if (!before) { res.status(404).json({ error: 'Not found' }); return; }
    // Already handled — answer with what it was decided, rather than silently
    // overwriting another moderator's judgement.
    if (before.status !== 'open') {
      res.status(409).json({ error: `This report was already ${before.status}` });
      return;
    }
    const actorUsername = await actorName(req.userId!);

    await prisma.$transaction(async tx => {
      await tx.report.update({
        where: { id: req.params.id },
        data: {
          status,
          resolvedById: req.userId!,
          resolvedByUsername: actorUsername,
          resolutionNote,
          resolvedAt: new Date(),
        },
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername,
        action: status === 'resolved' ? ADMIN_ACTIONS.reportResolve : ADMIN_ACTIONS.reportDismiss,
        targetType: 'report',
        targetId: req.params.id,
        targetLabel: before.targetLabel,
        metadata: {
          category: before.category,
          reportedType: before.targetType,
          subject: before.subjectUsername,
          reporter: before.reporterUsername,
          ...(resolutionNote ? { note: resolutionNote } : {}),
        },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Admin resolve report error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/audit — the moderation record, newest first.
//
// Cursor-paginated rather than capped like the other detail tables: those are
// for spot-checking current state, but an audit trail is only worth having if
// you can read all the way back through it.
//
// Read-only by construction. There is no PATCH or DELETE here, and there never
// should be — a trail somebody can edit answers no question worth asking.
router.get('/audit', async (req: AuthRequest, res: Response): Promise<void> => {
  const { cursor, actor, action, targetType } = req.query as Record<string, string | undefined>;
  try {
    const where = {
      ...(actor ? { actorUsername: actor } : {}),
      ...(action ? { action } : {}),
      ...(targetType ? { targetType } : {}),
    };

    const rows = await prisma.adminAction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: AUDIT_PAGE + 1,          // one extra row tells us another page exists
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const page = rows.slice(0, AUDIT_PAGE);
    res.json({
      entries: page.map(r => ({
        id: r.id,
        actor: r.actorUsername,
        // Null once that admin's account is gone — the username above survives
        actorExists: r.actorId !== null,
        action: r.action,
        label: actionLabel(r.action),
        destructive: isDestructive(r.action),
        targetType: r.targetType,
        targetId: r.targetId,
        targetLabel: r.targetLabel,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
      nextCursor: rows.length > AUDIT_PAGE ? page[page.length - 1].id : null,
    });
  } catch (err) {
    logger.error(err, 'Admin audit error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Errors ───────────────────────────────────────────────────────────────────
// What's broken, in two halves that answer different questions: the incidents
// themselves (ErrorLog), and the standing health of the feed subscriptions,
// which is state rather than history and so doesn't belong in a log.

// GET /api/v1/admin/errors?cursor=&source=
// Paged like the audit trail, for the same reason: a cap would hide the oldest
// thing without saying so, and here the oldest thing may be the first symptom.
router.get('/errors', async (req: AuthRequest, res: Response): Promise<void> => {
  const { cursor, source } = req.query as Record<string, string | undefined>;
  try {
    const where = source === 'server' || source === 'feed' ? { source } : {};

    const [rows, counts] = await Promise.all([
      prisma.errorLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ERROR_PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      // Unfiltered on purpose: the tallies label the filter chips, so they have
      // to describe the whole log rather than the slice currently shown.
      prisma.errorLog.groupBy({ by: ['source'], _count: { _all: true } }),
    ]);

    const page = rows.slice(0, ERROR_PAGE);
    res.json({
      entries: page.map(r => ({
        id: r.id,
        source: r.source,
        message: r.message,
        detail: r.detail,
        method: r.method,
        path: r.path,
        status: r.status,
        username: r.username,
        feedUrl: r.feedUrl,
        createdAt: r.createdAt,
      })),
      counts: {
        server: counts.find(c => c.source === 'server')?._count._all ?? 0,
        feed: counts.find(c => c.source === 'feed')?._count._all ?? 0,
      },
      retentionDays: ERROR_LOG_RETENTION_DAYS,
      nextCursor: rows.length > ERROR_PAGE ? page[page.length - 1].id : null,
    });
  } catch (err) {
    logger.error(err, 'Admin error log error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/feeds/health — the feeds currently failing, worst first.
// Only feeds with a live failure run: a feed that broke last month and has
// worked ever since has consecutiveFailures 0 and is not a problem to show.
router.get('/feeds/health', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [failing, total, healthy] = await Promise.all([
      prisma.feed.findMany({
        where: { consecutiveFailures: { gt: 0 } },
        orderBy: [{ consecutiveFailures: 'desc' }, { lastErrorAt: 'desc' }],
        take: FAILING_FEED_LIMIT,
        select: {
          id: true, fetchUrl: true, title: true, consecutiveFailures: true,
          lastError: true, lastErrorAt: true, lastSuccessAt: true,
        },
      }),
      prisma.feed.count(),
      prisma.feed.count({ where: { consecutiveFailures: 0 } }),
    ]);

    res.json({
      feeds: failing.map(f => ({
        id: f.id,
        url: f.fetchUrl,
        title: f.title,
        consecutiveFailures: f.consecutiveFailures,
        lastError: f.lastError,
        lastErrorAt: f.lastErrorAt,
        lastSuccessAt: f.lastSuccessAt,
        // Crossing the alert threshold is what an admin was told about, so the
        // list marks the same line rather than making them count.
        alerting: f.consecutiveFailures >= FEED_FAILURE_ALERT_THRESHOLD,
      })),
      total,
      healthy,
    });
  } catch (err) {
    logger.error(err, 'Admin feed health error');
    res.status(500).json({ error: 'Server error' });
  }
});

// How many people subscribe to each feed, keyed the way Feed rows are.
//
// FeedSubscription stores the URL a user typed, while Feed dedupes on
// canonicalFeedKey — so http://x.com/feed and https://www.x.com/feed/ are two
// subscription rows pointing at one feed, and counting the rows per literal URL
// would report both as separate feeds with one subscriber each. Canonicalising
// has to happen here rather than in SQL, since that function is TypeScript.
//
// One grouped query for the whole instance: the distinct-URL count is on the
// order of the feed count (hundreds), not the subscription count.
async function subscribersByFeedKey(): Promise<Map<string, number>> {
  const rows = await prisma.feedSubscription.groupBy({
    by: ['url'],
    _count: { _all: true },
  });
  const byKey = new Map<string, number>();
  for (const row of rows) {
    const key = canonicalFeedKey(row.url);
    byKey.set(key, (byKey.get(key) ?? 0) + row._count._all);
  }
  return byKey;
}

// GET /api/v1/admin/feeds?q=&offset=&status=
//
// Every feed the instance polls, searchable. /feeds/health answers "what is
// broken"; this answers the questions either side of it — is this URL even
// subscribed to, when was it last looked at, is anyone actually reading it.
//
// Offset-paged rather than cursor-paged, unlike the logs: this is a search over
// standing state where a total ("31 of 412 feeds") is worth having, and rows
// don't stream in at the head the way log entries do.
router.get('/feeds', async (req: AuthRequest, res: Response): Promise<void> => {
  const { q, offset, status } = req.query as Record<string, string | undefined>;
  const skip = Math.max(0, Math.min(10_000, Number.parseInt(offset ?? '0', 10) || 0));
  const term = (q ?? '').trim();
  const dormantBefore = new Date(Date.now() - DEMAND_WINDOW_MS);

  try {
    // ANDed as a list rather than spread into one object: search and the dormant
    // filter both want an OR, and spreading would leave only the last one.
    const filters: Prisma.FeedWhereInput[] = [];
    if (term) {
      filters.push({
        OR: [
          { fetchUrl: { contains: term, mode: 'insensitive' } },
          { title: { contains: term, mode: 'insensitive' } },
        ],
      });
    }
    if (status === 'failing') filters.push({ consecutiveFailures: { gt: 0 } });
    if (status === 'dormant') {
      filters.push({ OR: [{ lastRequestedAt: null }, { lastRequestedAt: { lt: dormantBefore } }] });
    }
    const where: Prisma.FeedWhereInput = filters.length > 0 ? { AND: filters } : {};

    const [rows, total, subscribers] = await Promise.all([
      prisma.feed.findMany({
        where,
        // Most recently checked first, so the top of the list is the refresher
        // visibly working. Feeds never checked sort last — they're a different
        // problem, and the dormant/failing filters are how you go looking.
        orderBy: [{ lastCheckedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        skip,
        take: FEED_PAGE,
        select: {
          id: true, fetchUrl: true, canonicalKey: true, title: true,
          lastCheckedAt: true, lastSuccessAt: true, lastRequestedAt: true,
          consecutiveFailures: true, lastError: true, lastErrorAt: true,
        },
      }),
      prisma.feed.count({ where }),
      subscribersByFeedKey(),
    ]);

    // Stored articles per feed, one grouped query for the page
    const itemCounts = await prisma.feedItem.groupBy({
      by: ['feedId'],
      where: { feedId: { in: rows.map(r => r.id) } },
      _count: { _all: true },
    });
    const itemsByFeed = new Map(itemCounts.map(c => [c.feedId, c._count._all]));

    res.json({
      feeds: rows.map(f => ({
        id: f.id,
        url: f.fetchUrl,
        title: f.title,
        lastCheckedAt: f.lastCheckedAt,
        lastSuccessAt: f.lastSuccessAt,
        lastRequestedAt: f.lastRequestedAt,
        consecutiveFailures: f.consecutiveFailures,
        lastError: f.lastError,
        lastErrorAt: f.lastErrorAt,
        subscribers: subscribers.get(f.canonicalKey) ?? 0,
        items: itemsByFeed.get(f.id) ?? 0,
        // The scheduler has stopped polling this one until somebody opens it
        // again — which is by design, and looks identical to neglect otherwise.
        dormant: !f.lastRequestedAt || f.lastRequestedAt < dormantBefore,
      })),
      total,
      offset: skip,
      nextOffset: skip + rows.length < total ? skip + rows.length : null,
      dormantAfterDays: Math.round(DEMAND_WINDOW_MS / 86_400_000),
    });
  } catch (err) {
    logger.error(err, 'Admin feed list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/admin/feeds/log?cursor=&outcome=&feedId=&q=
//
// Every refresh attempt, newest first — the successes and the 304s as well as
// the failures. The error log can only say what broke; this says whether the
// refresher ran at all, which is the first thing to establish when a feed looks
// stuck. `summary` tallies the last 24 hours across the whole log (not the
// filtered page), so the chips can be labelled with what they'd show.
router.get('/feeds/log', async (req: AuthRequest, res: Response): Promise<void> => {
  const { cursor, outcome, feedId, q } = req.query as Record<string, string | undefined>;
  const term = (q ?? '').trim();

  try {
    const where: Prisma.FeedFetchLogWhereInput = {
      ...(outcome === 'success' || outcome === 'unchanged' || outcome === 'failed' ? { outcome } : {}),
      ...(feedId ? { feedId } : {}),
      ...(term
        ? {
            OR: [
              { feedUrl: { contains: term, mode: 'insensitive' as const } },
              { feedTitle: { contains: term, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, tallies] = await Promise.all([
      prisma.feedFetchLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: FEED_LOG_PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      prisma.feedFetchLog.groupBy({
        by: ['outcome'],
        where: { createdAt: { gte: new Date(Date.now() - FEED_LOG_SUMMARY_MS) } },
        _count: { _all: true },
      }),
    ]);

    const page = rows.slice(0, FEED_LOG_PAGE);
    const tally = (name: string) => tallies.find(t => t.outcome === name)?._count._all ?? 0;

    res.json({
      entries: page.map(r => ({
        id: r.id,
        feedId: r.feedId,
        feedUrl: r.feedUrl,
        feedTitle: r.feedTitle,
        outcome: r.outcome,
        status: r.status,
        durationMs: r.durationMs,
        items: r.items,
        newItems: r.newItems,
        error: r.error,
        createdAt: r.createdAt,
      })),
      summary: {
        success: tally('success'),
        unchanged: tally('unchanged'),
        failed: tally('failed'),
      },
      retentionDays: FEED_LOG_RETENTION_DAYS,
      nextCursor: rows.length > FEED_LOG_PAGE ? page[page.length - 1].id : null,
    });
  } catch (err) {
    logger.error(err, 'Admin feed log error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
