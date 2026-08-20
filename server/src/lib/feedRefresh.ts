import nodeFetch from 'node-fetch';
import { Prisma } from '@prisma/client';
import prisma from './prisma';
// FeedItem aliased: feedUtils' FeedItem is a *parsed* item off the wire, and the
// Prisma model of the same name is the stored row. Both appear in this file.
import { parseFeed, parseFeedTitle, canonicalFeedKey, type FeedItem as ParsedItem } from './feedUtils';
import { canonicalArticleKey, articleHost } from './comments';
import { parseBlogFeedUrl, refreshBlogFeed } from './blogFeed';
import logger from './logger';
import { recordError, errorMessage } from './errorLog';
import { recordFeedFetch } from './feedLog';
import { notifyAdminsOfFeedFailure, notifyAdminsOfFeedDisabled, shouldAlertForFeed } from './adminAlerts';
import { blockedRuleFor } from './feedBlocklist';
import { safeFetch } from './safeFetch';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number; size?: number };

export const FEED_STALE_MS = 30 * 60 * 1000;        // 30 minutes
// How stale `Feed.lastRequestedAt` may get before ensureFeeds rewrites it. Only
// the scheduler reads it, against a 14-day window, so this is about how often
// the shared row is written rather than about accuracy. See ensureFeeds.
const DEMAND_STAMP_MS = 60 * 60 * 1000;             // 1 hour
export const FEED_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

// Hard ceiling on a feed document. The timeout alone does not bound this: it is
// a socket *idle* timeout, so an endless response that dribbles a byte every few
// seconds never trips it while `resp.text()` buffers the whole thing into this
// process's heap. Any feed URL is attacker-chosen — a user only has to add a
// bookmark — so the body has to be bounded by bytes, not just by time.
//
// node-fetch aborts the stream and throws once the limit is passed, which the
// catch below already logs as a failed refresh.
//
// This was 2 MB, justified in this comment as "a few hundred KB at the high end"
// for a 50-item full-content feed. That estimate was wrong by an order of
// magnitude and it was quietly killing ordinary feeds: PCGamer's is 2.65 MB and
// 99% Invisible's is 3.45 MB, both plain, valid, widely-read feeds. 99PI reached
// FEED_FAILURE_DISABLE_THRESHOLD and was switched off altogether for being big.
//
// The limit counts *decompressed* bytes. Both feeds above are under 400 KB on
// the wire under gzip, so this bounds heap rather than bandwidth - which is also
// what sets the ceiling: at MAX_CONCURRENCY of 5 the worst case is ~50 MB of
// transient buffer, and that is the budget being spent here.
const MAX_FEED_BYTES = 10_000_000;

const UPSERT_CHUNK    = 10; // feed items upserted per DB batch
const MAX_CONCURRENCY = 5;  // feeds fetched in parallel — keep outbound bursts small

// How many consecutive failures before a feed stops being polled altogether.
//
// Well above FEED_FAILURE_ALERT_THRESHOLD (3) on purpose: alerting is cheap and
// wants to be early, switching a feed off is disruptive and wants to be sure. At
// the 30-minute stale window this is roughly ten hours of a feed being
// continuously broken — long enough to rule out an origin having a bad morning,
// short enough that a dead URL isn't refetched for weeks.
//
// Nothing is deleted when this trips. See the disabledAt note in schema.prisma.
export const FEED_FAILURE_DISABLE_THRESHOLD = 20;

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
// What to record when the fetch threw rather than answered.
//
// node-fetch's own words for an oversize body are "content size at <url> over
// limit: 10000000", which reads to an operator as a fault in Newt rather than as
// a feed that is simply bigger than we agreed to download, and buries the one
// number they could act on. That case gets a sentence; everything else - a
// timeout, a DNS failure, a refused connection - keeps the library's message,
// which for those is already the clearest description available.
function describeFetchError(err: unknown): string {
  const oversize = typeof err === 'object' && err !== null
    && (err as { type?: string }).type === 'max-size';
  if (!oversize) return errorMessage(err);
  return `Feed is larger than the ${Math.round(MAX_FEED_BYTES / 1_000_000)} MB download limit`;
}

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

    // Long enough broken that continuing to poll it is just wasted outbound
    // requests. Switch it off — the row, its subscriptions and its history all
    // stay, and an admin can retry or remove it deliberately.
    //
    // Checked with `===` rather than `>=` so this fires exactly once, on the
    // attempt that crosses the line. A disabled feed can't be claimed, so in
    // practice there is no later attempt — but that is an invariant of
    // claimFeed, and this shouldn't depend on it to avoid re-alerting.
    if (updated.consecutiveFailures === FEED_FAILURE_DISABLE_THRESHOLD) {
      await prisma.feed.update({
        where: { id: feed.id },
        data: { disabledAt: new Date(), disabledReason: 'failing' },
      });
      // Unconditional, unlike the failure alert: being switched off is a state
      // change an admin has to know about, and it happens once. Rate-limiting it
      // behind failureAlertedAt would swallow the one message that matters.
      await notifyAdminsOfFeedDisabled(feed.fetchUrl, updated.title, updated.consecutiveFailures);
      logger.warn(
        { feedUrl: feed.fetchUrl, failures: updated.consecutiveFailures },
        'Feed disabled after repeated failures',
      );
      return;
    }

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
//
// `disabledAt: null` in the where is the single enforcement point for disabling.
// Every fetch in this file goes through here, so a disabled feed cannot be
// fetched by any caller — including one holding a Feed row read before it was
// switched off, which is exactly what happens when an admin blocks a domain
// while a refresh sweep is already in flight.
async function claimFeed(feed: RefreshableFeed, now: Date): Promise<boolean> {
  const res = await prisma.feed.updateMany({
    where: { id: feed.id, lastCheckedAt: feed.lastCheckedAt, disabledAt: null },
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
  if (!(await claimFeed(feed, now))) return; // disabled, or another process has it

  // A rule may have been added since this feed was subscribed to, and a feed
  // that redirected onto a blocked host would never have been caught at add
  // time. Checked before the request goes out, so a blocked domain gets no
  // traffic from this server at all — which is the point of blocking it.
  const rule = await blockedRuleFor(feed.fetchUrl);
  if (rule) {
    await prisma.feed.update({
      where: { id: feed.id },
      data: { disabledAt: now, disabledReason: 'blocked' },
    });
    logger.info({ feedUrl: feed.fetchUrl, pattern: rule.pattern }, 'Feed disabled by block rule');
    return;
  }

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

    // safeFetch, not nodeFetch: a feed URL is supplied by whoever subscribed and
    // is polled by the scheduler forever after, so it is the single most
    // attacker-controlled outbound request this server makes. It used to go out
    // with no address check at all and `redirect: 'follow'` - which reached any
    // internal service the container could see, and stored whatever came back as
    // articles. Every hop is now resolved, judged and pinned. See lib/safeFetch.
    const resp = await safeFetch(feed.fetchUrl, {
      timeout: 8000,
      size: MAX_FEED_BYTES,
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
          // firstSeenAt is set on create and never on update — that is the whole
          // contract of the column, and what makes it usable as the watermark for
          // "new since you loaded". See the note on it in schema.prisma.
          create: { feedId: feed.id, title: item.title, link: item.link, linkKey: canonicalArticleKey(item.link), linkHost: articleHost(item.link), pubDate: item.date, fetchedAt: now, firstSeenAt: now, readTime: item.readTime, snippet: item.snippet, content: item.content, imageUrl: item.imageUrl, categories: item.categories },
          // linkKey/linkHost/content are refreshed too, so rows stored before those
          // columns existed backfill on the next poll
          update: { fetchedAt: now, title: item.title, linkKey: canonicalArticleKey(item.link), linkHost: articleHost(item.link), readTime: item.readTime, snippet: item.snippet, content: item.content, imageUrl: item.imageUrl, categories: item.categories },
        }).catch(() => {})
      ));

      // The same items into the archive, in the same chunk, so search and
      // Explore keep years of them after the river has moved on. See the
      // ArticleArchive note in schema.prisma for why this is written here on
      // the way in rather than by the sweep on the way out.
      await Promise.all(chunk.map(item => archiveItem(feed.id, item, now).catch(() => {})));
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
    await noteFailure(feed, describeFetchError(err), {
      startedAt: now,
      durationMs: elapsed(now),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

// How long an article stays searchable after the last feed stopped carrying it.
//
// Generously long because the cost is storage and the benefit is the whole point
// of the table: Explore has been asking for a 365-day grounding window since it
// was written (feedContext MAX_AGE_DAYS) against a corpus that could never hold
// more than a fortnight. Nothing reads this but the sweep, so changing it is a
// number edit and not a migration.
export const ARCHIVE_TTL_MS = 3 * 365 * 24 * 60 * 60 * 1000; // ~3 years

// One item into the archive.
//
// firstSeenAt is written on create and never updated - the same contract
// FeedItem.firstSeenAt has, and here it means the earliest sighting across every
// feed that ever carried the article. lastSeenAt moves on every sighting and is
// what retention measures, so a piece a publisher keeps listing never ages out
// while it is still being carried.
//
// `?? undefined` on the text columns rather than passing null through: two feeds
// carrying one article is ordinary and they do not always carry it equally well,
// so a copy that arrives with no snippet must not blank the one that had it.
// Prisma skips an undefined field, so the better-populated copy wins whichever
// order they arrive in. The cost is that a genuinely cleared snippet never
// clears, which is the right way round for a table nobody edits by hand.
async function archiveItem(feedId: string, item: ParsedItem, now: Date): Promise<void> {
  const articleKey = canonicalArticleKey(item.link);

  await prisma.articleArchive.upsert({
    where: { articleKey },
    create: {
      articleKey,
      link: item.link,
      linkHost: articleHost(item.link),
      title: item.title,
      snippet: item.snippet,
      content: item.content,
      imageUrl: item.imageUrl,
      readTime: item.readTime,
      categories: item.categories,
      pubDate: item.date,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      lastSeenAt: now,
      title: item.title,
      snippet: item.snippet ?? undefined,
      content: item.content ?? undefined,
      imageUrl: item.imageUrl ?? undefined,
      readTime: item.readTime ?? undefined,
      pubDate: item.date ?? undefined,
    },
  });

  // Which feed vouched for it, so search stays scoped to a subscriber's own
  // feeds. Empty update: the pair either exists or does not, and there is
  // nothing about it to change.
  await prisma.articleArchiveFeed.upsert({
    where: { articleKey_feedId: { articleKey, feedId } },
    create: { articleKey, feedId },
    update: {},
  });
}

/**
 * Drop archived articles nobody is holding on to.
 *
 * The guard is the third tier of the retention design, and it is computed here
 * rather than materialised as a `pinned` column on purpose. A flag would have to
 * be written by every path that creates a reference, and would still be wrong in
 * the ordinary case: you archive an article in March and comment on it in June,
 * by which time nothing is looking at the flag again. Asking the question at
 * sweep time is always right, needs no hooks in comments, posts or the reading
 * list, and self-heals if a reference goes away.
 *
 * All three joins are indexed on articleKey - Comment and PostReference have
 * carried one all along, and ReadingListItem gained one with this table.
 *
 * A NULL ReadingListItem.articleKey is "unknown", never "not referenced": those
 * are rows written before the column existed and not yet backfilled, and
 * deleting an article because we have not worked out its key yet would be the
 * one unrecoverable mistake available here. They are excluded from the guard,
 * which keeps *more* than necessary until scripts/backfillArticleKeys.ts runs.
 */
export async function pruneArticleArchive(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ARCHIVE_TTL_MS);
  const deleted = await prisma.$executeRaw`
    DELETE FROM "ArticleArchive" a
    WHERE a."lastSeenAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "Comment" c        WHERE c."articleKey" = a."articleKey")
      AND NOT EXISTS (SELECT 1 FROM "PostReference" p  WHERE p."articleKey" = a."articleKey")
      AND NOT EXISTS (SELECT 1 FROM "ReadingListItem" r WHERE r."articleKey" = a."articleKey")
  `;
  if (deleted > 0) logger.info({ deleted }, 'Archive retention sweep removed articles');
  return deleted;
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
  //
  // Only for the feeds whose stamp is actually old. This runs on every
  // /articles request, including every "load more", and `Feed` rows are
  // *shared* between everyone subscribed to the same feed - so on a popular
  // feed every reader's every scroll was an UPDATE contending on one row, and
  // leaving a dead tuple behind for autovacuum. The consumer is the scheduler's
  // 14-day demand window (see DEMAND_WINDOW_MS), which cannot tell the
  // difference: an hour of granularity is four hundred times finer than it
  // needs, and turns a write per request into a write per feed per hour.
  const now = new Date();
  const staleStamp = new Date(now.getTime() - DEMAND_STAMP_MS);
  const needsStamp = feeds
    .filter(f => !f.lastRequestedAt || f.lastRequestedAt < staleStamp)
    .map(f => f.id);
  if (needsStamp.length > 0) {
    prisma.feed
      .updateMany({ where: { id: { in: needsStamp } }, data: { lastRequestedAt: now } })
      .catch(() => {});
  }

  return feeds;
}
