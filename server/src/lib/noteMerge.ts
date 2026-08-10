/**
 * Reconciling two versions of the notes tree.
 *
 * Notes live in the settings JSON blob and are written whole: the console sends
 * the entire `noteDocs` array every time it saves. That is fine for one tab and
 * silently destructive for two. A tab left open on another machine holds the
 * notes as they were when that page loaded; the moment anything is typed in it
 * the debounced save posts that whole stale array, and every note written
 * elsewhere since is gone. Nothing about the request looks wrong - it is a
 * complete, well-formed set of notes that happens to be from yesterday.
 *
 * So a notes write now carries the revision it was based on (`notesRev`). When
 * that matches what is stored, the writer had seen everything and the array is
 * taken as sent. When it doesn't - or when it isn't sent at all, which is what
 * a tab running older code looks like - the two versions are merged instead.
 *
 * The merge is deliberately biased towards keeping things:
 *
 *  - A note in both is resolved by `updatedAt`, the later one winning. That is
 *    the only field either side has that says anything about when the text was
 *    written, and the client stamps it on every edit.
 *  - A note only the writer has is new work. Kept.
 *  - A note only the server has is work the writer never saw, because it was
 *    written after that page loaded. Kept.
 *
 * The last rule is what costs something: a *permanent* delete (Recently Deleted
 * → Delete for good) from a stale tab is indistinguishable from a note that tab
 * has never heard of, so the note comes back. That is the right way round. An
 * unwanted note that reappears is a nuisance; a wanted one that vanishes is not
 * recoverable. Ordinary deletes are unaffected - those are a `deletedAt` stamp
 * on a note that is still in the array, so they merge like any other edit.
 *
 * A near-copy of this lives in client/src/utils/noteMerge.ts, which the console
 * uses to absorb a merged reply without discarding what is still being typed.
 * The two must agree; both are unit-tested against the same cases.
 */

export interface MergeableNote {
  id: string;
  updatedAt?: number;
}

export interface MergeableFolder {
  id: string;
}

/** Later `updatedAt` wins; a tie goes to `incoming`, which is the newer write. */
export function mergeNoteDocs<T extends MergeableNote>(base: T[], incoming: T[]): T[] {
  const baseById = new Map(base.map(d => [d.id, d]));
  const out: T[] = [];
  const taken = new Set<string>();

  for (const doc of incoming) {
    if (taken.has(doc.id)) continue;
    taken.add(doc.id);
    const other = baseById.get(doc.id);
    out.push(other && (other.updatedAt ?? 0) > (doc.updatedAt ?? 0) ? other : doc);
  }
  // Whatever the writer never saw, in the order the server had it.
  for (const doc of base) {
    if (taken.has(doc.id)) continue;
    taken.add(doc.id);
    out.push(doc);
  }
  return out;
}

/**
 * Folders carry no timestamp - they are a name, a colour and a collapsed flag,
 * and there is nothing in them to compare. The writer's version wins for a
 * folder both sides have, and neither side's folders are dropped.
 */
export function mergeNoteFolders<T extends MergeableFolder>(base: T[], incoming: T[]): T[] {
  const seen = new Set(incoming.map(f => f.id));
  return [...incoming, ...base.filter(f => !seen.has(f.id))];
}

/**
 * Tree order. The writer's arrangement is kept as-is and anything it didn't
 * know about is appended; the console reconciles the result against what
 * actually exists when it next draws the tree (see utils/noteTree).
 */
export function mergeNoteOrder(base: string[], incoming: string[]): string[] {
  const seen = new Set(incoming);
  return [...incoming, ...base.filter(t => !seen.has(t))];
}
