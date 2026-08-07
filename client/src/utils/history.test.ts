import { describe, it, expect } from 'vitest';
import { HistoryStack } from './history';

// coalesceMs=400, echoMs=50 (defaults). Times passed explicitly for determinism.
const mk = () => new HistoryStack<string>();

describe('HistoryStack - recording', () => {
  it('coalesces rapid typing into one undo group', () => {
    const h = mk();
    expect(h.record('', 'type', 0)).toBe(true);        // first keystroke: pushes pre-state
    expect(h.record('a', 'type', 100)).toBe(false);    // within window: coalesced
    expect(h.record('ab', 'type', 200)).toBe(false);
    // one undo group
    expect(h.undoTo('abc')).toBe('');
    expect(h.canUndo()).toBe(false);
  });

  it('starts a new group after the coalesce window lapses', () => {
    const h = mk();
    h.record('', 'type', 0);
    h.record('foo', 'type', 1000);   // >400ms later: a new group
    expect(h.undoTo('foo bar')).toBe('foo');
    expect(h.undoTo('foo')).toBe('');
  });

  it('makes each structural edit its own undo step', () => {
    const h = mk();
    h.record('a', 'struct', 0);
    h.record('b', 'struct', 10);     // struct never coalesces, even back-to-back
    expect(h.undoTo('c')).toBe('b');
    expect(h.undoTo('b')).toBe('a');
  });

  it('isolates a structural edit from surrounding typing', () => {
    const h = mk();
    h.record('s0', 'type', 0);       // typing group
    h.record('s1', 'type', 100);     // coalesced
    h.record('s2', 'struct', 150);   // tab/indent - its own step, forces a boundary
    h.record('s3', 'type', 160);     // next typing must start fresh, not merge back
    // s3 within 50ms of the struct is treated as its execCommand echo → ignored,
    // so the typing group that follows is captured on the next keystroke.
    h.record('s3', 'type', 400);
    expect(h.undoTo('cur')).toBe('s3');   // undo the typing after the tab
    expect(h.undoTo('s3')).toBe('s2');    // undo the tab itself
    expect(h.undoTo('s2')).toBe('s0');    // undo the original typing
  });

  it('ignores the execCommand echo right after a structural edit', () => {
    const h = mk();
    h.record('pre', 'struct', 0);
    // A command's execCommand fires an input event ~immediately → a 'type' record
    // within echoMs must not create a duplicate entry.
    expect(h.record('pre', 'type', 20)).toBe(false);
    expect(h.undoTo('post')).toBe('pre');
    expect(h.canUndo()).toBe(false);
  });
});

describe('HistoryStack - undo/redo', () => {
  it('round-trips undo then redo', () => {
    const h = mk();
    h.record('v0', 'struct', 0);
    // present is now v1
    expect(h.undoTo('v1')).toBe('v0');
    expect(h.canRedo()).toBe(true);
    expect(h.redoTo('v0')).toBe('v1');
    expect(h.canRedo()).toBe(false);
  });

  it('a new edit after undo clears the redo stack', () => {
    const h = mk();
    h.record('v0', 'struct', 0);
    h.undoTo('v1');
    expect(h.canRedo()).toBe(true);
    h.record('v0b', 'struct', 500);   // diverge
    expect(h.canRedo()).toBe(false);
  });

  it('returns null when there is nothing to undo or redo', () => {
    const h = mk();
    expect(h.undoTo('x')).toBeNull();
    expect(h.redoTo('x')).toBeNull();
  });

  it('caps the undo stack at the configured limit', () => {
    const h = new HistoryStack<number>(400, 50, 3);
    for (let i = 0; i < 5; i++) h.record(i, 'struct', i * 1000);
    // Only the last 3 survive (0 and 1 dropped).
    expect(h.undoTo(99)).toBe(4);
    expect(h.undoTo(4)).toBe(3);
    expect(h.undoTo(3)).toBe(2);
    expect(h.undoTo(2)).toBeNull();
  });
});

describe('HistoryStack - lazy snapshots', () => {
  it('does not build a snapshot for a record that coalesces away', () => {
    const h = mk();
    let built = 0;
    const snap = (v: string) => () => { built++; return v; };
    h.record(snap('a'), 'type', 0);      // starts the group - has to capture
    expect(built).toBe(1);
    h.record(snap('b'), 'type', 100);    // coalesced - nothing to capture
    h.record(snap('c'), 'type', 200);
    expect(built).toBe(1);
    expect(h.undoTo('d')).toBe('a');
  });

  it('does not build a snapshot for the echo after a structural edit', () => {
    const h = mk();
    let built = 0;
    h.record('pre', 'struct', 0);
    h.record(() => { built++; return 'echo'; }, 'type', 20);
    expect(built).toBe(0);
  });

  it('captures at record time, not at undo time', () => {
    const h = mk();
    let live = 'before';
    h.record(() => live, 'struct', 0);
    live = 'after';
    expect(h.undoTo('cur')).toBe('before');
  });
});

describe('HistoryStack - memory budget', () => {
  const sizeOf = (s: string) => s.length;

  it('drops the oldest entries to stay inside the budget', () => {
    // Budget of 25 characters, entries of 10 - so three of them do not fit.
    const h = new HistoryStack<string>(400, 50, 100, sizeOf, 25);
    h.record('a'.repeat(10), 'struct', 0);
    h.record('b'.repeat(10), 'struct', 1000);
    h.record('c'.repeat(10), 'struct', 2000);
    expect(h.undoTo('cur')).toBe('c'.repeat(10));
    expect(h.undoTo('x')).toBe('b'.repeat(10));
    expect(h.undoTo('x')).toBeNull();     // the 'a' entry was trimmed
  });

  it('keeps one entry however far over budget it is', () => {
    const h = new HistoryStack<string>(400, 50, 100, sizeOf, 10);
    const huge = 'x'.repeat(5000);
    h.record(huge, 'struct', 0);
    expect(h.undoTo('cur')).toBe(huge);
  });

  it('leaves the stack alone when no sizeOf is supplied', () => {
    const h = new HistoryStack<string>(400, 50, 100);
    for (let i = 0; i < 4; i++) h.record('y'.repeat(1_000_000), 'struct', i * 1000);
    expect(h.canUndo()).toBe(true);
    for (let i = 0; i < 4; i++) h.undoTo('cur');
    expect(h.canUndo()).toBe(false);
  });
});
