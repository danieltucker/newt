import { describe, it, expect } from 'vitest';
import { mergeNoteDocs, mergeNoteFolders, mergeNoteOrder } from './noteMerge';

// These three decide what happens when two devices have both been writing
// notes, and the failure they exist to prevent is silent data loss - a tab left
// open on another machine posting yesterday's notes over today's. So the cases
// worth pinning are the ones where a version has to be *chosen*, and the ones
// where neither may be dropped.
//
// client/src/utils/noteMerge.test.ts runs the same cases against the client's
// copy. If one of these changes, that one has to change with it.

const note = (id: string, body: string, updatedAt?: number) => ({ id, body, updatedAt });

describe('mergeNoteDocs', () => {
  it('keeps the later edit when both sides have the note', () => {
    const base = [note('a', 'from the other device', 200)];
    const incoming = [note('a', 'from this one', 100)];
    expect(mergeNoteDocs(base, incoming)).toEqual([note('a', 'from the other device', 200)]);
  });

  it('keeps the writer\'s copy when it is the later one', () => {
    const base = [note('a', 'old', 100)];
    const incoming = [note('a', 'new', 200)];
    expect(mergeNoteDocs(base, incoming)).toEqual([note('a', 'new', 200)]);
  });

  it('gives a tie to the writer', () => {
    // Same timestamp means the writer is sending back what it was given, plus
    // whatever it has done since - and it is the one with a person at it.
    const base = [note('a', 'stored', 100)];
    const incoming = [note('a', 'sent', 100)];
    expect(mergeNoteDocs(base, incoming)[0].body).toBe('sent');
  });

  it('treats a note with no timestamp as the oldest thing there is', () => {
    const base = [note('a', 'stamped', 1)];
    const incoming = [note('a', 'unstamped', undefined)];
    expect(mergeNoteDocs(base, incoming)[0].body).toBe('stamped');
  });

  it('keeps notes only the writer has - they are new', () => {
    const merged = mergeNoteDocs([note('a', 'A', 1)], [note('a', 'A', 1), note('b', 'B', 2)]);
    expect(merged.map(d => d.id)).toEqual(['a', 'b']);
  });

  it('keeps notes only the server has - the writer never saw them', () => {
    // This is the whole point: a note written on another device after this tab
    // loaded is absent from everything that tab sends, and must survive it.
    const merged = mergeNoteDocs([note('a', 'A', 1), note('b', 'B', 2)], [note('a', 'A', 1)]);
    expect(merged.map(d => d.id)).toEqual(['a', 'b']);
    expect(merged.find(d => d.id === 'b')!.body).toBe('B');
  });

  it('carries a delete across, because it moves updatedAt with it', () => {
    const base = [{ id: 'a', body: 'A', updatedAt: 100 }];
    const incoming = [{ id: 'a', body: 'A', updatedAt: 300, deletedAt: 300 }];
    expect(mergeNoteDocs(base, incoming)[0]).toHaveProperty('deletedAt', 300);
  });

  it('puts the writer\'s notes first and appends what it had not seen', () => {
    const base = [note('x', 'X', 1), note('y', 'Y', 1)];
    const incoming = [note('y', 'Y', 2), note('z', 'Z', 2)];
    expect(mergeNoteDocs(base, incoming).map(d => d.id)).toEqual(['y', 'z', 'x']);
  });

  it('is a no-op when both sides agree', () => {
    const docs = [note('a', 'A', 1), note('b', 'B', 2)];
    expect(mergeNoteDocs(docs, docs)).toEqual(docs);
  });

  it('survives an empty side either way', () => {
    expect(mergeNoteDocs([], [note('a', 'A', 1)]).map(d => d.id)).toEqual(['a']);
    expect(mergeNoteDocs([note('a', 'A', 1)], []).map(d => d.id)).toEqual(['a']);
  });
});

describe('mergeNoteFolders', () => {
  it('takes the writer\'s version of a folder both sides have', () => {
    const merged = mergeNoteFolders(
      [{ id: 'f', name: 'Old', color: '#000' }],
      [{ id: 'f', name: 'New', color: '#fff' }],
    );
    expect(merged).toEqual([{ id: 'f', name: 'New', color: '#fff' }]);
  });

  it('keeps folders either side has on its own', () => {
    const merged = mergeNoteFolders(
      [{ id: 'a', name: 'A', color: '#000' }, { id: 'b', name: 'B', color: '#000' }],
      [{ id: 'a', name: 'A', color: '#000' }, { id: 'c', name: 'C', color: '#000' }],
    );
    expect(merged.map(f => f.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('mergeNoteOrder', () => {
  it('keeps the writer\'s arrangement and appends what it missed', () => {
    expect(mergeNoteOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('does not duplicate a token present on both sides', () => {
    expect(mergeNoteOrder(['a'], ['a'])).toEqual(['a']);
  });
});
