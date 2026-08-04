import nodeFetch from 'node-fetch';
import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { parseFeed, parseFeedTitle, canonicalFeedKey } from './feedUtils';
import { canonicalArticleKey } from './comments';
import { parseBlogFeedUrl, refreshBlogFeed } from './blogFeed';
import logger from './logger';
import { recordError, errorMessage } from './errorLog';
import { notifyAdminsOfFeedFailure, shouldAlertForFeed } from './adminAlerts';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number; size?: number };

export const FEED_STALE_MS = 30 * 60 * 1000;        // 30 minutes
export const FEED_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

// Hard ceiling on a feed document. The timeout alone does not bound this: it is
// a socket *idle* timeout, so an endless response that dribbles a byte every few
// seconds never trips it while `resp.text()` buffers the whole thing into this
// process's heap. Any feed URL is attacker-chosen — a user only has to add a
// bookmark — so the body has to be bounded by bytes, not just by time.
//
// node-fetch aborts the stream and throws once the limit is passed, which the
// catch below already logs as a failed refresh. 2 MB is generous: a 50-item feed
// with full content runs a few hundred KB at the high end.
const MAX_FEED_BYTES = 2_000_000;

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

// ── Feed health ───────────────────────────────────────────────────────────
// A failing feed used to be silent. `if (!resp.ok) return` and the catch below
// both dropped the failure on the floor (the catch at least logged it), so a
// feed that had started 404ing was indistinguishable from a feed that just
// hadn't published anything — no signal in the UI, none in the admin panel, and
// a pino line nobody was tailing.
//
// Every exit from doRefresh now ends in exactly one of noteSuccess or
// noteFailure, which is the property to preserve when editing it.

async function noteSuccess(feedId: string, now: Date, data: Prisma.FeedUpdateInput = {}): Promise<void> {
  try {
    await prisma.feed.update({
      where: { id: feedId },
      data: {
        ...data,
        lastSuccessAt: now,
        // Cleared, not decremented: the count measures the *current* broken run,
        // and clearing the alert stamp is what lets a feed that breaks again
        // later be reported again.
        consecutiveFailures: 0,
        lastError: null,
        lastErrorAt: null,
        failureAlertedAt: null,
      },
    });
  } catch (err) {
    logger.warn({ err, feedId }, 'Could not record feed success');
  }
}

async function noteFailure(feed: RefreshableFeed, reason: string): Promise<void> {
  try {
    const updated = await prisma.feed.update({
      where: { id: feed.id },
      data: {
        consecutiveFailures: { increment: 1 },
        lastError: reason,
        lastErrorAt: new Date(),
      },
      select: { consecutiveFailures: true, failureAlertedAt: true, title: true },
    });

    await recordError({
      source: 'feed',
      message: reason,
      detail: `${updated.consecutiveFailures} consecutive failure(s)`,
      feedUrl: feed.fetchUrl,
    });

    if (shouldAlertForFeed(updated.consecutiveFailures, updated.failureAlertedAt)) {
      await notifyAdminsOfFeedFailure(feed.fetchUrl, updated.title, updated.consecutiveFailures);
      // Stamped after the alert lands, so a failed send is retried next tick
      // rather than swallowed by a stamp that says it was already reported.
      await prisma.feed.update({
        where: { id: feed.id },
        data: { failureAlertedAt: new Date() },
      });
    }
  } catch (err) {
    logger.warn({ err, feedUrl: feed.fetchUrl }, 'Could not record feed failure');
  }
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
      await noteSuccess(feed.id, now);
    } catch (err) {
      logger.warn({ err, feedUrl: feed.fetchUrl }, 'Blog feed refresh failed');
      await noteFailure(feed, errorMessage(err));
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
      size: MAX_FEED_BYTES,
      redirect: 'follow',
      headers,
    } as FetchOptions);

    if (resp.status === 304) {
      // Unchanged. The items are still the live feed contents, so bump their
      // fetchedAt to keep the TTL sweep from eventually deleting a feed that
      // simply hasn't published in a while.
      await prisma.feedItem.updateMany({ where: { feedId: feed.id }, data: { fetchedAt: now } });
      // A 304 is the origin working correctly, so it counts as a success. Not
      // counting it would let a healthy, rarely-updated feed drift into the
      // failing list purely for not having changed.
      await noteSuccess(feed.id, now);
      return;
    }
    if (!resp.ok) {
      // This was a bare `return`. A feed answering 404 or 403 forever therefore
      // looked exactly like a feed with nothing new — the single most likely way
      // for a subscription to be broken, and the one that reported nothing.
      await noteFailure(feed, `HTTP ${resp.status} ${resp.statusText}`.trim());
      return;
    }

    const xml = await resp.text();
    const items = parseFeed(xml, 50);
    const parsedTitle = parseFeedTitle(xml);
    const title = parsedTitle || new URL(feed.fetchUrl).hostname.replace(/^www\./, '');

    // 200 with nothing parseable is the other quiet failure: a login wall, an
    // HTML error page served with a 200, or a feed whose XML has broken. An
    // empty feed is legal, so this only judges a document that yielded no items
    // *and* no title - a real feed always has at least the latter.
    if (items.length === 0 && !parsedTitle) {
      await noteFailure(feed, 'Response was not a readable feed');
      return;
    }

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
    // sending them, so we don't send stale conditional headers). Folded into
    // noteSuccess so the health columns and the validators land in one write.
    await noteSuccess(feed.id, now, {
      title,
      lastCheckedAt: now,
      etag: resp.headers.get('etag'),
      lastModified: resp.headers.get('last-modified'),
    });
  } catch (err) {
    logger.warn({ err, feedUrl: feed.fetchUrl }, 'Feed refresh failed');
    await noteFailure(feed, errorMessage(err));
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
