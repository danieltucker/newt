import nodeFetch from 'node-fetch';
import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { parseFeed, parseFeedTitle, canonicalFeedKey } from './feedUtils';
import { canonicalArticleKey, articleHost } from './comments';
import { parseBlogFeedUrl, refreshBlogFeed } from './blogFeed';
import logger from './logger';
import { recordError, errorMessage } from './errorLog';
import { recordFeedFetch } from './feedLog';
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

// How much of a failing response to keep. "HTTP 403" on its own rarely explains
// anything; the body almost always does — a Cloudflare interstitial, a "feed
// moved" note, a login page served with a 200. Enough to recognise which of
// those it is, not enough to store somebody's error page in full.
const MAX_RESPONSE_SNIPPET = 600;

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
// noteFailure, which is the property to preserve when editing it. Both also
// write the attempt to FeedFetchLog, so that invariant is what keeps the
// refresh log complete — there is no path that fetches a feed silently.

/** What the attempt cost and what came back, for the log and the error detail. */
interface AttemptContext {
  startedAt: Date;
  durationMs: number;
  /** HTTP status where there was one. Absent for a transport failure. */
  status?: number | null;
  statusText?: string;
  contentType?: string | null;
  /** First MAX_RESPONSE_SNIPPET chars of the response, whitespace collapsed. */
  body?: string;
  /** Stack of the thrown error, for a failure with no response at all. */
  stack?: string;
  items?: number;
  newItems?: number;
}

function elapsed(startedAt: Date): number {
  return Date.now() - startedAt.getTime();
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** One line of readable text out of an arbitrary response body. */
function collapse(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > MAX_RESPONSE_SNIPPET ? `${s.slice(0, MAX_RESPONSE_SNIPPET)}…` : s;
}

// Reading the body of a response we've already decided is a failure is
// best-effort by definition: it may be empty, it may abort, and node-fetch
// throws here when the size ceiling is what went wrong in the first place. None
// of that should turn a recorded failure into an unrecorded one.
async function bodySnippet(resp: { text(): Promise<string> }): Promise<string> {
  try {
    return collapse(await resp.text());
  } catch {
    return '';
  }
}

// The block an admin unrolls under a failed row. Built here rather than at the
// call sites so every kind of failure — HTTP status, unreadable document,
// timeout — is described in the same shape and in the same order.
function failureDetail(
  feed: RefreshableFeed,
  ctx: AttemptContext,
  consecutiveFailures: number,
  lastSuccessAt: Date | null,
): string {
  const lines = [
    `Attempted: ${ctx.startedAt.toISOString()}`,
    `Took: ${formatMs(ctx.durationMs)}`,
    `Feed URL: ${feed.fetchUrl}`,
  ];
  if (ctx.status != null) lines.push(`Response: HTTP ${ctx.status}${ctx.statusText ? ` ${ctx.statusText}` : ''}`);
  if (ctx.contentType) lines.push(`Content-Type: ${ctx.contentType}`);
  lines.push(`Consecutive failures: ${consecutiveFailures}`);
  lines.push(`Last successful fetch: ${lastSuccessAt ? lastSuccessAt.toISOString() : 'never'}`);
  // Last, and labelled, because it is the only part that isn't ours: everything
  // above is a fact about the request, this is whatever the origin said.
  if (ctx.body) lines.push('', `Response body (first ${MAX_RESPONSE_SNIPPET} chars):`, ctx.body);
  if (ctx.stack) lines.push('', ctx.stack);
  return lines.join('\n');
}

async function noteSuccess(
  feed: RefreshableFeed,
  now: Date,
  ctx: AttemptContext & { unchanged?: boolean },
  data: Prisma.FeedUpdateInput = {},
): Promise<void> {
  const feedId = feed.id;
  try {
    const updated = await prisma.feed.update({
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
      select: { title: true },
    });
    await recordFeedFetch({
      feedId,
      feedUrl: feed.fetchUrl,
      feedTitle: updated.title,
      // A 304 is a success for the feed's health but a different event in the
      // log: "checked, nothing had changed" is most of what a healthy instance
      // does, and folding it into 'success' would make the log unable to show
      // when a feed last actually published.
      outcome: ctx.unchanged ? 'unchanged' : 'success',
      status: ctx.status ?? null,
      durationMs: ctx.durationMs,
      items: ctx.items ?? null,
      newItems: ctx.newItems ?? null,
    });
  } catch (err) {
    logger.warn({ err, feedId }, 'Could not record feed success');
  }
}

async function noteFailure(feed: RefreshableFeed, reason: string, ctx: AttemptContext): Promise<void> {
  try {
    const updated = await prisma.feed.update({
      where: { id: feed.id },
      data: {
        consecutiveFailures: { increment: 1 },
        lastError: reason,
        lastErrorAt: new Date(),
      },
      select: { consecutiveFailures: true, failureAlertedAt: true, title: true, lastSuccessAt: true },
    });

    await recordError({
      source: 'feed',
      message: reason,
      // Was the bare failure count, which said how often but never why. The
      // response itself is the thing that identifies a feed behind a login wall
      // or moved to a new address, and it is gone by the time anyone looks.
      detail: failureDetail(feed, ctx, updated.consecutiveFailures, updated.lastSuccessAt),
      // ErrorLog has always had this column; feed rows just never filled it, so
      // a 404 and a timeout looked alike in the table.
      status: ctx.status ?? null,
      feedUrl: feed.fetchUrl,
    });

    await recordFeedFetch({
      feedId: feed.id,
      feedUrl: feed.fetchUrl,
      feedTitle: updated.title,
      outcome: 'failed',
      status: ctx.status ?? null,
      durationMs: ctx.durationMs,
      error: reason,
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
      const posts = await refreshBlogFeed(feed.id, blogTarget, now);
      // No status: this one never went over HTTP, and reporting a fabricated
      // 200 would make the log lie about where the bytes came from.
      await noteSuccess(feed, now, { startedAt: now, durationMs: elapsed(now), items: posts });
    } catch (err) {
      logger.warn({ err, feedUrl: feed.fetchUrl }, 'Blog feed refresh failed');
      await noteFailure(feed, errorMessage(err), {
        startedAt: now,
        durationMs: elapsed(now),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    return;
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; Newt/1.0; +RSS)',
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

    const contentType = resp.headers.get('content-type');

    if (resp.status === 304) {
      // Unchanged. The items are still the live feed contents, so bump their
      // fetchedAt to keep the TTL sweep from eventually deleting a feed that
      // simply hasn't published in a while.
      await prisma.feedItem.updateMany({ where: { feedId: feed.id }, data: { fetchedAt: now } });
      // A 304 is the origin working correctly, so it counts as a success. Not
      // counting it would let a healthy, rarely-updated feed drift into the
      // failing list purely for not having changed.
      await noteSuccess(feed, now, {
        startedAt: now, durationMs: elapsed(now), status: 304, unchanged: true,
      });
      return;
    }
    if (!resp.ok) {
      // This was a bare `return`. A feed answering 404 or 403 forever therefore
      // looked exactly like a feed with nothing new — the single most likely way
      // for a subscription to be broken, and the one that reported nothing.
      const body = await bodySnippet(resp);
      await noteFailure(feed, `HTTP ${resp.status} ${resp.statusText}`.trim(), {
        startedAt: now,
        durationMs: elapsed(now),
        status: resp.status,
        statusText: resp.statusText,
        contentType,
        body,
      });
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
      // The document is the whole diagnosis here — 200 with no items says
      // nothing, whereas the first line of what arrived says whether it was a
      // login page, an HTML holding page, or XML we failed to parse.
      await noteFailure(feed, 'Response was not a readable feed', {
        startedAt: now,
        durationMs: elapsed(now),
        status: resp.status,
        statusText: resp.statusText,
        contentType,
        body: collapse(xml),
      });
      return;
    }

    // Which of these we haven't seen before, for the "44 items, 3 new" line in
    // the refresh log. Read before the upserts, since afterwards every link is
    // stored and the answer is always zero.
    const known = new Set(
      (await prisma.feedItem.findMany({ where: { feedId: feed.id }, select: { link: true } }))
        .map(r => r.link),
    );
    const newItems = items.reduce((n, item) => (known.has(item.link) ? n : n + 1), 0);

    // Process upserts in small chunks to avoid overwhelming the DB connection pool
    for (let i = 0; i < items.length; i += UPSERT_CHUNK) {
      const chunk = items.slice(i, i + UPSERT_CHUNK);
      await Promise.all(chunk.map(item =>
        prisma.feedItem.upsert({
          where: { feedId_link: { feedId: feed.id, link: item.link } },
          create: { feedId: feed.id, title: item.title, link: item.link, linkKey: canonicalArticleKey(item.link), linkHost: articleHost(item.link), pubDate: item.date, fetchedAt: now, readTime: item.readTime, snippet: item.snippet, content: item.content, imageUrl: item.imageUrl, categories: item.categories },
          // linkKey/linkHost/content are refreshed too, so rows stored before those
          // columns existed backfill on the next poll
          update: { fetchedAt: now, title: item.title, linkKey: canonicalArticleKey(item.link), linkHost: articleHost(item.link), readTime: item.readTime, snippet: item.snippet, content: item.content, imageUrl: item.imageUrl, categories: item.categories },
        }).catch(() => {})
      ));
    }

    // Items that dropped out of the feed expire after the TTL
    await prisma.feedItem.deleteMany({ where: { feedId: feed.id, fetchedAt: { lt: new Date(now.getTime() - FEED_TTL_MS) } } });

    // Store fresh validators for next time (null them out if the origin stopped
    // sending them, so we don't send stale conditional headers). Folded into
    // noteSuccess so the health columns and the validators land in one write.
    await noteSuccess(
      feed,
      now,
      {
        startedAt: now,
        durationMs: elapsed(now),
        status: resp.status,
        items: items.length,
        newItems,
      },
      {
        title,
        lastCheckedAt: now,
        etag: resp.headers.get('etag'),
        lastModified: resp.headers.get('last-modified'),
      },
    );
  } catch (err) {
    logger.warn({ err, feedUrl: feed.fetchUrl }, 'Feed refresh failed');
    // No response to describe — a timeout, a DNS failure or a body over the size
    // ceiling all land here. The duration is the informative part: an 8s one is
    // the fetch timeout, a 30ms one is a connection refused.
    await noteFailure(feed, errorMessage(err), {
      startedAt: now,
      durationMs: elapsed(now),
      stack: err instanceof Error ? err.stack : undefined,
    });
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
