import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { friendIdsOf } from '../lib/friends';
import { blockWallOf, notWalledWhere } from '../lib/blocks';
import { visibilityWhere } from '../lib/commentVisibility';
import { canSeePost, excerptOf, postUrlFor, profileUrlFor } from '../lib/blog';
import { perUserLimiter } from '../lib/rateLimit';
import {
  checkReportInput, isReportTargetType, ReportTargetType,
  REPORT_SNAPSHOT_CHARS, categoryLabel,
} from '../lib/reports';
import logger from '../lib/logger';

// Filing a report. The moderator-facing half — the queue, and resolving things
// out of it — lives in routes/admin.ts behind requireAdmin.
const router = Router();
router.use(requireAuth);

// Reports are a moderation queue, and a queue is exhaustible: a handful of bad
// actors filing hundreds of reports is itself the attack. Two windows, matching
// the comment limiter's shape.
const reportBurstLimiter = perUserLimiter({
  windowMs: 60_000, max: 5,
  message: 'You’re filing reports very quickly — take a moment.',
});
const reportHourlyLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 20,
  message: 'You’ve hit the hourly report limit — please try again later.',
});

// What a resolved target contributes to the row. Everything here is read from
// the database, never taken from the request: a client that could name its own
// `subjectUsername` could get someone else banned.
interface ResolvedTarget {
  subjectId: string;
  subjectUsername: string;
  targetLabel: string;
  targetUrl: string | null;
  snapshot: string;
}

// Resolve what is being reported, enforcing that the reporter can actually see
// it. Returns null when they can't — reporting must not become a way to probe
// for private comments or draft posts by their id.
async function resolveTarget(
  targetType: ReportTargetType,
  targetId: string,
  reporterId: string,
): Promise<ResolvedTarget | null> {
  if (targetType === 'comment') {
    const [prefs, friendIds, wall] = await Promise.all([
      prisma.user.findUnique({ where: { id: reporterId }, select: { settings: true } }),
      friendIdsOf(reporterId),
      blockWallOf(reporterId),
    ]);
    const showPublic = ((prefs?.settings ?? {}) as Record<string, unknown>).commentsShowPublic !== false;

    const comment = await prisma.comment.findFirst({
      where: {
        id: targetId,
        deletedAt: null,
        ...visibilityWhere(reporterId, showPublic, friendIds),
        ...notWalledWhere(wall),
      },
      select: {
        body: true, articleTitle: true, articleUrl: true,
        user: { select: { id: true, username: true } },
      },
    });
    if (!comment) return null;
    return {
      subjectId: comment.user.id,
      subjectUsername: comment.user.username,
      targetLabel: `Comment by @${comment.user.username} on ${comment.articleTitle || comment.articleUrl}`,
      targetUrl: comment.articleUrl,
      snapshot: excerptOf(comment.body, REPORT_SNAPSHOT_CHARS),
    };
  }

  if (targetType === 'blogPost') {
    const [friendIds, wall] = await Promise.all([friendIdsOf(reporterId), blockWallOf(reporterId)]);
    const post = await prisma.blogPost.findUnique({
      where: { id: targetId },
      select: {
        userId: true, title: true, body: true, slug: true, url: true, visibility: true,
        user: { select: { username: true } },
      },
    });
    if (!post) return null;
    if (wall.has(post.userId)) return null;
    if (!canSeePost(post, reporterId, friendIds)) return null;
    return {
      subjectId: post.userId,
      subjectUsername: post.user.username,
      targetLabel: `“${post.title}” by @${post.user.username}`,
      targetUrl: post.url || postUrlFor(post.user.username, post.slug),
      snapshot: excerptOf(post.body, REPORT_SNAPSHOT_CHARS),
    };
  }

  // A user report. Banned accounts are still reportable — a ban can be lifted,
  // and the report is part of the record that argues against lifting it.
  const user = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, username: true },
  });
  if (!user) return null;
  return {
    subjectId: user.id,
    subjectUsername: user.username,
    targetLabel: `@${user.username}`,
    targetUrl: profileUrlFor(user.username),
    snapshot: '',
  };
}

// Tell every admin a report is waiting.
//
// `actorId` is deliberately left null rather than set to the reporter. Two
// reasons: it keeps the reporter's identity in the queue (where it belongs with
// the rest of the context) instead of on a passing glance at the bell, and it
// means a moderator who happens to have blocked the reporter still sees the
// report — the block wall filters notifications by actor, and moderation must
// not be silenced by a personal block.
// `reportId` is what makes the alert actionable: the bell opens that report in
// the moderation queue rather than dumping the moderator at the reported content
// with no way back to the report itself.
async function notifyAdminsOfReport(
  reportId: string,
  targetLabel: string,
  targetUrl: string | null,
  category: string,
): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { isAdmin: true, bannedAt: null },
    select: { id: true },
  });
  if (admins.length === 0) return;
  await prisma.notification.createMany({
    data: admins.map(a => ({
      userId: a.id,
      type: 'report_new',
      actorId: null,
      reportId,
      articleTitle: `${categoryLabel(category)} — ${targetLabel}`,
      articleUrl: targetUrl,
    })),
  });
}

// POST /api/v1/reports { targetType, targetId, category, note }
router.post('/', reportBurstLimiter, reportHourlyLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { targetType, targetId, category, note } = req.body as Record<string, unknown>;

  if (!isReportTargetType(targetType)) {
    res.status(400).json({ error: "targetType must be 'comment', 'blogPost', or 'user'" }); return;
  }
  if (typeof targetId !== 'string' || !targetId) {
    res.status(400).json({ error: 'targetId required' }); return;
  }
  const checked = checkReportInput(category, note);
  if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }

  try {
    const reporter = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { username: true },
    });
    if (!reporter) { res.status(404).json({ error: 'Not found' }); return; }

    const target = await resolveTarget(targetType, targetId, req.userId!);
    // Indistinguishable from a target that never existed, on purpose — see
    // resolveTarget.
    if (!target) { res.status(404).json({ error: 'Not found' }); return; }
    if (target.subjectId === req.userId!) {
      res.status(400).json({ error: 'You can’t report your own content' }); return;
    }

    // Re-reporting the same thing is a no-op rather than a second row. The
    // unique index is the real guard; this read just turns the common case into
    // a friendly answer instead of a caught constraint violation.
    const existing = await prisma.report.findUnique({
      where: {
        reporterId_targetType_targetId: {
          reporterId: req.userId!, targetType, targetId,
        },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      res.json({ ok: true, alreadyReported: true, status: existing.status });
      return;
    }

    const created = await prisma.report.create({
      select: { id: true },
      data: {
        reporterId: req.userId!,
        reporterUsername: reporter.username,
        subjectId: target.subjectId,
        subjectUsername: target.subjectUsername,
        targetType,
        targetId,
        targetLabel: target.targetLabel,
        targetUrl: target.targetUrl,
        snapshot: target.snapshot,
        category: category as string,
        note: checked.note,
      },
    });

    // Best-effort: a report that reaches the queue but not the bell is still a
    // report. Never fail the submission over the fan-out.
    await notifyAdminsOfReport(created.id, target.targetLabel, target.targetUrl, category as string)
      .catch(err => logger.warn(err, 'Report notification failed'));

    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error(err, 'Create report error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
