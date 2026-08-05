import prisma from './prisma';
import logger from './logger';

// The refresher's flight recorder. Every attempt to fetch a feed lands here —
// the 304s and the successes as well as the failures — because the question an
// admin opens the panel with is usually not "what broke" but "is this thing
// running, and when did it last look at this feed?" A log of failures alone
// cannot answer that: silence in it means either everything is fine or nothing
// is being fetched at all.
//
// ErrorLog stays the place a failure is explained (it carries the stack, the
// response body, the request context). This is the timeline around it.

// Shorter than the error log's 30 days: this writes on every attempt, not only
// when something goes wrong, so a busy instance fills it much faster — and
// nobody debugging a feed asks what happened three weeks ago.
export const FEED_LOG_RETENTION_DAYS = 7;

// Same bargain as errorLog's prune: at most hourly, in-process, on the write
// path rather than on a timer. Two instances would each run it, which is
// harmless — the delete is idempotent.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

// The failure line, not the failure's detail — the full response body and stack
// live on the matching ErrorLog row.
const MAX_ERROR = 300;

export type FeedFetchOutcome = 'success' | 'unchanged' | 'failed';

export interface FeedFetchRecord {
  feedId: string;
  feedUrl: string;
  feedTitle?: string | null;
  outcome: FeedFetchOutcome;
  /** HTTP status where there was one. Null for a transport failure. */
  status?: number | null;
  durationMs: number;
  /** Items the document held, and how many of those were new to us. */
  items?: number | null;
  newItems?: number | null;
  error?: string | null;
}

async function prune(now: number): Promise<void> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  const cutoff = new Date(now - FEED_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.feedFetchLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
}

/**
 * Record one refresh attempt.
 *
 * Never throws. It is called from doRefresh's success and failure paths alike,
 * and a bookkeeping write that fails must not turn a working refresh into a
 * broken one — still less replace a handled failure with an unhandled one.
 */
export async function recordFeedFetch(rec: FeedFetchRecord): Promise<void> {
  try {
    await prisma.feedFetchLog.create({
      data: {
        feedId: rec.feedId,
        feedUrl: rec.feedUrl,
        feedTitle: (rec.feedTitle ?? '').slice(0, 200),
        outcome: rec.outcome,
        status: rec.status ?? null,
        durationMs: Math.max(0, Math.round(rec.durationMs)),
        items: rec.items ?? null,
        newItems: rec.newItems ?? null,
        error: rec.error ? rec.error.slice(0, MAX_ERROR) : null,
      },
    });
    await prune(Date.now());
  } catch (err) {
    logger.warn({ err, feedUrl: rec.feedUrl }, 'Could not record feed fetch');
  }
}
