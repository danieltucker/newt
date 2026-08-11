import prisma from '../prisma';
import logger from '../logger';
import { fetchArticleText } from './articleFetch';

/**
 * The article's own text, fetched at most once per page per few weeks.
 *
 * The cache is what makes reading the page affordable at all. A thread replays
 * its opening turn on every follow-up, so without this a five-question
 * conversation would fetch the same article five times — and every reader who
 * asked about a popular article would fetch it again for themselves.
 */

/** A page that read fine is not going to change under us. */
const FRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A page that yielded nothing is retried far sooner. Most misses are temporary
 * in a way a success never is — a 503, a consent interstitial, a paywall that
 * lifts — so a month of remembering "unreadable" would outlast the reason.
 */
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;

/** In-flight fetches, so two turns arriving together read the page once. */
const inFlight = new Map<string, Promise<string>>();

function isFresh(row: { text: string; fetchedAt: Date }): boolean {
  const age = Date.now() - row.fetchedAt.getTime();
  return age < (row.text ? FRESH_TTL_MS : FAILED_TTL_MS);
}

/**
 * The text of the article at `url`, from the cache or from the web.
 *
 * Returns '' when the page could not be read, which is a normal outcome and not
 * an error: the caller still has whatever the feed published. Every failure
 * path — a dead site, a database that will not write, a page of pure video —
 * ends here rather than propagating, because none of them should be able to
 * stop a reader asking a question.
 */
export async function articleTextFor(url: string, articleKey: string): Promise<string> {
  const pending = inFlight.get(articleKey);
  if (pending) return pending;

  try {
    const cached = await prisma.articleText.findUnique({ where: { articleKey } });
    if (cached && isFresh(cached)) return cached.text;
  } catch (err) {
    // A cache that cannot be read is not a reason to skip the article; it is a
    // reason to pay for the fetch.
    logger.warn(err, 'ArticleText read failed');
  }

  const work = (async () => {
    const text = await fetchArticleText(url);
    try {
      await prisma.articleText.upsert({
        where: { articleKey },
        create: { articleKey, url, text },
        update: { url, text, fetchedAt: new Date() },
      });
    } catch (err) {
      logger.warn(err, 'ArticleText write failed');
    }
    return text;
  })();

  inFlight.set(articleKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(articleKey);
  }
}
