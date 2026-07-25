import nodeFetch from 'node-fetch';
import prisma from './prisma';
import { parseFeed, parseFeedTitle, canonicalFeedKey } from './feedUtils';
import { canonicalArticleKey } from './comments';
import { parseBlogFeedUrl, refreshBlogFeed } from './blogFeed';
import logger from './logger';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

export const FEED_STALE_MS = 30 * 60 * 1000;        // 30 minutes
export const FEED_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

const UPSERT_CHUNK    = 10; // feed items upserted per DB batch
const MAX_CONCURRENCY = 5;  // feeds fetched in parallel — keep outbound bursts small

// The columns refreshOne needs. Any caller (route or scheduler) selecting these
// can hand rows straight in.
export interface RefreshableFeed {
  id: string;
  fetchUrl: string;
  lastCheckedAt: Date | null;
  etag: string | null;
  lastModified: string | null;
}

// Run `fn` over `items` with at most `concurrency` in flight — a bounded
// replacement for Promise.all so a big feed list can't open hundreds of sockets
// (or land on one CDN) at once.
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Atomically claim a feed for refresh by flipping lastCheckedAt from the value
// we observed to now. Only one caller can win the compare-and-set, so two users
// opening the same feed in the same window don't both fetch it. A claimed feed
// whose fetch then fails simply waits out the next stale window before retrying,
// which doubles as backoff for broken feeds.
async function claimFeed(feed: RefreshableFeed, now: Date): Promise<boolean> {
  const res = await prisma.feed.updateMany({
    where: { id: feed.id, lastCheckedAt: feed.lastCheckedAt },
    data: { lastCheckedAt: now },
  });
  return res.count === 1;
}

// In-process de-dup: if this instance is already fetching a feed, later callers
// await the same promise instead of racing. The DB claim (claimFeed) still
// guards across processes; this guards within one, which is the common case and
// the one that matters for the cold-start "await so the list isn't empty" path.
const inFlight = new Map<string, Promise<void>>();

function refreshOne(feed: RefreshableFeed): Promise<void> {
  const existing = inFlight.get(feed.id);
  if (existing) return existing;
  const p = doRefresh(feed).finally(() => inFlight.delete(feed.id));
  inFlight.set(feed.id, p);
  return p;
}

async function doRefresh(feed: RefreshableFeed): Promise<void> {
  const now = new Date();
  if (!(await claimFeed(feed, now))) return; // another process is already on it

  // Our own blog feeds are resolved straight from the database. Fetching them
  // over HTTP would mean the server calling back through its own public origin —
  // unreachable from inside the container in some deployments, refused by the
  // SSRF guard on a private address in dev, and lossy either way, since the post
  // HTML would have to survive a round trip through XML.
  const blogTarget = parseBlogFeedUrl(feed.fetchUrl);
  if (blogTarget) {
    try {
      await refreshBlogFeed(feed.id, blogTarget, now);
    } catch (err) {
      logger.warn({ err, feedUrl: feed.fetchUrl }, 'Blog feed refresh failed');
    }
    return;
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; NewTab/1.0; +RSS)',
    };
    // Conditional GET: let the origin answer 304 when nothing changed.
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;

    const resp = await nodeFetch(feed.fetchUrl, {
      timeout: 8000,
      redirect: 'follow',
      headers,
    } as FetchOptions);

    if (resp.status === 304) {
      // Unchanged. The items are still the live feed contents, so bump their
      // fetchedAt to keep the TTL sweep from eventually deleting a feed that
      // simply hasn't published in a while.
      await prisma.feedItem.updateMany({ where: { feedId: feed.id }, data: { fetchedAt: now } });
      return;
    }
    if (!resp.ok) return;

    const xml = await resp.text();
    const items = parseFeed(xml, 50);
    const title = parseFeedTitle(xml) || new URL(feed.fetchUrl).hostname.replace(/^www\./, '');

    // Process upserts in small chunks to avoid overwhelming the DB connection pool
    for (let i = 0; i < items.length; i += UPSERT_CHUNK) {
      const chunk = items.slice(i, i + UPSERT_CHUNK);
      await Promise.all(chunk.map(item =>
        prisma.feedItem.upsert({
          where: { feedId_link: { feedId: feed.id, link: item.link } },
          create: { feedId: feed.id, title: item.title, link: item.link, linkKey: canonicalArticleKey(item.link), pubDate: item.date, fetchedAt: now, readTime: item.readTime, snippet: item.snippet, content: item.content, imageUrl: item.imageUrl, categories: item.categories },
          // linkKey/content are refreshed too, so rows stored before those
          // columns existed backfill on the next poll
          update: { fetchedAt: now, title: item.title, linkKey: canonicalArticleKey(item.link), readTime: item.readTime, snippet: item.snippet, content: item.content, imageUrl: item.imageUrl, categories: item.categories },
        }).catch(() => {})
      ));
    }

    // Items that dropped out of the feed expire after the TTL
    await prisma.feedItem.deleteMany({ where: { feedId: feed.id, fetchedAt: { lt: new Date(now.getTime() - FEED_TTL_MS) } } });

    // Store fresh validators for next time (null them out if the origin stopped
    // sending them, so we don't send stale conditional headers).
    await prisma.feed.update({
      where: { id: feed.id },
      data: {
        title,
        lastCheckedAt: now,
        etag: resp.headers.get('etag'),
        lastModified: resp.headers.get('last-modified'),
      },
    });
  } catch (err) {
    logger.warn({ err, feedUrl: feed.fetchUrl }, 'Feed refresh failed');
  }
}

// Refresh the feeds that are stale (or all of them when force is set), never
// more than MAX_CONCURRENCY at a time. Each feed is claimed atomically first,
// so overlapping callers cooperate instead of duplicating the fetch.
export async function refreshStaleFeeds(
  feeds: RefreshableFeed[],
  opts: { force?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  const due = opts.force
    ? feeds
    : feeds.filter(f => !f.lastCheckedAt || now - f.lastCheckedAt.getTime() > FEED_STALE_MS);
  if (due.length === 0) return;
  await mapPool(due, MAX_CONCURRENCY, refreshOne);
}

// Feeds are shared: URL permutations collapse onto one Feed row via
// canonicalFeedKey, and each feed is fetched once no matter how many
// users/folders reference it. Returns the Feed rows for the given URLs and
// records the demand (lastRequestedAt) that keeps the scheduler interested.
export async function ensureFeeds(feedUrls: string[]) {
  const byKey = new Map<string, string>(); // canonicalKey -> first-seen fetchUrl
  for (const url of feedUrls) {
    const key = canonicalFeedKey(url);
    if (!byKey.has(key)) byKey.set(key, url);
  }
  const keys = Array.from(byKey.keys());
  if (keys.length === 0) return [];

  const existing = await prisma.feed.findMany({ where: { canonicalKey: { in: keys } } });
  const existingKeys = new Set(existing.map(f => f.canonicalKey));
  const missing = keys.filter(k => !existingKeys.has(k));

  let feeds = existing;
  if (missing.length > 0) {
    await prisma.feed.createMany({
      data: missing.map(k => ({ canonicalKey: k, fetchUrl: byKey.get(k)! })),
      skipDuplicates: true,
    });
    feeds = await prisma.feed.findMany({ where: { canonicalKey: { in: keys } } });
  }

  // Mark demand so the background scheduler keeps these feeds warm. Fire-and-
  // forget — the caller shouldn't wait on a bookkeeping write.
  prisma.feed
    .updateMany({ where: { id: { in: feeds.map(f => f.id) } }, data: { lastRequestedAt: new Date() } })
    .catch(() => {});

  return feeds;
}
