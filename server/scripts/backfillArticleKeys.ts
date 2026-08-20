/**
 * Fill in ReadingListItem.articleKey for rows written before the column existed.
 *
 *   npx ts-node scripts/backfillArticleKeys.ts          # do it
 *   npx ts-node scripts/backfillArticleKeys.ts --dry    # say what it would do
 *
 * THIS NORMALLY RUNS ITSELF. The server calls the same function at boot
 * (src/index.ts -> lib/archiveBackfill), so a deploy needs nothing done by
 * hand. This script is for running it against a database whose server is not
 * booting, and for a --dry look before committing to anything.
 *
 * Why this is a script and not part of migration 20260820120000: the key comes
 * from canonicalArticleKey(), which strips tracking parameters and normalises
 * the host in JavaScript. SQL cannot reproduce it faithfully, and a wrong key
 * here is not self-correcting the way a wrong FeedItem.linkKey was — feed rows
 * are rewritten on the next poll, reading-list rows are never rewritten at all.
 * A bad key would pin the wrong article in the archive forever.
 *
 * Safe to run more than once, and safe to run late: until it runs, the affected
 * rows simply read as "unknown" to the archive retention sweep, which treats
 * unknown as "keep". Running it can therefore only ever let *more* be collected,
 * never less, so there is no window in which skipping it loses anything.
 */
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { backfillReadingListArticleKeys } from '../src/lib/archiveBackfill';

const dry = process.argv.includes('--dry');

async function main(): Promise<void> {
  const { scanned, written, skipped } = await backfillReadingListArticleKeys({ dry });
  console.log(
    `${dry ? '[dry run] ' : ''}scanned ${scanned}, ` +
    `${dry ? 'would write' : 'wrote'} ${written}, skipped ${skipped}`,
  );
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
