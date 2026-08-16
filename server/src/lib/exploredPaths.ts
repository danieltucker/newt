import prisma from './prisma';
import logger from './logger';
import { canonicalArticleKey } from './comments';
import { friendIdsOf, toPublicUser, PUBLIC_USER_SELECT, PublicUser } from './friends';
import { blockWallOf } from './blocks';

/**
 * What was done with an article beyond replying to it.
 *
 * The comment thread has always answered "what did people say about this".
 * Two other things happen to an article in this app and neither left a trace on
 * its page: somebody opens an Explore on it and has a long conversation with a
 * model, and somebody writes a post quoting it. Both are more considered than a
 * comment, and both were invisible to everyone but their author.
 *
 * This module answers the question backwards - given an article, what has been
 * shared about it - for both kinds at once.
 *
 * ── Why an explore is private until it is not ──
 * An explore transcript is *not* only the reader's questions and the model's
 * answers. articleContext.ts feeds the model the reader's own comments on the
 * piece - including the `private` tier, which the UI calls a Personal Note -
 * and, when no article text can be found, their reading-list notes. The model
 * quotes that material back routinely. So a thread can contain writing its
 * author never intended anyone to see, and may well have forgotten is in there.
 *
 * Nothing here widens a thread. Sharing is always an explicit act by the owner,
 * against a preview of the whole transcript (see the client's publish dialog).
 */

// The most references one post contributes. A post citing forty articles is
// either a link dump or someone gaming their way onto forty article pages;
// either way the first few are the ones the post is actually about.
const MAX_REFS_PER_POST = 12;

// How many of each kind an article page shows. The section sits above the
// comments and must not push them off the screen.
const MAX_PATHS = 12;

const SNIPPET_CHARS = 240;

/**
 * The article URLs a post body points at.
 *
 * Embeds carry their target in `data-url`, and the server's sanitizer allows
 * that attribute only on spans (see comments.ts) - so a saved body's data-url
 * values *are* its references. Read with a regex rather than a parser because
 * the markup being read is markup we generated and then normalised: sanitize-html
 * re-emits every attribute double-quoted, which is the only property this needs.
 */
export function referencedUrlsIn(html: string): string[] {
  if (!html || !html.includes('data-url')) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/\sdata-url="([^"]*)"/g)) {
    // The attribute is HTML-escaped in storage; only `&` can appear in a URL
    // that has been through that transform and still matter.
    const url = m[1].replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = canonicalArticleKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= MAX_REFS_PER_POST) break;
  }
  return urls;
}

/**
 * Rebuild a post's reference rows from its body.
 *
 * Wholesale rather than incrementally: the body is the source of truth, and an
 * edit that removes a card must remove the row with it or the post stays listed
 * on an article it no longer mentions.
 *
 * Never throws. A post saving correctly matters more than its rows being
 * current, and the boot backfill repairs anything missed.
 */
export async function syncPostReferences(postId: string, body: string): Promise<void> {
  try {
    const urls = referencedUrlsIn(body);
    await prisma.$transaction([
      prisma.postReference.deleteMany({ where: { postId } }),
      ...(urls.length
        ? [prisma.postReference.createMany({
            data: urls.map(url => ({ postId, articleKey: canonicalArticleKey(url), url })),
            skipDuplicates: true,
          })]
        : []),
    ]);
  } catch (err) {
    logger.error({ err, postId }, 'Could not sync post references');
  }
}

export interface ExploredPath {
  kind: 'explore' | 'post';
  id: string;
  title: string;
  /** Where following this goes. */
  href: string;
  /** Plain text, clamped - enough to tell whether it is worth opening. */
  snippet: string;
  /** 'public' | 'friends'. Never 'private': those are not in the list. */
  visibility: string;
  /** The same author shape every other surface sends - see toPublicUser. */
  author: ReturnType<typeof toPublicUser> | null;
  /** Whether the viewer wrote it, so their own can be marked as theirs. */
  own: boolean;
  /** Turns in the conversation. Explores only - null for a post. */
  turns: number | null;
  at: string | null;
}

/** Markdown, roughly de-marked, for a preview line. */
function plainish(markdown: string): string {
  return markdown
    // Fenced code says nothing useful in a one-line preview.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

/**
 * Everything shared about one article that this viewer is allowed to see.
 *
 * The visibility rules are the ones the rest of the app uses, applied here to
 * two tables at once:
 *  - public is public, including to a logged-out reader;
 *  - friends-only shows to accepted friends;
 *  - your own always shows to you, whatever tier it is on - *except* that a
 *    private explore is not "shared" at all and never appears. Seeing your own
 *    unshared thread listed under a heading about what has been shared would
 *    misrepresent what other people can see, which is the one thing this
 *    section must never do.
 *  - anyone on either side of a block is dropped.
 */
export async function exploredPathsFor(url: string, viewerId?: string): Promise<ExploredPath[]> {
  const key = canonicalArticleKey(url);
  if (!key) return [];

  const [friendIds, wall] = await Promise.all([
    viewerId ? friendIdsOf(viewerId) : Promise.resolve(new Set<string>()),
    blockWallOf(viewerId),
  ]);

  // Which tiers this viewer can see, and from whom. Written once and applied to
  // both queries so an explore and a post can never disagree about who may read
  // what.
  const tiers: Record<string, unknown>[] = [{ visibility: 'public' }];
  if (friendIds.size > 0) {
    tiers.push({ visibility: 'friends', userId: { in: [...friendIds] } });
  }
  if (viewerId) tiers.push({ userId: viewerId });

  const notWalled = wall.size > 0 ? { userId: { notIn: [...wall] } } : {};

  const [threads, refs] = await Promise.all([
    prisma.researchThread.findMany({
      where: {
        sourceKey: key,
        // The tier filter admits the viewer's own rows unconditionally, which
        // for threads would include their private ones - so unshared threads
        // are excluded outright before it is applied.
        visibility: { in: ['public', 'friends'] },
        OR: tiers,
        ...notWalled,
      },
      orderBy: [{ sharedAt: 'desc' }, { updatedAt: 'desc' }],
      take: MAX_PATHS,
      select: {
        id: true, title: true, visibility: true, sharedAt: true, userId: true,
        user: { select: PUBLIC_USER_SELECT },
        _count: { select: { messages: true } },
        messages: {
          where: { role: 'assistant' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { body: true },
        },
      },
    }),
    prisma.postReference.findMany({
      where: {
        articleKey: key,
        post: { OR: tiers, ...notWalled },
      },
      orderBy: { post: { publishedAt: 'desc' } },
      take: MAX_PATHS,
      select: {
        id: true,
        post: {
          select: {
            id: true, title: true, slug: true, excerpt: true, visibility: true,
            publishedAt: true, userId: true, url: true,
            user: { select: PUBLIC_USER_SELECT },
          },
        },
      },
    }),
  ]);

  const paths: ExploredPath[] = [];

  for (const t of threads) {
    paths.push({
      kind: 'explore',
      id: t.id,
      title: t.title,
      // The read-only view, not /explore/<id> - that one is the owner's
      // workspace and is signed-in only. See client/src/utils/exploreShareUrl.
      href: `/e/${encodeURIComponent(t.id)}`,
      snippet: clamp(plainish(t.messages[0]?.body ?? ''), SNIPPET_CHARS),
      visibility: t.visibility,
      author: t.user ? toPublicUser(t.user as PublicUser) : null,
      own: !!viewerId && t.userId === viewerId,
      // Turns, not rows: a question and its answer are one exchange, and "12
      // messages" reads as twice as much conversation as there was.
      turns: Math.max(1, Math.round(t._count.messages / 2)),
      at: (t.sharedAt ?? null)?.toISOString() ?? null,
    });
  }

  for (const r of refs) {
    const p = r.post;
    // A post is only "about" the article if it isn't the article. A post that
    // cites itself - which a self-referential embed would produce - would
    // otherwise be listed on its own page.
    if (canonicalArticleKey(p.url) === key) continue;
    paths.push({
      kind: 'post',
      id: p.id,
      title: p.title,
      href: p.user ? `/u/${p.user.username}/${p.slug}` : p.url,
      snippet: clamp(p.excerpt ?? '', SNIPPET_CHARS),
      visibility: p.visibility,
      author: p.user ? toPublicUser(p.user as PublicUser) : null,
      own: !!viewerId && p.userId === viewerId,
      turns: null,
      at: p.publishedAt.toISOString(),
    });
  }

  // Newest first across both kinds - the two lists are one list to a reader.
  paths.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return paths.slice(0, MAX_PATHS);
}

// ── One-time repair of rows written before these columns existed ────────────
//
// Both backfills are here rather than in the SQL migration because both depend
// on TypeScript that already exists and is tested: canonicalArticleKey (which
// strips tracking parameters and normalises the host) and the embed extraction
// above. Reimplementing either in SQL would produce keys that disagree with the
// ones every other table uses, which is a worse outcome than a slower boot.

/** Fill sourceKey on threads that predate the column. */
export async function backfillSourceKeys(): Promise<number> {
  const rows = await prisma.researchThread.findMany({
    where: { sourceKey: '', NOT: { sourceUrl: '' } },
    select: { id: true, sourceUrl: true },
    take: 5000,
  });
  let done = 0;
  for (const r of rows) {
    const key = canonicalArticleKey(r.sourceUrl);
    if (!key) continue;
    await prisma.researchThread.update({ where: { id: r.id }, data: { sourceKey: key } });
    done++;
  }
  return done;
}

/** Extract references from posts written before PostReference existed. */
export async function backfillPostReferences(): Promise<number> {
  // Only posts with no rows yet. A post whose body genuinely has no embeds is
  // re-examined on each boot, which is cheap and self-correcting; the
  // alternative is a marker column that exists solely to remember a negative.
  const posts = await prisma.blogPost.findMany({
    where: { references: { none: {} }, body: { contains: 'data-url' } },
    select: { id: true, body: true },
    take: 5000,
  });
  let done = 0;
  for (const p of posts) {
    const urls = referencedUrlsIn(p.body);
    if (!urls.length) continue;
    await syncPostReferences(p.id, p.body);
    done++;
  }
  return done;
}

/**
 * Run both, once, at boot. Failure is logged and otherwise ignored - a missing
 * backfill costs an incomplete list on some article pages, which is not a
 * reason to refuse to start.
 */
export async function backfillExploredPaths(): Promise<void> {
  try {
    const [keys, refs] = await Promise.all([backfillSourceKeys(), backfillPostReferences()]);
    if (keys || refs) {
      logger.info({ threads: keys, posts: refs }, 'Backfilled explored-path references');
    }
  } catch (err) {
    logger.error({ err }, 'Explored-paths backfill failed');
  }
}
