/**
 * Seed ArticleArchive from the feed items already in the river.
 *
 *   npx ts-node scripts/seedArchiveFromFeedItems.ts          # do it
 *   npx ts-node scripts/seedArchiveFromFeedItems.ts --dry    # counts only, no writes
 *   npx ts-node scripts/seedArchiveFromFeedItems.ts --force  # seed even if non-empty
 *
 * THIS NORMALLY RUNS ITSELF. The server calls the same function at boot
 * (src/index.ts -> lib/archiveBackfill) and it is guarded on the archive being
 * empty, so the first boot after the upgrade seeds it and later boots do
 * nothing. A deploy needs nothing done by hand.
 *
 * Reach for --force in the one case the guard gets wrong: an instance that had
 * already started ingesting into the archive before the seed ever ran, where a
 * non-empty archive hides a window of FeedItem history that is still there.
 * Forcing is safe — see the conflict clause below — it is just not automatic.
 *
 * Done in SQL rather than by reading rows into Node and upserting them. A river
 * holds tens of thousands of rows on a well-subscribed instance, and this is
 * fundamentally a set operation: one archive row per linkKey, with the earliest
 * sighting and the latest across every copy. Two statements per feed beat a
 * round trip per article by orders of magnitude, and get the aggregation right
 * for free.
 *
 * No canonicalisation happens here, which is what makes it safe: FeedItem
 * already stores linkKey, computed by canonicalArticleKey on the way in, and
 * that is exactly the key the archive uses. Contrast scripts/backfillArticleKeys,
 * which has to compute keys in JS precisely because the reading list never
 * stored one.
 *
 * Safe to run more than once, and safe to run after the archive has started
 * filling itself. Existing rows are never overwritten with older data - the
 * conflict clause widens the sighting window and fills blank columns, and will
 * not replace a populated title, snippet or body with whatever the river
 * happens to hold. Re-running it cannot make the archive worse.
 */
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { seedArchiveFromFeedItems } from '../src/lib/archiveBackfill';

const dry = process.argv.includes('--dry');
const force = process.argv.includes('--force');

async function main(): Promise<void> {
  const res = await seedArchiveFromFeedItems({ dry, force });

  if (res.skipped) {
    if (res.feeds === 0) { console.log('No feeds; nothing to seed.'); return; }
    console.log(
      `Archive already holds ${res.articles} articles; skipping. ` +
      'Re-run with --force to seed from FeedItem anyway.',
    );
    return;
  }
  if (dry) return;   // the dry-run counts are logged by the lib

  console.log(
    `Seeded from ${res.feeds} feeds. ` +
    `Archive now holds ${res.articles} articles across ${res.links} feed links.`,
  );
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
