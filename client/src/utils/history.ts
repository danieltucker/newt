// A small undo/redo stack for the notes editor. contentEditable's native undo
// only tracks typing and execCommand - the editor's own DOM edits (Tab-indent,
// list repair, to-do splits, table ops) bypass it, so those changes couldn't be
// undone. This stack is driven explicitly instead: callers record the *pre-edit*
// snapshot before every change, and undo/redo swap snapshots in and out.
//
// Snapshots are opaque (T) - the editor uses { html, caret }. `record` decides
// whether a change extends the current undo group or starts a new one:
//   - 'struct' (a discrete command like indent or a to-do split) is always its
//     own group, and forces the next typing to start fresh.
//   - 'type' (a keystroke) coalesces with recent typing so a word isn't undone
//     one character at a time - matching the native behaviour it replaces.

export type EditKind = 'type' | 'struct';

export class HistoryStack<T> {
  private undo: T[] = [];
  private redo: T[] = [];
  private lastTime = -Infinity;
  private boundary = true;   // next 'type' starts a new group

  constructor(
    private coalesceMs = 400,
    private echoMs = 50,      // a struct's execCommand echoes a 'type' - ignore it
    private limit = 200,
  ) {}

  // Record the snapshot taken *before* the change is applied. Returns whether it
  // was pushed as a new undo entry (false = coalesced/ignored).
  record(snapshot: T, kind: EditKind, now: number = Date.now()): boolean {
    if (kind === 'type') {
      // A command's execCommand fires an input event right after we already
      // recorded the command - swallow that echo.
      if (now - this.lastTime < this.echoMs) { this.lastTime = now; return false; }
      // Extend the current typing group rather than starting a new one.
      if (!this.boundary && now - this.lastTime < this.coalesceMs) { this.lastTime = now; return false; }
    }
    this.undo.push(snapshot);
    if (this.undo.length > this.limit) this.undo.shift();
    this.redo = [];
    this.lastTime = now;
    this.boundary = kind === 'struct';
    return true;
  }

  canUndo(): boolean { return this.undo.length > 0; }
  canRedo(): boolean { return this.redo.length > 0; }

  // Given the current snapshot, return the one to restore (or null if none),
  // moving the current state onto the opposite stack.
  undoTo(current: T): T | null {
    if (!this.undo.length) return null;
    this.redo.push(current);
    this.boundary = true;
    return this.undo.pop()!;
  }

  redoTo(current: T): T | null {
    if (!this.redo.length) return null;
    this.undo.push(current);
    this.boundary = true;
    return this.redo.pop()!;
  }
}
