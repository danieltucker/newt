import { BlogPostSummary } from '../types';
import { EmbedData, postEmbed } from './noteEmbed';

/**
 * Your own posts, as things /reference can cite.
 *
 * The picker's other half is the reading list - what you have read - and this
 * is what you have written. Both are yours, both are addressable, and citing
 * one of your own posts had until now meant leaving the editor to go and copy
 * its URL out of the address bar.
 *
 * `excludeId` drops the post being written from its own picker: a card that
 * links to the page it is sitting on is a loop, not a reference.
 *
 * A draft says so where the date would go. It is a real thing to cite from a
 * note, which is private - but a post is not, and a card pointing at an
 * unpublished draft is a dead link for everybody but its author. Better said in
 * the picker than discovered by a reader.
 */
export function postReferences(posts: BlogPostSummary[], excludeId?: string): EmbedData[] {
  return posts
    .filter(p => p.id !== excludeId)
    .map(p => {
      const data = postEmbed(p);
      return p.visibility === 'private' ? { ...data, meta: 'Draft' } : data;
    });
}
