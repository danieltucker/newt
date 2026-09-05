/**
 * Searching the article archive, scoped to one reader's subscriptions.
 *
 * This was inline in routes/feeds.ts, answering the search box's dropdown and
 * nothing else. The search *page* asks the same question — with a larger limit
 * and alongside posts and explores — and the one thing that must not happen is
 * two copies of the scoping rule below, drifting. So the query moved here whole
 * and both callers go through it.
 */

import prisma from './prisma';
import { canonicalFeedKey } from './feedUtils';
import { toTsQuery, MIN_QUERY_LEN } from './feedSearch';

/** `%` and `_` are wildcards to LIKE; a tag containing one should match itself. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * The feeds this user subscribes to, and nothing else.
 *
 * **This is the whole boundary between "search my feeds" and "search Newt's
 * database", so it is worth being blunt about.** Feed and ArticleArchive rows
 * are shared across every account on the instance — that is the point of the
 * design, one fetch per feed no matter how many people follow it — which means
 * the archive carries no userId to filter on and a query that forgets to scope
 * by feed silently searches every article anyone here has ever ingested. That
 * is a disclosure bug and a spam surface at once: it would let anyone read the
 * contents of feeds they don't follow, and let a subscriber to one junk feed
 * inject results into everybody's search box.
 *
 * Scoping therefore starts from FeedSubscription, which *is* per-user, and the
 * feed ids it resolves to are the only ones any search query is allowed to see.
 *
 * Read-only on purpose: unlike the river's loader this does not call
 * ensureFeeds(). Searching is not a reason to create Feed rows, mark demand, or
 * kick off a refresh — a search should never be the thing that causes an
 * outbound fetch.
 */
async function subscribedFeeds(userId: string) {
  const subs = await prisma.feedSubscription.findMany({
    where: { userId },
    select: { url: true, name: true },
  });
  if (subs.length === 0) return { feedIds: [], feedById: new Map(), subByKey: new Map() };

  const subByKey = new Map(subs.map(s => [canonicalFeedKey(s.url), s]));
  const feeds = await prisma.feed.findMany({
    where: { canonicalKey: { in: [...subByKey.keys()] } },
    select: { id: true, fetchUrl: true, title: true },
  });
  return {
    feedIds: feeds.map(f => f.id),
    feedById: new Map(feeds.map(f => [f.id, f])),
    subByKey,
  };
}

type SearchRow = {
  id: string;
  title: string;
  link: string;
  feedId: string;
  pubDate: Date | null;
  categories: string[];
  snippet: string | null;
  imageUrl: string | null;
  rank: number;
};

/** One article, shaped the way every surface that lists one wants it. */
export interface ArticleHit {
  id: string;
  title: string;
  url: string;
  source: string;
  categories: string[];
  pubDate: Date | null;
  /** For the card layouts. Null is ordinary - plenty of feeds carry no art. */
  snippet: string | null;
  imageUrl: string | null;
}

export interface ArticleSearchOpts {
  /** Match the article's categories rather than its text — the `#tag` prefix. */
  tagged?: boolean;
  limit: number;
  /** How many matches to skip. The search page's second page and beyond. */
  offset?: number;
}

/**
 * Search across everything the user follows — the whole archive, not the page
 * the reader happens to be looking at.
 *
 * Dismissed articles are included. Dismissing is "I'm done with this" said to a
 * river flowing past; typing a search is going and looking for one specific
 * thing, and answering "you waved that away in March" with silence is how a
 * search box loses someone's trust.
 */
export async function searchArticles(
  userId: string,
  raw: string,
  { tagged = false, limit, offset = 0 }: ArticleSearchOpts,
): Promise<ArticleHit[]> {
  const trimmed = raw.trim();
  // Guarded before any query: a one-character prefix search matches a large
  // share of the corpus and is never what someone means.
  if (trimmed.length < MIN_QUERY_LEN) return [];

  const tsq = tagged ? null : toTsQuery(trimmed);
  if (!tagged && !tsq) return [];

  const { feedIds, feedById, subByKey } = await subscribedFeeds(userId);
  if (feedIds.length === 0) return [];

  // One row per story, not per copy — the same dedupe the river does, and for
  // the same reason: two feeds carrying one article is ordinary, and a result
  // list that shows it twice looks broken. Against the archive, not the river:
  // the corpus is years deep rather than the fortnight FeedItem holds, and the
  // archive is keyed on articleKey, so one article is one row and the dedupe
  // happened at write time.
  //
  // Scoped through ArticleArchiveFeed. The archive is deduped instance-wide,
  // so without the join a search would answer with articles from feeds the
  // reader has never subscribed to. The scalar subquery picks which of the
  // reader's own feeds to attribute it to; the EXISTS guarantees there is one.
  const rows = tagged
    ? await prisma.$queryRaw<SearchRow[]>`
        SELECT a."articleKey" AS "id", a."title", a."link", a."pubDate", a."categories",
               a."snippet", a."imageUrl",
               0::real AS "rank",
               (SELECT f."feedId" FROM "ArticleArchiveFeed" f
                 WHERE f."articleKey" = a."articleKey"
                   AND f."feedId" = ANY(${feedIds}::text[]) LIMIT 1) AS "feedId"
        FROM "ArticleArchive" a
        WHERE EXISTS (SELECT 1 FROM "ArticleArchiveFeed" f
                       WHERE f."articleKey" = a."articleKey"
                         AND f."feedId" = ANY(${feedIds}::text[]))
          AND EXISTS (
            SELECT 1 FROM unnest(a."categories") c
            WHERE c ILIKE ${escapeLike(trimmed) + '%'} ESCAPE '\\')
        -- articleKey breaks the tie. Without a total order the window below is
        -- not stable: two articles published in the same second can swap places
        -- between one page and the next, which shows one of them twice and the
        -- other not at all.
        ORDER BY a."pubDate" DESC NULLS LAST, a."articleKey"
        LIMIT ${limit} OFFSET ${offset}`
    : await prisma.$queryRaw<SearchRow[]>`
        SELECT a."articleKey" AS "id", a."title", a."link", a."pubDate", a."categories",
               a."snippet", a."imageUrl",
               ts_rank(a."searchVector", to_tsquery('english', ${tsq})) AS "rank",
               (SELECT f."feedId" FROM "ArticleArchiveFeed" f
                 WHERE f."articleKey" = a."articleKey"
                   AND f."feedId" = ANY(${feedIds}::text[]) LIMIT 1) AS "feedId"
        FROM "ArticleArchive" a
        WHERE EXISTS (SELECT 1 FROM "ArticleArchiveFeed" f
                       WHERE f."articleKey" = a."articleKey"
                         AND f."feedId" = ANY(${feedIds}::text[]))
          AND a."searchVector" @@ to_tsquery('english', ${tsq})
        -- Relevance first, recency only to settle ties. A local paper and a
        -- national one both matching "school closures" should be separated by
        -- how well they match, not by which polled most recently.
        -- articleKey settles what is left, so that paging past the first
        -- screen cannot repeat a row or drop one - see the tag branch above.
        ORDER BY "rank" DESC, a."pubDate" DESC NULLS LAST, a."articleKey"
        LIMIT ${limit} OFFSET ${offset}`;

  // Same naming ladder as the river, so a result and the card it corresponds
  // to are attributed identically: the subscription's own name, then the
  // publisher's title, then the hostname.
  return rows.map(r => {
    const feed = feedById.get(r.feedId);
    const sub  = feed ? subByKey.get(canonicalFeedKey(feed.fetchUrl)) : undefined;
    return {
      id: r.id,
      title: r.title,
      url: r.link,
      source: sub?.name || feed?.title || hostOf(feed?.fetchUrl ?? ''),
      categories: r.categories,
      pubDate: r.pubDate,
      snippet: r.snippet,
      imageUrl: r.imageUrl,
    };
  });
}
