import prisma from './prisma';
import logger from './logger';
import { canonicalArticleKey } from './comments';

// ── One-time repair for the article archive (migration 20260820120000) ───────
//
// Both steps live here rather than in the SQL migration for the reason set out
// at length in that migration and in exploredPaths.ts: they depend on
// TypeScript the migration cannot call, or on an aggregation that has to see
// the whole river. Reimplementing canonicalArticleKey in SQL would produce keys
// that disagree with the ones every other table uses.
//
// Both are safe to run on every boot. The reading-list backfill filters on
// `articleKey: null`, which is indexed and empty once it has run; the archive
// seed is guarded on the archive being empty, which is true exactly once.
//
// scripts/backfillArticleKeys.ts and scripts/seedArchiveFromFeedItems.ts are
// thin wrappers over these two, for running them by hand against a database
// whose server is not booting.

const CHUNK = 500;

export interface BackfillKeysResult { scanned: number; written: number; skipped: number }

/**
 * Fill ReadingListItem.articleKey for rows written before the column existed.
 *
 * Safe to run late: until it runs, the affected rows read as "unknown" to the
 * archive retention sweep, which treats unknown as "keep". Running it can only
 * ever let *more* be collected, never less.
 */
export async function backfillReadingListArticleKeys(
  opts: { dry?: boolean } = {},
): Promise<BackfillKeysResult> {
  const { dry = false } = opts;
  let scanned = 0;
  let written = 0;
  let skipped = 0;

  // No cursor, deliberately. Each pass takes the next chunk of rows that still
  // have no key, and writing the key is what removes them from the filter - so
  // the loop drains the table by construction. A Prisma cursor would have been
  // wrong here for exactly that reason: it anchors on a row from the *filtered*
  // set, and the row we just wrote is no longer in it.
  //
  // Rows we cannot key are the one thing that would loop forever, so they are
  // held aside by id. Expected to be a handful at most - a url that fails to
  // parse at all - so carrying them in memory is fine.
  const unkeyable: string[] = [];
  for (;;) {
    const rows = await prisma.readingListItem.findMany({
      where: { articleKey: null, ...(unkeyable.length ? { id: { notIn: unkeyable } } : {}) },
      select: { id: true, url: true },
      orderBy: { id: 'asc' },
      take: CHUNK,
    });
    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      let key = '';
      try {
        key = canonicalArticleKey(row.url);
      } catch {
        // A url this cannot parse is left null, which keeps that row's article
        // uncollectable rather than mapping it onto a key it does not own.
        key = '';
      }
      if (!key) { unkeyable.push(row.id); skipped++; continue; }
      if (!dry) {
        await prisma.readingListItem.update({ where: { id: row.id }, data: { articleKey: key } });
      }
      written++;
    }

    // A dry run writes nothing, so nothing leaves the filter and the same chunk
    // would come back forever. One pass is all it can honestly report.
    if (dry) break;
  }

  return { scanned, written, skipped };
}

export interface SeedArchiveResult {
  skipped: boolean;
  feeds: number;
  articles: number;
  links: number;
}

/**
 * Seed ArticleArchive from the feed items already in the river.
 *
 * The archive is written on ingest, so it fills itself from the moment the
 * archive ships - but only going forward. Whatever is in "FeedItem" at that
 * point is a fortnight or so of history that would otherwise expire unrecorded,
 * and this is the one chance to keep it.
 *
 * Guarded on the archive being empty, which makes it a true one-shot: on the
 * first boot after the upgrade it runs, and on every boot after that the
 * archive is non-empty and it does nothing. The guard is read at boot, ~15s
 * before the feed scheduler's first sweep (feedScheduler.ts), so live ingest
 * cannot close the window before the check happens. Pass `force` to seed anyway
 * - the only case that needs it is an instance that began ingesting into the
 * archive before this ever ran, where the guard would skip a window that is
 * still partly recoverable.
 */
export async function seedArchiveFromFeedItems(
  opts: { dry?: boolean; force?: boolean } = {},
): Promise<SeedArchiveResult> {
  const { dry = false, force = false } = opts;

  const feeds = await prisma.feed.findMany({ select: { id: true } });
  if (feeds.length === 0) return { skipped: true, feeds: 0, articles: 0, links: 0 };

  const already = await prisma.articleArchive.count();
  if (already > 0 && !force && !dry) {
    return { skipped: true, feeds: feeds.length, articles: already, links: 0 };
  }

  if (dry) {
    const items = await prisma.feedItem.count();
    const distinct = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "linkKey") AS count FROM "FeedItem"`;
    logger.info(
      `[dry run] ${feeds.length} feeds, ${items} feed items, ` +
      `${Number(distinct[0]?.count ?? 0)} distinct articles; archive currently holds ${already}.`,
    );
    return { skipped: false, feeds: feeds.length, articles: already, links: 0 };
  }

  for (const feed of feeds) {
    // One archive row per article. The window functions run before DISTINCT ON,
    // so min/max see every copy of the article in this feed while DISTINCT ON
    // keeps a single row - the newest, matching how the river picks which copy
    // of a story to show.
    await prisma.$executeRaw`
      INSERT INTO "ArticleArchive" (
        "articleKey", "link", "linkHost", "title", "snippet", "content",
        "imageUrl", "readTime", "categories", "pubDate", "firstSeenAt", "lastSeenAt"
      )
      SELECT DISTINCT ON (i."linkKey")
        i."linkKey", i."link", i."linkHost", i."title", i."snippet", i."content",
        i."imageUrl", i."readTime", i."categories", i."pubDate",
        MIN(i."firstSeenAt") OVER (PARTITION BY i."linkKey"),
        MAX(i."fetchedAt")   OVER (PARTITION BY i."linkKey")
      FROM "FeedItem" i
      WHERE i."feedId" = ${feed.id}
      ORDER BY i."linkKey", i."pubDate" DESC NULLS LAST, i."firstSeenAt" DESC
      ON CONFLICT ("articleKey") DO UPDATE SET
        -- Widen the window from both ends. A second feed's copy of the same
        -- article may have been seen earlier, or more recently, than the first.
        "firstSeenAt" = LEAST("ArticleArchive"."firstSeenAt", EXCLUDED."firstSeenAt"),
        "lastSeenAt"  = GREATEST("ArticleArchive"."lastSeenAt", EXCLUDED."lastSeenAt"),
        -- Fill gaps, never clobber. By the time this runs the archive may
        -- already hold a better copy written by live ingest, and a backfill
        -- must not overwrite it with an older, thinner one.
        "snippet"  = COALESCE("ArticleArchive"."snippet",  EXCLUDED."snippet"),
        "content"  = COALESCE("ArticleArchive"."content",  EXCLUDED."content"),
        "imageUrl" = COALESCE("ArticleArchive"."imageUrl", EXCLUDED."imageUrl"),
        "readTime" = COALESCE("ArticleArchive"."readTime", EXCLUDED."readTime"),
        "pubDate"  = COALESCE("ArticleArchive"."pubDate",  EXCLUDED."pubDate"),
        "linkHost" = COALESCE("ArticleArchive"."linkHost", EXCLUDED."linkHost")
    `;

    // Which feed carried it. After the insert above, because the foreign key
    // points at a row that has to exist first.
    await prisma.$executeRaw`
      INSERT INTO "ArticleArchiveFeed" ("articleKey", "feedId")
      SELECT DISTINCT i."linkKey", i."feedId"
      FROM "FeedItem" i
      WHERE i."feedId" = ${feed.id}
      ON CONFLICT DO NOTHING
    `;
  }

  const [articles, links] = await Promise.all([
    prisma.articleArchive.count(),
    prisma.articleArchiveFeed.count(),
  ]);
  return { skipped: false, feeds: feeds.length, articles, links };
}

/**
 * Run both, once, at boot. Failure is logged and otherwise ignored - the app is
 * fully functional without either. An unfilled articleKey reads as "unknown" to
 * the retention sweep, which keeps the row; an unseeded archive just means
 * search and Explore reach back only as far as live ingest has recorded.
 * Neither is a reason to refuse to start.
 */
export async function backfillArticleArchive(): Promise<void> {
  try {
    const keys = await backfillReadingListArticleKeys();
    if (keys.written || keys.skipped) {
      logger.info(
        { scanned: keys.scanned, written: keys.written, unkeyable: keys.skipped },
        'Backfilled reading-list article keys',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Reading-list articleKey backfill failed');
  }

  try {
    const seed = await seedArchiveFromFeedItems();
    if (!seed.skipped) {
      logger.info(
        { feeds: seed.feeds, articles: seed.articles, links: seed.links },
        'Seeded article archive from existing feed items',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Article-archive seed failed');
  }
}
