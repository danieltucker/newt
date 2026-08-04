import prisma from './prisma';
import logger from './logger';

// Persisting the errors an admin should know about. Everything still goes to
// pino as well — this is a second, queryable copy, not a replacement. The log is
// for tailing a running process; this is for answering "what has been breaking
// this week, and for whom" from the admin panel, which is where somebody
// actually looks.

// Long enough to spot a pattern, short enough that one bad deploy in a retry
// loop can't fill the volume. Enforced by pruning on write (see below) rather
// than by a scheduled job — one fewer moving part, and the sweep only runs when
// there is something to sweep.
export const ERROR_LOG_RETENTION_DAYS = 30;

// A stack trace is a few KB; a node-fetch failure carrying an HTML error page is
// not. Truncate rather than trust the source, since the feed half of this takes
// its detail from a remote server.
const MAX_DETAIL = 4000;
const MAX_MESSAGE = 500;

// Prune at most once an hour however often we write. The check is in-process, so
// two instances would each run it — which is harmless: the delete is idempotent.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Whatever an unknown throw value has to say for itself. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

function errorDetail(err: unknown): string | undefined {
  if (err instanceof Error && err.stack) return err.stack;
  return undefined;
}

export interface ErrorRecord {
  source: 'server' | 'feed';
  message: string;
  detail?: string | null;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  userId?: string | null;
  username?: string | null;
  feedUrl?: string | null;
}

async function prune(now: number): Promise<void> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  const cutoff = new Date(now - ERROR_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.errorLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
}

/**
 * Record an error for the admin panel.
 *
 * Never throws and never rejects. It is called from an Express error handler and
 * from the feed refresher's catch block — the two places in the codebase where
 * throwing would replace a handled failure with an unhandled one. A logging
 * write that fails is a footnote, so it becomes a log line and nothing more.
 */
export async function recordError(rec: ErrorRecord): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: {
        source: rec.source,
        message: clamp(rec.message || 'Unknown error', MAX_MESSAGE),
        detail: rec.detail ? clamp(rec.detail, MAX_DETAIL) : null,
        method: rec.method ?? null,
        path: rec.path ?? null,
        status: rec.status ?? null,
        userId: rec.userId ?? null,
        username: rec.username ?? null,
        feedUrl: rec.feedUrl ?? null,
      },
    });
    await prune(Date.now());
  } catch (err) {
    logger.warn({ err }, 'Could not record error to the error log');
  }
}

/** recordError's fire-and-forget form, for callers with nothing to await it. */
export function recordErrorAsync(rec: ErrorRecord): void {
  void recordError(rec);
}

export { clamp as clampForLog, errorDetail };
