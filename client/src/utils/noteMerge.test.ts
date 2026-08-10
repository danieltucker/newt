import { describe, it, expect } from 'vitest';
import { mergeNoteDocs, mergeNoteFolders, mergeNoteOrder } from './noteMerge';
import { NoteDoc } from '../hooks/useSettings';

// The client's copy of the notes merge has to agree with the server's, or the
// console will adopt a reply and then immediately disagree with it - saving
// something different, merging again, and never settling. These are the same
// cases as server/src/lib/noteMerge.test.ts; change one and change both.

const note = (id: string, body: string, updatedAt?: number): NoteDoc =>
  ({ id, title: '', body, updatedAt });

describe('mergeNoteDocs', () => {
  it('keeps the later edit when both sides have the note', () => {
    expect(mergeNoteDocs([note('a', 'theirs', 200)], [note('a', 'ours', 100)])[0].body)
      .toBe('theirs');
  });

  it('keeps the local copy when it is the later one', () => {
    expect(mergeNoteDocs([note('a', 'theirs', 100)], [note('a', 'ours', 200)])[0].body)
      .toBe('ours');
  });

  it('gives a tie to the local copy', () => {
    // This is what lets a merged reply be absorbed mid-sentence: the note being
    // typed was sent at this timestamp and has not been stamped again yet.
    expect(mergeNoteDocs([note('a', 'theirs', 100)], [note('a', 'ours', 100)])[0].body)
      .toBe('ours');
  });

  it('treats a note with no timestamp as the oldest thing there is', () => {
    expect(mergeNoteDocs([note('a', 'stamped', 1)], [note('a', 'unstamped')])[0].body)
      .toBe('stamped');
  });

  it('keeps notes only one side has, in either direction', () => {
    expect(mergeNoteDocs([note('a', 'A', 1)], [note('a', 'A', 1), note('b', 'B', 2)])
      .map(d => d.id)).toEqual(['a', 'b']);
    expect(mergeNoteDocs([note('a', 'A', 1), note('b', 'B', 2)], [note('a', 'A', 1)])
      .map(d => d.id)).toEqual(['a', 'b']);
  });

  it('carries a delete across, because it moves updatedAt with it', () => {
    const merged = mergeNoteDocs(
      [{ ...note('a', 'A', 100) }],
      [{ ...note('a', 'A', 300), deletedAt: 300 }],
    );
    expect(merged[0].deletedAt).toBe(300);
  });

  it('puts the local notes first and appends what they had not seen', () => {
    expect(mergeNoteDocs(
      [note('x', 'X', 1), note('y', 'Y', 1)],
      [note('y', 'Y', 2), note('z', 'Z', 2)],
    ).map(d => d.id)).toEqual(['y', 'z', 'x']);
  });

  it('is a no-op when both sides agree, so adopting twice settles', () => {
    const docs = [note('a', 'A', 1), note('b', 'B', 2)];
    const once = mergeNoteDocs(docs, docs);
    expect(once).toEqual(docs);
    expect(mergeNoteDocs(docs, once)).toEqual(docs);
  });
});

describe('mergeNoteFolders', () => {
  it('takes the local version of a folder both sides have, and drops neither', () => {
    const merged = mergeNoteFolders(
      [{ id: 'f', name: 'Old', color: '#000' }, { id: 'b', name: 'B', color: '#000' }],
      [{ id: 'f', name: 'New', color: '#fff' }],
    );
    expect(merged).toEqual([
      { id: 'f', name: 'New', color: '#fff' },
      { id: 'b', name: 'B', color: '#000' },
    ]);
  });
});

describe('mergeNoteOrder', () => {
  it('keeps the local arrangement and appends what it missed', () => {
    expect(mergeNoteOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('does not duplicate a token present on both sides', () => {
    expect(mergeNoteOrder(['a'], ['a'])).toEqual(['a']);
  });
});
