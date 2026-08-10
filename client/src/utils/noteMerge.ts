import { NoteDoc, NoteFolder } from '../hooks/useSettings';

/**
 * The client half of the notes merge. Mirrors server/src/lib/noteMerge.ts,
 * which is where the reasoning is written down - read that first.
 *
 * The console needs its own copy for two moments:
 *
 *  1. A save comes back with `notesMerged`, meaning the server reconciled it
 *     against something this tab hadn't seen. The reply has to be taken on
 *     board, or the next save posts the same stale array again and the merge
 *     happens forever.
 *  2. The console is reopened in a tab that has been sitting there, and the
 *     settings have been refetched underneath it.
 *
 * In both cases there may be text on screen that is newer than either version -
 * the editor writes into a ref and saves on a 700ms debounce, so the note being
 * typed is routinely ahead of the last thing sent. Running the same merge, with
 * the local copy as the winner of ties, is what lets the reply be absorbed
 * without taking a sentence out from under the cursor.
 */

/** Later `updatedAt` wins; a tie goes to `incoming`. */
export function mergeNoteDocs(base: NoteDoc[], incoming: NoteDoc[]): NoteDoc[] {
  const baseById = new Map(base.map(d => [d.id, d]));
  const out: NoteDoc[] = [];
  const taken = new Set<string>();

  for (const doc of incoming) {
    if (taken.has(doc.id)) continue;
    taken.add(doc.id);
    const other = baseById.get(doc.id);
    out.push(other && (other.updatedAt ?? 0) > (doc.updatedAt ?? 0) ? other : doc);
  }
  for (const doc of base) {
    if (taken.has(doc.id)) continue;
    taken.add(doc.id);
    out.push(doc);
  }
  return out;
}

/** No timestamps to compare, so `incoming` wins; nothing is dropped. */
export function mergeNoteFolders(base: NoteFolder[], incoming: NoteFolder[]): NoteFolder[] {
  const seen = new Set(incoming.map(f => f.id));
  return [...incoming, ...base.filter(f => !seen.has(f.id))];
}

/** `incoming`'s arrangement, with anything it didn't know about appended. */
export function mergeNoteOrder(base: string[], incoming: string[]): string[] {
  const seen = new Set(incoming);
  return [...incoming, ...base.filter(t => !seen.has(t))];
}
