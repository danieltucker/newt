/**
 * Searching what was written here — posts and explores — for the search page.
 *
 * The archive already had a search (lib/articleSearch): "what came past me in
 * my feeds about X". This is the other half of the question the search page
 * asks, and the two corpora it adds are the ones nobody could reach by text
 * before. A post was findable only through its author's profile or a tag hub;
 * an explore only from the article it was started from.
 *
 * ── Where the authorisation happens ──
 * In exactly one place, and it is not the SQL below.
 *
 * Each search runs in two steps: a raw tsquery that ranks *candidates*, then a
 * Prisma read that applies `viewerScope` — the same tiers-and-blocks rule the
 * explored-paths list and its counts already run on. The split is deliberate.
 * Full-text ranking has to be SQL, and a hand-written visibility clause in that
 * SQL would be a second copy of a rule whose failure mode is a stranger's
 * private writing appearing in somebody's results. So the SQL decides only what
 * is *relevant*, and the authoritative filter is the one already in use
 * everywhere else.
 *
 * The cost of that split is recall, not correctness: the candidate window is
 * drawn before visibility is applied, so a query matching far more hidden rows
 * than visible ones can return fewer results than exist. CANDIDATE_FACTOR below
 * is the size of that cushion. Returning a short list is a bug worth having;
 * returning someone else's post is not.
 */

import prisma from './prisma';
import { toTsQuery, MIN_QUERY_LEN } from './feedSearch';
import { normalizeTag } from './tags';
import { toPublicUser, PUBLIC_USER_SELECT, PublicUser } from './friends';
import { viewerScope, plainish, clamp } from './exploredPaths';

const SNIPPET_CHARS = 220;

/**
 * How many ranked candidates to draw per result asked for.
 *
 * Five, with a floor, because the ratio that matters is visible-to-matching and
 * on any instance where people mostly write in public that ratio is close to
 * one. A larger window costs a wider index scan on every search; a smaller one
 * starts dropping real results on an instance full of private drafts.
 */
const CANDIDATE_FACTOR = 5;
const CANDIDATE_FLOOR = 40;
const CANDIDATE_CEILING = 300;

/**
 * The window is drawn over `offset + limit`, not over `limit`.
 *
 * Paging here is not "skip 20 rows in SQL": the ranking query does not know
 * about visibility, so the rows that survive it are a subset of unknown size.
 * The only way to hand back page two is to rank far enough to contain page two,
 * filter, and then slice. Which means the cost of a page grows with how deep
 * into the results it is — the ceiling below is what stops that being unbounded.
 */
function candidateWindow(through: number): number {
  return Math.min(CANDIDATE_CEILING, Math.max(CANDIDATE_FLOOR, through * CANDIDATE_FACTOR));
}

/** id + rank, which is all the ranking query is trusted to decide. */
type RankRow = { id: string; rank: number };

export interface PostHit {
  kind: 'post';
  id: string;
  title: string;
  /** Where following this goes — the author's page for it, not its raw URL. */
  href: string;
  snippet: string;
  tags: string[];
  visibility: string;
  author: ReturnType<typeof toPublicUser> | null;
  own: boolean;
  at: string | null;
  /** The post's cover, as a site-relative path. "" means none. */
  imageUrl: string;
}

export interface ExploreHit {
  kind: 'explore';
  id: string;
  title: string;
  href: string;
  snippet: string;
  /** The article it was started from, when it was started from one. */
  sourceTitle: string;
  visibility: string;
  author: ReturnType<typeof toPublicUser> | null;
  /** 'user' — somebody asked it. 'auto' — an AiTask generated it. */
  origin: 'user' | 'auto';
  own: boolean;
  /** Turns in the conversation, so a one-question thread reads as one. */
  turns: number;
  at: string | null;
}

/**
 * Posts matching `raw` that this viewer is allowed to read.
 *
 * Own drafts are included, private ones as well. This is the reader's own
 * search over their own instance, and a post they have not published yet is
 * still theirs to find — the visibility badge on the card is what says which
 * ones nobody else can see.
 */
export async function searchPosts(
  viewerId: string | undefined,
  raw: string,
  limit: number,
  offset = 0,
): Promise<PostHit[]> {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_QUERY_LEN) return [];
  const tsq = toTsQuery(trimmed);
  if (!tsq) return [];

  const ranked = await prisma.$queryRaw<RankRow[]>`
    SELECT "id", ts_rank("searchVector", to_tsquery('english', ${tsq})) AS "rank"
    FROM "BlogPost"
    WHERE "searchVector" @@ to_tsquery('english', ${tsq})
    -- Relevance first, recency only to settle ties: two posts that match a
    -- phrase equally well are separated by which is current, not the reverse.
    -- id settles what rank and date leave tied, so the window is a total order
    -- and page two cannot repeat a row from page one.
    ORDER BY "rank" DESC, "publishedAt" DESC, "id"
    LIMIT ${candidateWindow(offset + limit)}`;
  if (ranked.length === 0) return [];

  const order = new Map(ranked.map((r, i) => [r.id, i]));
  const { tiers, notWalled } = await viewerScope(viewerId);

  const posts = await prisma.blogPost.findMany({
    where: { id: { in: ranked.map(r => r.id) }, OR: tiers, ...notWalled },
    select: {
      id: true, title: true, slug: true, excerpt: true, tags: true, heroImage: true,
      visibility: true, publishedAt: true, userId: true, url: true,
      user: { select: PUBLIC_USER_SELECT },
    },
  });

  return posts
    // Back into the ranking the database worked out. `findMany` returns rows in
    // whatever order it likes, and the whole point of the first query was the
    // order, so it is reapplied rather than re-derived.
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(offset, offset + limit)
    .map(p => ({
      kind: 'post' as const,
      id: p.id,
      title: p.title,
      // Encoded, matching the client's blogPathFor — a username is not
      // charset-restricted server-side, and a raw one can produce a path that
      // does not resolve. Falls back to the canonical URL for the case that
      // should not happen (a post with no author) rather than to a dead link.
      href: p.user ? `/u/${encodeURIComponent(p.user.username)}/${p.slug}` : p.url,
      snippet: clamp(p.excerpt ?? '', SNIPPET_CHARS),
      tags: p.tags,
      visibility: p.visibility,
      author: p.user ? toPublicUser(p.user as PublicUser) : null,
      own: !!viewerId && p.userId === viewerId,
      at: p.publishedAt.toISOString(),
      imageUrl: p.heroImage,
    }));
}

/**
 * Posts carrying a tag, for the search box's `#tag` prefix.
 *
 * No ranking query and no candidate window: a tag is an equality test against
 * an indexed array, so visibility can be part of the one query rather than a
 * filter applied to a ranked shortlist. Newest first, because within a single
 * tag there is no relevance to sort by — every match matches equally.
 *
 * Run through `normalizeTag`, the same normaliser the write path uses, so
 * "#News" finds posts stored as "news" rather than nothing.
 */
export async function searchPostsByTag(
  viewerId: string | undefined,
  raw: string,
  limit: number,
  offset = 0,
): Promise<PostHit[]> {
  const tag = normalizeTag(raw.trim());
  if (!tag) return [];

  const { tiers, notWalled } = await viewerScope(viewerId);
  const posts = await prisma.blogPost.findMany({
    where: { tags: { has: tag }, OR: tiers, ...notWalled },
    // A tag search has no ranking query in front of it, so the visibility rule
    // is part of this one query and the database can do the paging properly:
    // skip and take, not fetch-and-slice. Ordered by id as well so the window
    // is a total order.
    orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    skip: offset,
    take: limit,
    select: {
      id: true, title: true, slug: true, excerpt: true, tags: true, heroImage: true,
      visibility: true, publishedAt: true, userId: true, url: true,
      user: { select: PUBLIC_USER_SELECT },
    },
  });

  return posts.map(p => ({
    kind: 'post' as const,
    id: p.id,
    title: p.title,
    href: p.user ? `/u/${encodeURIComponent(p.user.username)}/${p.slug}` : p.url,
    snippet: clamp(p.excerpt ?? '', SNIPPET_CHARS),
    tags: p.tags,
    visibility: p.visibility,
    author: p.user ? toPublicUser(p.user as PublicUser) : null,
    own: !!viewerId && p.userId === viewerId,
    at: p.publishedAt.toISOString(),
    imageUrl: p.heroImage,
  }));
}

/**
 * Explores matching `raw` that this viewer is allowed to read.
 *
 * Unlike the explored-paths list, a viewer's *own* private threads are in here.
 * That list answers "what has been shared about this article", where showing an
 * unshared thread would misrepresent what other people can see; this answers
 * "where have I been", and a reader's own workspace is the first thing they are
 * looking for. Everyone else's threads are still shared-only, and every card
 * carries its tier.
 *
 * Only titles are matched — see the migration for why the transcript is not in
 * the search vector.
 */
export async function searchExplores(
  viewerId: string | undefined,
  raw: string,
  limit: number,
  offset = 0,
): Promise<ExploreHit[]> {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_QUERY_LEN) return [];
  const tsq = toTsQuery(trimmed);
  if (!tsq) return [];

  const ranked = await prisma.$queryRaw<RankRow[]>`
    SELECT "id", ts_rank("searchVector", to_tsquery('english', ${tsq})) AS "rank"
    FROM "ResearchThread"
    WHERE "searchVector" @@ to_tsquery('english', ${tsq})
    ORDER BY "rank" DESC, "updatedAt" DESC, "id"
    LIMIT ${candidateWindow(offset + limit)}`;
  if (ranked.length === 0) return [];

  const order = new Map(ranked.map((r, i) => [r.id, i]));
  const { tiers, wall } = await viewerScope(viewerId);

  // Not `notWalled`. ResearchThread.userId is nullable — a generated thread
  // belongs to nobody — and `userId NOT IN (…)` is NULL for those rows, which
  // would drop every generated explore for any viewer who has blocked anyone.
  const notWalled = wall.size > 0
    ? { OR: [{ userId: null }, { userId: { notIn: [...wall] } }] }
    : null;

  const threads = await prisma.researchThread.findMany({
    where: {
      AND: [
        { id: { in: ranked.map(r => r.id) } },
        { OR: tiers },
        ...(notWalled ? [notWalled] : []),
      ],
    },
    select: {
      id: true, title: true, sourceTitle: true, visibility: true,
      sharedAt: true, updatedAt: true, userId: true, origin: true,
      user: { select: PUBLIC_USER_SELECT },
      _count: { select: { messages: true } },
      messages: {
        where: { role: 'assistant' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { body: true },
      },
    },
  });

  return threads
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(offset, offset + limit)
    .map(t => ({
      kind: 'explore' as const,
      id: t.id,
      title: t.title,
      // The read-only view. /explore/<id> is the owner's workspace, and a
      // result is a thing to read before it is a thing to continue.
      href: `/e/${encodeURIComponent(t.id)}`,
      snippet: clamp(plainish(t.messages[0]?.body ?? ''), SNIPPET_CHARS),
      sourceTitle: t.sourceTitle,
      visibility: t.visibility,
      author: t.user ? toPublicUser(t.user as PublicUser) : null,
      origin: t.origin === 'auto' ? ('auto' as const) : ('user' as const),
      own: !!viewerId && t.userId === viewerId,
      // Turns, not rows: a question and its answer are one exchange, and "12
      // messages" reads as twice as much conversation as there was.
      turns: Math.max(1, Math.round(t._count.messages / 2)),
      at: (t.sharedAt ?? t.updatedAt)?.toISOString() ?? null,
    }));
}
