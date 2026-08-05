import prisma from './prisma';
import { refreshStaleFeeds, FEED_STALE_MS } from './feedRefresh';
import logger from './logger';

// The scheduler decouples feed refreshing from request handlers: it walks feeds
// that are both (a) demanded recently and (b) stale, and refreshes them through
// the same claim-protected, concurrency-limited path the routes use. Feeds that
// nobody has opened within DEMAND_WINDOW_MS go dormant and cost nothing until
// someone requests them again (which bumps lastRequestedAt in ensureFeeds).
const TICK_INTERVAL_MS = 5 * 60 * 1000;             // walk the table every 5 min
// Exported so the admin feed list can mark the feeds this window has dropped:
// "not checked for 3 weeks" is alarming until you know it means dormant, and
// the panel should say which it is rather than leave an admin to infer it.
export const DEMAND_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;  // ignore feeds unopened for 14 days
const BATCH            = 50;                          // feeds refreshed per tick

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  const now = Date.now();
  const staleBefore = new Date(now - FEED_STALE_MS);
  const demandAfter = new Date(now - DEMAND_WINDOW_MS);
  try {
    const feeds = await prisma.feed.findMany({
      where: {
        lastRequestedAt: { gte: demandAfter },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: staleBefore } }],
      },
      // Oldest checks first so a large table is worked fairly across ticks.
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: BATCH,
      select: { id: true, fetchUrl: true, lastCheckedAt: true, etag: true, lastModified: true },
    });
    if (feeds.length === 0) return;
    await refreshStaleFeeds(feeds);
    logger.info({ count: feeds.length }, 'Feed scheduler refreshed feeds');
  } catch (err) {
    logger.warn({ err }, 'Feed scheduler tick failed');
  }
}

export function startFeedScheduler(): void {
  if (timer) return;
  // Give the server a moment to finish booting before the first sweep.
  setTimeout(() => { tick().catch(() => {}); }, 15_000).unref?.();
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_INTERVAL_MS);
  timer.unref?.(); // don't keep the process alive on shutdown
  logger.info('Feed scheduler started');
}

export function stopFeedScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
