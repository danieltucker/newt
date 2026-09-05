import { ReadingFolder } from '../types';
import type { SaveDestination } from '../components/SaveButton';

/**
 * Where Save can put an article.
 *
 * The reading list leads and is what the label alone does; a Library shelf
 * below it is for the pieces you already know you're keeping rather than
 * queueing.
 *
 * This lived in FeedPanel, whose own comment said it was "shared by the card
 * and the reader so the two can't drift apart about what Save means". The
 * search results are a third surface offering the same button, so the table
 * moved out here rather than being copied a second time — a Save menu that
 * offers different destinations depending on which list you found the article
 * in is the exact drift that comment was written against.
 */

/** Not a folder id, so it can't collide with one. */
export const READING_LIST_DEST = 'reading-list';

export function destinationsFor(folders: ReadingFolder[]): SaveDestination[] {
  return [
    { id: READING_LIST_DEST, label: 'Reading list', hint: 'Default' },
    { id: '', label: 'Unsorted', group: 'Saved articles' },
    ...folders.map(f => ({ id: f.id, label: f.name, group: 'Saved articles' })),
  ];
}
