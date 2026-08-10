import { normalizeTags } from './blog';
import { indexableAuthorWhere } from './trust';

// Public tag pages: every author's posts under one word.
//
// Tags already existed as a per-author filter — clicking #editors on a post
// showed that author's other posts about editors. This makes the same word a
// place, which is the difference between a label and a topic.
//
// Worth being explicit about what a tag page is *not*, because the obvious
// extension is a trap: it never includes ingested RSS items. FeedItem.categories
// is whatever a publisher's <category> element happened to say about an article
// Newt fetched, and a public page listing other people's headlines by topic is
// the textbook scraped-aggregator page — devalued by search engines, and a
// republication of content that isn't ours. It would also expose the union of
// every user's subscriptions, since FeedItem rows are shared and only the river
// is scoped per-subscriber. A tag page is authors' own writing, under a word
// those authors chose.

/** Posts per page. Same shape as the author archive, for the same reasons. */
export const TAG_PAGE_SIZE = 50;

/**
 * How many posts a tag needs before the page asks to be indexed.
 *
 * A tag with one post is a thin page, and a domain covered in thin pages is how
 * a crawler learns to spend less of its budget here — which costs the good pages
 * too. The page still renders and still works at any size; below the floor it
 * simply declines the index entry.
 */
export const MIN_TAG_POSTS_TO_INDEX = 3;

/**
 * A tag out of a URL segment, or null if it is not one.
 *
 * Run through the same normaliser the write path uses, so a link carrying
 * "#News" or "NEWS" finds the posts stored as "news" instead of nothing.
 */
export function normalizeTag(raw: string): string | null {
  return normalizeTags([raw])?.[0] ?? null;
}

/**
 * Which posts a tag page shows.
 *
 * The author filter is the trust ladder's, the same one the sitemap uses. A tag
 * page is browsable and linked from every post carrying the word, so an
 * hour-old account should not be able to put itself on one — but note this is a
 * weaker gate than the global recent page's, deliberately. A tag page is
 * self-selecting (someone has to go looking for that word) rather than a
 * firehose, and the alternative is worse: if tag pages were restricted further
 * than the posts that link to them, a post would show a #tag whose page did not
 * contain it.
 */
export function tagPostsWhere(tag: string, now?: Date) {
  return {
    visibility: 'public',
    tags: { has: tag },
    user: indexableAuthorWhere(now),
  };
}
