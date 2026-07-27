import { describe, it, expect } from 'vitest';
import { buildRows, computeDrop, reconcileFlat, INDENT } from './noteTree';
import { NoteDoc, NoteFolder } from '../hooks/useSettings';

// Minimal note/folder factories
const note = (id: string, folderId?: string): NoteDoc => ({ id, title: id, body: '', folderId });
const folder = (id: string): NoteFolder => ({ id, name: id, color: '#000' });

// Resolve a drop the way the component does: build the visible rows (hiding the
// dragged folder's own children, as it moves as a block), then computeDrop.
function drop(
  flat: string[], notes: NoteDoc[], folderIds: string[], dragId: string, overId: string,
  offsetLeft = 0, open: string[] = folderIds,
) {
  const folderSet = new Set(folderIds);
  const notesById = new Map(notes.map(n => [n.id, n]));
  const openFolders = new Set(open);
  const hideChildrenOf = dragId.startsWith('folder:') ? dragId.slice('folder:'.length) : undefined;
  const rows = buildRows(flat, folderSet, notesById, openFolders, hideChildrenOf);
  return computeDrop(flat, rows, notesById, folderSet, dragId, overId, offsetLeft);
}

describe('computeDrop - the reported cases', () => {
  it('drags a note above all folders', () => {
    const r = drop(['folder:F1', 'n1', 'l1'], [note('n1', 'F1'), note('l1')], ['F1'], 'l1', 'folder:F1', 0);
    expect(r?.flat).toEqual(['l1', 'folder:F1', 'n1']);
    expect(r?.newFolderId).toBeUndefined();
  });

  it('drags a folder below the notes', () => {
    const r = drop(
      ['folder:F1', 'n1', 'l1', 'l2'], [note('n1', 'F1'), note('l1'), note('l2')], ['F1'],
      'folder:F1', 'l2', 0,
    );
    expect(r?.flat).toEqual(['l1', 'l2', 'folder:F1', 'n1']);   // folder + its note move together
  });

  it('drags a folder between two other folders', () => {
    const r = drop(
      ['folder:F1', 'n1', 'folder:F2', 'n2', 'folder:F3'],
      [note('n1', 'F1'), note('n2', 'F2')], ['F1', 'F2', 'F3'],
      'folder:F3', 'folder:F2', 0,
    );
    expect(r?.flat).toEqual(['folder:F1', 'n1', 'folder:F3', 'folder:F2', 'n2']);
  });
});

describe('computeDrop - filing in and out of folders', () => {
  it('files a loose note into an empty folder with a rightward nudge', () => {
    const r = drop(['folder:F1', 'l1'], [note('l1')], ['F1'], 'l1', 'folder:F1', INDENT);
    expect(r?.flat).toEqual(['folder:F1', 'l1']);
    expect(r?.newFolderId).toBe('F1');
    expect(r?.openFolder).toBe('F1');
  });

  it('lands beside (not inside) a folder without the nudge', () => {
    const r = drop(['folder:F1', 'l1'], [note('l1')], ['F1'], 'l1', 'folder:F1', 0);
    expect(r?.flat).toEqual(['l1', 'folder:F1']);
    expect(r?.newFolderId).toBeUndefined();
  });

  it('pulls a note out of a folder by dragging left (outdent)', () => {
    const r = drop(['folder:F1', 'n1'], [note('n1', 'F1')], ['F1'], 'n1', 'folder:F1', -INDENT);
    expect(r?.flat).toEqual(['n1', 'folder:F1']);
    expect(r?.newFolderId).toBeUndefined();
  });

  it('reorders notes within a folder', () => {
    const r = drop(
      ['folder:F1', 'n1', 'n2'], [note('n1', 'F1'), note('n2', 'F1')], ['F1'], 'n2', 'n1', 0,
    );
    expect(r?.flat).toEqual(['folder:F1', 'n2', 'n1']);
    expect(r?.newFolderId).toBe('F1');
  });
});

describe('computeDrop - loose note reordering', () => {
  it('reorders loose notes among themselves', () => {
    const r = drop(['l1', 'l2', 'l3'], [note('l1'), note('l2'), note('l3')], [], 'l1', 'l3', 0);
    expect(r?.flat).toEqual(['l2', 'l3', 'l1']);
  });
});

describe('reconcileFlat', () => {
  it('expands folders with their notes, keeping blocks contiguous', () => {
    const out = reconcileFlat(
      ['folder:F1', 'folder:F2'],
      [folder('F1'), folder('F2')],
      [note('n1', 'F1'), note('n2', 'F2')],
    );
    expect(out).toEqual(['folder:F1', 'n1', 'folder:F2', 'n2']);
  });

  it('drops tokens for deleted entities and appends new ones', () => {
    const out = reconcileFlat(
      ['folder:GONE', 'l1', 'stale'],
      [folder('F1')],
      [note('l1'), note('l2')],
    );
    // GONE folder + stale note removed; F1 header and new l2 appended.
    expect(out).toEqual(['l1', 'folder:F1', 'l2']);
  });

  it('re-homes orphaned notes when their folder is deleted', () => {
    // n1 still points at F1, but F1 no longer exists → it becomes loose.
    const out = reconcileFlat(['folder:F1', 'n1', 'l1'], [], [note('n1', 'F1'), note('l1')]);
    expect(out).toEqual(['n1', 'l1']);
  });
});
