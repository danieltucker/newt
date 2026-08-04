import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ensureFeeds, refreshStaleFeeds } from '../lib/feedRefresh';
import { canonicalFeedKey } from '../lib/feedUtils';

const router = Router();
router.use(requireAuth);

/**
 * One publisher, gathered up: everything this account holds that came from a
 * single site.
 *
 * The feed is a river of a hundred publishers and the reading list is a pile
 * sorted by when you saved things, so "what has Ars Technica been up to" was a
 * question neither surface could answer. The domain is the key because it is
 * the one identifier every one of these records already carries — a feed
 * subscription, a bookmark tile and a saved article share no id, but they do
 * share a hostname.
 *
 * Nothing here is fetched on demand: this is a view over what the account
 * already has. A site the user neither subscribes to nor has saved from
 * answers 200 with empty lists rather than 404 — the page still has something
 * to say (the domain, a link to it, an offer to subscribe), and a 404 would
 * make every unsaved byline on a card a dead link.
 */

// Articles per page. The feed's own default is 10; a site page is a shorter
// list by nature, and asking for more of one publisher is cheap — the items are
// already stored.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Hostnames are bounded by DNS at 253 characters. Anything longer is not a
// domain someone typed, so it is rejected before it reaches a query.
const MAX_DOMAIN = 253;

/**
 * The canonical form of a site key: lowercase, no scheme, no `www.`, no path.
 *
 * Callers reach this route from wherever a hostname is printed — a card byline,
 * a bookmark tile, a pasted URL — so the parameter is normalised rather than
 * trusted. Returns null for anything that isn't a plausible hostname, which is
 * the 400.
 */
export function normalizeDomain(raw: string): string | null {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_DOMAIN) return null;
  // Accepts a bare host or a full URL, since both are things a link might carry.
  const host = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (!host || host.length > MAX_DOMAIN) return null;
  // A label is alphanumerics and hyphens; at least two labels, and the last one
  // is alphabetic. Deliberately stricter than the DNS spec — this is a display
  // key for public web hosts, not a resolver.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return null;
  return host;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Whether a feed at `feedHost` is *this publisher's* feed.
 *
 * Not an equality test, because a great many sites don't serve their feed from
 * their own host — Ars Technica's is at feeds.arstechnica.com. A subdomain
 * counts; anything else does not.
 *
 * The temptation is to infer ownership from the articles instead ("whichever
 * feeds deal this domain"), and it is wrong: Hacker News links to TechCrunch all
 * day, which would have made /s/techcrunch.com announce itself as "Hacker News:
 * Front Page" and claim you follow TechCrunch when you don't. Linking to a site
 * is not publishing it.
 */
function isFeedOfSite(feedHost: string, domain: string): boolean {
  return feedHost === domain || feedHost.endsWith(`.${domain}`);
}

// The publisher's front page. Bookmarks store a bare domain rather than a URL,
// so this is derived rather than read — https, because a site worth reading in
// 2026 serves it and a browser will redirect if not.
function homeUrlFor(domain: string): string {
  return `https://${domain}`;
}

router.get('/:domain', async (req: AuthRequest, res: Response): Promise<void> => {
  const domain = normalizeDomain(req.params.domain);
  if (!domain) { res.status(400).json({ error: 'Not a site address' }); return; }

  const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || DEFAULT_LIMIT));
  const userId = req.userId!;

  const [subs, bookmarks, feedFolders] = await Promise.all([
    prisma.feedSubscription.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: { id: true, url: true, name: true, feedFolderId: true },
    }),
    // Not a `where: { domain }`: a bookmark's `domain` column is really a link
    // and may carry a path ("github.com/danieltucker" — see parseLink), and it
    // is stored as typed. An account's bookmarks are capped, so normalising the
    // whole (small) list in memory is both cheaper and more correct than trying
    // to express that in SQL.
    prisma.bookmark.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: {
        id: true, name: true, domain: true, pinned: true, unreadCount: true,
        folder: { select: { id: true, name: true, color: true } },
      },
    }),
    prisma.feedFolder.findMany({ where: { userId }, select: { id: true, name: true, color: true } }),
  ]);
  const bookmark = bookmarks.find(b => normalizeDomain(b.domain) === domain) ?? null;

  const folderById = new Map(feedFolders.map(f => [f.id, f]));

  let articles: unknown[] = [];
  let total = 0;
  let unread = 0;

  // This publisher's own feeds — what "Followed" means, and where the site's
  // name comes from. Decided by where the feed lives, never by what it links to.
  const mine = subs.filter(s => isFeedOfSite(hostOf(s.url), domain));

  if (subs.length > 0) {
    const allFeeds = await ensureFeeds(subs.map(s => s.url));
    const subByKey = new Map(subs.map(s => [canonicalFeedKey(s.url), s]));
    const feedById = new Map(allFeeds.map(f => [f.id, f]));

    // The *articles* are scoped by their own host rather than by which feed
    // brought them, and deliberately more broadly than `mine` above: a piece
    // published at this domain is from this site whichever feed happened to
    // deal it. Following the publisher is the common way to get one; a link out
    // of an aggregator is another, and it is the same article either way.
    //
    // Matching on the feed address instead would have made /s/arstechnica.com —
    // the domain printed on every one of its cards — answer nothing at all,
    // because that feed lives at feeds.arstechnica.com. See FeedItem.linkHost.
    //
    // Still bounded to this account's own feeds: items are shared rows, and the
    // page is a view of what *you* subscribe to, not of everything the instance
    // happens to hold.
    //
    // Dismissed items are included, unlike in the river. Dismissing means "not
    // in my feed", not "never happened" — and a page whose whole promise is
    // everything from this site would be lying if it hid them.
    const where = { feedId: { in: allFeeds.map(f => f.id) }, linkHost: domain };
    const [items, count, unreadCount] = await Promise.all([
      prisma.feedItem.findMany({
        where,
        orderBy: [{ pubDate: 'desc' }, { fetchedAt: 'desc' }],
        skip: offset,
        take: limit,
      }),
      prisma.feedItem.count({ where }),
      prisma.feedItem.count({ where: { ...where, reads: { none: { userId } } } }),
    ]);
    total = count;
    unread = unreadCount;

    // Catch up in the background, and only on the feeds this page is about.
    // Unlike the main river this never blocks on a first fetch — the page has
    // plenty to show without waiting on the network.
    const relevantKeys = new Set(mine.map(s => canonicalFeedKey(s.url)));
    refreshStaleFeeds(allFeeds.filter(f => relevantKeys.has(f.canonicalKey))).catch(() => {});

    const itemIds = items.map(i => i.id);
    const [reads, dismissals] = await Promise.all([
      prisma.readFeedItem.findMany({ where: { userId, itemId: { in: itemIds } }, select: { itemId: true } }),
      prisma.dismissedFeedItem.findMany({ where: { userId, itemId: { in: itemIds } }, select: { itemId: true } }),
    ]);
    const readIds = new Set(reads.map(r => r.itemId));
    const dismissedIds = new Set(dismissals.map(d => d.itemId));

    articles = items.map(i => {
      const feed = feedById.get(i.feedId);
      const sub = feed ? subByKey.get(canonicalFeedKey(feed.fetchUrl)) : undefined;
      return {
        id: i.id,
        read: readIds.has(i.id),
        dismissed: dismissedIds.has(i.id),
        feedUrl: feed?.fetchUrl ?? '',
        title: i.title,
        link: i.link,
        source: sub?.name || feed?.title || domain,
        feedFolderId: sub?.feedFolderId ?? null,
        pubDate: i.pubDate,
        fetchedAt: i.fetchedAt,
        readTime: i.readTime,
        snippet: i.snippet,
        imageUrl: i.imageUrl,
        categories: i.categories,
      };
    });
  }

  // The user's own saves from this site. `source` is stored as a bare domain by
  // the reading list's add form, but articles saved from a feed card carry the
  // feed's display name instead — so the URL is what's matched on, and the whole
  // (small, per-user) list is filtered in memory rather than with a LIKE.
  const savedRows = await prisma.readingListItem.findMany({
    where: { userId },
    orderBy: { savedAt: 'desc' },
    select: {
      id: true, url: true, title: true, source: true, readTime: true, tag: true,
      imageUrl: true, inLibrary: true, folderId: true, savedAt: true,
    },
  });
  const saved = savedRows.filter(r => hostOf(r.url) === domain);

  // The feed's own title is the publisher's name as the publisher writes it, so
  // it outranks a derived hostname but not a name the user set on the
  // subscription or the bookmark tile.
  const feedRows = mine.length === 0 ? [] : await prisma.feed.findMany({
    where: { canonicalKey: { in: mine.map(s => canonicalFeedKey(s.url)) } },
    select: {
      canonicalKey: true, fetchUrl: true, title: true,
      lastCheckedAt: true, lastSuccessAt: true, consecutiveFailures: true,
    },
  });
  const feedByKey = new Map(feedRows.map(f => [f.canonicalKey, f]));

  const primary = mine[0];
  const primaryFeed = primary ? feedByKey.get(canonicalFeedKey(primary.url)) : undefined;
  const name = bookmark?.name || primary?.name || primaryFeed?.title || domain;

  res.json({
    domain,
    name,
    homeUrl: homeUrlFor(domain),
    bookmark: bookmark
      ? {
          id: bookmark.id,
          name: bookmark.name,
          pinned: bookmark.pinned,
          unreadCount: bookmark.unreadCount,
          folder: bookmark.folder,
        }
      : null,
    subscriptions: mine.map(s => {
      const feed = feedByKey.get(canonicalFeedKey(s.url));
      return {
        id: s.id,
        url: s.url,
        name: s.name || feed?.title || domain,
        folder: s.feedFolderId ? folderById.get(s.feedFolderId) ?? null : null,
        lastCheckedAt: feed?.lastCheckedAt ?? null,
        lastSuccessAt: feed?.lastSuccessAt ?? null,
        // Non-zero means the feed is broken *now* — see the Feed model. The page
        // says so rather than showing a stale list with no explanation.
        failing: (feed?.consecutiveFailures ?? 0) >= 3,
      };
    }),
    counts: {
      articles: total,
      unread,
      saved: saved.filter(s => !s.inLibrary).length,
      library: saved.filter(s => s.inLibrary).length,
    },
    articles,
    hasMore: offset + articles.length < total,
    saved,
  });
});

export default router;
