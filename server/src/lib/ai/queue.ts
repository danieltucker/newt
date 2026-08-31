/**
 * The work queue for AI tasks, and the one ceiling that bounds all of it.
 *
 * ── Why a table and a worker rather than doing it in the request ──
 *
 * The work outlives the request that asked for it. An auto-explore is a title
 * call, a long generation and possibly an article fetch; the thing that asked
 * for it was somebody posting a comment, and they are owed a response now, not
 * in ninety seconds. Moderation has the same shape: a comment must post
 * immediately and be screened afterwards, because a community where posting
 * blocks on a GPU is a community where posting feels broken.
 *
 * ── Why the ceiling is global and not per trigger ──
 *
 * Four triggers can fire at once: an admin presses the button while the nightly
 * pass is running and two threads cross their comment thresholds. Per-trigger
 * limits cannot express "one at a time overall", and one-at-a-time is the only
 * limit that matters on a single GPU — the box serialises regardless, and if
 * moderation and explore are configured on *different* models, alternating
 * between them makes Ollama unload and reload tens of gigabytes between jobs.
 *
 * So: one worker, `maxConcurrent` of 1 in practice, and everything else waits
 * its turn in a table where an operator can see the backlog.
 *
 * ── Why it is an interval and not a cron ──
 *
 * The queue is checked on a timer inside the server process. There is no
 * external scheduler to install and nothing to keep in sync with the container
 * lifecycle: if Newt is up the queue drains, and if it is down there is nothing
 * to drain it for. A job left `running` by a crash is reclaimed by age (see
 * STALE_MS) rather than by a lock, because the only thing that can hold the
 * lock is the process that just died.
 */

import prisma from '../prisma';
import logger from '../logger';
import { readTrigger } from './tasks';

/** How often the worker looks for something to do. */
const TICK_MS = 15_000;

/**
 * How long a job may sit in `running` before it is assumed dead.
 *
 * Generously longer than any real generation. A cold 30B model on a busy box
 * can take a couple of minutes to answer, and reclaiming a job that was merely
 * slow would run it twice — which for an explore means two threads on one
 * article and for moderation means two audit rows saying different things.
 */
const STALE_MS = 15 * 60 * 1000;

/** Attempts before a job is left alone. Transient failures deserve one retry. */
const MAX_ATTEMPTS = 2;

export type JobHandler = (job: {
  id: string;
  taskId: string;
  trigger: string;
  articleKey: string;
  articleUrl: string;
  subjectId: string;
}) => Promise<{ threadId?: string; note?: string; verdict?: string; category?: string; confidence?: number }>;

/** Registered per kind by the modules that own the work. */
const handlers = new Map<string, JobHandler>();

export function registerHandler(kind: string, fn: JobHandler): void {
  handlers.set(kind, fn);
}

/**
 * Add a job, unless this task has already handled this article.
 *
 * The dedupe is the reason `@@index([taskId, articleKey])` exists. Without it
 * every trigger would need its own memory of what it had already done, and the
 * comment-count trigger in particular fires again on every subsequent comment —
 * an article with forty comments would otherwise be explored thirty-nine times.
 *
 * Deliberately counts *any* prior job, including failed ones. A model that
 * could not produce something usable for an article yesterday will very likely
 * fail on it again today, and retrying forever on a schedule is how a broken
 * endpoint turns into a full disk of audit rows. An admin pressing the button
 * bypasses this — see `force`.
 */
export async function enqueue(input: {
  taskId: string;
  trigger: string;
  articleKey: string;
  articleUrl: string;
  subjectId?: string;
  force?: boolean;
}): Promise<{ queued: boolean; reason: string }> {
  if (!input.force && input.articleKey) {
    const prior = await prisma.aiJob.findFirst({
      where: { taskId: input.taskId, articleKey: input.articleKey },
      select: { id: true, status: true },
    });
    if (prior) return { queued: false, reason: `already handled (${prior.status})` };
  }

  await prisma.aiJob.create({
    data: {
      taskId: input.taskId,
      trigger: input.trigger,
      articleKey: input.articleKey,
      articleUrl: input.articleUrl,
      subjectId: input.subjectId ?? '',
    },
  });
  return { queued: true, reason: '' };
}

/** One job the worker has in hand right now, described for the panel. */
export interface RunningJob {
  id: string;
  taskLabel: string;
  kind: string;
  trigger: string;
  /** The article, or the comment id for a moderation job. */
  subject: string;
  /** How long it has been running. Elapsed, not a timestamp — see queueStats. */
  elapsedMs: number;
  attempt: number;
}

export interface QueueStats {
  queued: number;
  running: number;
  oldestMs: number | null;
  /**
   * What is actually in flight, not just how many.
   *
   * A count alone cannot answer the question an operator has while staring at a
   * spinner — *what* is it doing, and has it hung? A single-worker queue on a
   * GPU can legitimately take two minutes on a cold 30B model, and the only way
   * to tell that apart from a wedged job is to see what it is and how long it
   * has been going. STALE_MS is the point at which the queue itself gives up.
   */
  active: RunningJob[];
  /** So the panel can say "stuck" rather than making the operator do the sum. */
  staleAfterMs: number;
}

/** Queue depth, the age of the oldest waiting job, and what is in flight. */
export async function queueStats(): Promise<QueueStats> {
  const [queued, running, oldest, active] = await Promise.all([
    prisma.aiJob.count({ where: { status: 'queued' } }),
    prisma.aiJob.count({ where: { status: 'running' } }),
    prisma.aiJob.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.aiJob.findMany({
      where: { status: 'running' },
      orderBy: { startedAt: 'asc' },
      // The ceiling is one, so this is one row in practice. Capped anyway: a
      // crashed process leaves rows in `running` until they age out, and a list
      // of twenty of those is not a useful thing to render.
      take: 5,
      select: {
        id: true, trigger: true, articleUrl: true, subjectId: true,
        startedAt: true, attempts: true,
        task: { select: { kind: true, label: true } },
      },
    }),
  ]);

  const now = Date.now();
  return {
    queued,
    running,
    // Age rather than timestamp: "forty minutes behind" is the number an
    // operator acts on, and computing it here means the panel cannot get the
    // subtraction wrong against a differently-skewed clock.
    oldestMs: oldest ? now - oldest.createdAt.getTime() : null,
    active: active.map(j => ({
      id: j.id,
      taskLabel: j.task?.label || j.task?.kind || 'unknown task',
      kind: j.task?.kind ?? 'unknown',
      trigger: j.trigger,
      subject: j.articleUrl || j.subjectId,
      elapsedMs: j.startedAt ? now - j.startedAt.getTime() : 0,
      attempt: j.attempts,
    })),
    staleAfterMs: STALE_MS,
  };
}

/**
 * Claim one job, atomically.
 *
 * `updateMany` with the status in the filter is the claim: two workers racing
 * for the same row means one of them updates zero rows and moves on. That
 * matters less with a single process than it will the day this runs in two
 * containers, and it costs nothing to be right about now.
 */
async function claimNext(): Promise<{ id: string; taskId: string; trigger: string; articleKey: string; articleUrl: string; subjectId: string; attempts: number } | null> {
  const stale = new Date(Date.now() - STALE_MS);

  const candidate = await prisma.aiJob.findFirst({
    where: {
      OR: [
        { status: 'queued' },
        // Reclaimed from a crashed process. Not an error state: nothing was
        // wrong with the job, the thing running it went away.
        { status: 'running', startedAt: { lt: stale } },
      ],
      attempts: { lt: MAX_ATTEMPTS },
      task: { enabled: true },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, taskId: true, trigger: true, articleKey: true, articleUrl: true, subjectId: true, attempts: true, status: true },
  });
  if (!candidate) return null;

  const claimed = await prisma.aiJob.updateMany({
    where: { id: candidate.id, status: candidate.status },
    data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;

  return candidate;
}

async function runOne(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;

  const task = await prisma.aiTask.findUnique({
    where: { id: job.taskId },
    select: { kind: true },
  });
  const handler = task ? handlers.get(task.kind) : undefined;

  if (!handler) {
    await prisma.aiJob.update({
      where: { id: job.id },
      data: { status: 'skipped', finishedAt: new Date(), note: 'no handler for this task kind' },
    });
    return true;
  }

  try {
    const out = await handler(job);
    await prisma.aiJob.update({
      where: { id: job.id },
      data: {
        // A handler that returns a note and no thread has *decided* not to
        // produce anything — an article too thin to explore, a duplicate found
        // late. That is a skip, not a failure: nothing went wrong and retrying
        // would reach the same conclusion.
        status: out.threadId || out.verdict ? 'done' : 'skipped',
        threadId: out.threadId ?? null,
        note: (out.note ?? '').slice(0, 500),
        verdict: out.verdict ?? '',
        category: out.category ?? '',
        confidence: out.confidence ?? 0,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId: job.id }, 'AI job failed');
    await prisma.aiJob.update({
      where: { id: job.id },
      data: {
        // Back to `queued` while attempts remain, so a box that was briefly
        // down does not lose the work. The attempts counter is what stops this
        // being a loop.
        status: job.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued',
        note: message.slice(0, 500),
        finishedAt: job.attempts + 1 >= MAX_ATTEMPTS ? new Date() : null,
      },
    });
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

/**
 * Start the worker.
 *
 * `busy` is the concurrency ceiling, and it is a module-level boolean rather
 * than anything cleverer because the ceiling is one. A tick that arrives while
 * a job is running does nothing at all — which is the whole design, since the
 * GPU underneath cannot do two things at once either.
 */
export function startAiQueue(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    // Drain rather than one-per-tick: a backlog of twenty short moderation jobs
    // should not take five minutes to clear because the timer is slow.
    void (async () => {
      try {
        while (await runOne()) { /* keep going until the queue is empty */ }
      } catch (err) {
        logger.error(err, 'AI queue tick failed');
      } finally {
        busy = false;
      }
    })();
  }, TICK_MS);
  // Never hold the process open for the sake of the timer.
  timer.unref?.();
  logger.info('AI task queue started');
}

export function stopAiQueue(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** The enabled tasks of one kind, cheapest first for the trigger checks. */
export async function enabledTasks(kind: string) {
  const rows = await prisma.aiTask.findMany({
    where: { kind, enabled: true },
    select: { id: true, trigger: true },
  });
  return rows.map(r => ({ id: r.id, trigger: readTrigger(r.trigger) }));
}
