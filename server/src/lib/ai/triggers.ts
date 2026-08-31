/**
 * The three unattended triggers for auto-explore.
 *
 * Each one answers the same question — has this article earned a generation —
 * from a different signal, and each is called from the place that already knows
 * the signal changed. None of them generates anything: they enqueue, and the
 * queue's single worker decides when. That separation is what lets four
 * triggers exist without four ways to overload the box.
 */

import prisma from '../prisma';
import logger from '../logger';
import { enqueue, enabledTasks } from './queue';
import { queueRelatePass } from './relate';
import { canonicalArticleKey } from '../comments';

/**
 * A comment was posted. Explore the article if the thread has got big enough.
 *
 * Counts *public* comments only, and for the same reason the generated explore
 * reads only public material: a thread that is busy with friends-only replies
 * is not publicly busy, and publishing an explore on the strength of it would
 * signal that private conversation is happening.
 */
export async function onCommentPosted(articleKey: string, articleUrl: string): Promise<void> {
  try {
    const tasks = await enabledTasks('explore');
    const wanted = tasks.filter(t => t.trigger.onCommentCount > 0);
    if (wanted.length === 0) return;

    const count = await prisma.comment.count({
      where: { articleKey, deletedAt: null, hiddenAt: null, visibility: 'public' },
    });

    for (const task of wanted) {
      if (count < task.trigger.onCommentCount) continue;
      await enqueue({ taskId: task.id, trigger: 'comments', articleKey, articleUrl });
    }
  } catch (err) {
    logger.error(err, 'Comment-count explore trigger failed');
  }
}

/**
 * An article was saved to somebody's reading list.
 *
 * **Counts distinct users, and the floor depends on whether anyone reviews the
 * result.** A save is a private act, so a *public* explore appearing the moment
 * one person saves an article announces that they saved it — on an instance with
 * a handful of readers, announcing which one. A thread created private and held
 * for review discloses nothing, so the floor of 3 applies only when autoPublish
 * is 'always'. Enforced in readTrigger, not here, so it cannot be edited around
 * in the database.
 */
export async function onArticleSaved(url: string): Promise<void> {
  try {
    const tasks = await enabledTasks('explore');
    const wanted = tasks.filter(t => t.trigger.onSaveCount > 0);
    if (wanted.length === 0) return;

    const key = canonicalArticleKey(url);
    // groupBy on userId rather than a plain count: one person saving an article
    // to three folders is one person, and would otherwise trip a threshold of
    // three on their own — which is exactly the leak this trigger is shaped to
    // avoid.
    const savers = await prisma.readingListItem.groupBy({
      by: ['userId'],
      where: { url },
    });

    for (const task of wanted) {
      if (savers.length < task.trigger.onSaveCount) continue;
      await enqueue({ taskId: task.id, trigger: 'saves', articleKey: key, articleUrl: url });
    }
  } catch (err) {
    logger.error(err, 'Save-count explore trigger failed');
  }
}

/** How far back the nightly pass looks. Older than this is not news. */
const SCHEDULED_WINDOW_HOURS = 48;

/**
 * The nightly pass: pick the few most-discussed recent articles and explore them.
 *
 * Ranked by public comment count rather than by recency alone, because "what
 * people are talking about" is the only signal available here that is about the
 * article rather than about the feed's publishing schedule. An unranked pass
 * over recent items would explore whatever happened to arrive last.
 *
 * The dedupe in `enqueue` is what keeps this from re-exploring the same article
 * every night for a week.
 */
export interface PassResult {
  queued: number;
  /** Relate runs queued alongside the explores. */
  relateQueued: number;
  /** Articles the ranking found in the window, before dedupe. */
  considered: number;
  /** Why the rest were passed over, most common first. Empty when all queued. */
  skipped: { reason: string; count: number }[];
  /** No task has the daily pass switched on, which is not the same as "nothing to do". */
  noTasks: boolean;
}

/**
 * Returns a full account rather than a count, because zero is the usual answer
 * and it has at least four different meanings: no task wants a daily pass, no
 * article has been discussed in the window, everything was explored already, or
 * the ranking found things but the dedupe rejected all of them. An admin who
 * presses the button and sees "0" learns nothing from it.
 */
export async function runScheduledPass(): Promise<PassResult> {
  const tasks = await enabledTasks('explore');
  const wanted = tasks.filter(t => t.trigger.scheduledTopN > 0);
  // Relate tasks are queued whatever the explore side finds: a relate run is
  // about the window rather than about any one article, so "no article was
  // discussed" is not a reason to skip it.
  const relateQueued = await queueRelatePass('scheduled');

  if (wanted.length === 0) {
    return { queued: 0, relateQueued, considered: 0, skipped: [], noTasks: relateQueued === 0 };
  }

  const since = new Date(Date.now() - SCHEDULED_WINDOW_HOURS * 3600_000);
  const busiest = await prisma.comment.groupBy({
    by: ['articleKey', 'articleUrl'],
    where: { createdAt: { gte: since }, deletedAt: null, hiddenAt: null, visibility: 'public' },
    _count: { _all: true },
    orderBy: { _count: { articleKey: 'desc' } },
    take: 20,
  });

  let queued = 0;
  let considered = 0;
  const reasons = new Map<string, number>();

  for (const task of wanted) {
    for (const row of busiest.slice(0, task.trigger.scheduledTopN)) {
      considered++;
      const { queued: ok, reason } = await enqueue({
        taskId: task.id,
        trigger: 'scheduled',
        articleKey: row.articleKey,
        articleUrl: row.articleUrl,
      });
      if (ok) queued++;
      else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  const skipped = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  logger.info({ queued, relateQueued, considered, skipped }, 'Scheduled pass finished');
  return { queued, relateQueued, considered, skipped, noTasks: false };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Run the scheduled pass once a day.
 *
 * An interval rather than a cron expression, because "once a day from whenever
 * the container came up" is as good as a wall-clock time for this and needs no
 * scheduler, no timezone and no config field. The pass is idempotent — the
 * dedupe sees to that — so drifting is harmless.
 */
export function startScheduledPass(): void {
  if (timer) return;
  const DAY_MS = 24 * 3600_000;
  timer = setInterval(() => {
    void runScheduledPass().catch(err => logger.error(err, 'Scheduled explore pass failed'));
  }, DAY_MS);
  timer.unref?.();
}

export function stopScheduledPass(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
