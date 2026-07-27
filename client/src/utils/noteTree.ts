import { arrayMove } from '@dnd-kit/sortable';
import { NoteDoc, NoteFolder } from '../hooks/useSettings';

// ── Flat tree ─────────────────────────────────────────────────────────
// The notes tree is one flat, ordered list of rows: folder headers and every
// visible note, all at the same level in a single sortable list. A note's
// membership is explicit (its folderId); the persisted `flat` token order holds
// the sequence, with each folder's notes contiguous right after its header. How
// far right you drag on a drop (`depth`) decides whether a note lands loose
// (depth 0) or inside the folder above it (depth 1). This is the dnd-kit
// "sortable tree" pattern, capped at one level of nesting - so every move (note
// to top, folder below notes, folder between folders, note into/out of a
// folder) is the same operation.

export const INDENT = 18;   // px of horizontal drag that steps one nesting level

export const isFolderId = (id: string | number) => String(id).startsWith('folder:');
export const folderIdOf = (token: string) => token.slice('folder:'.length);
export const sameOrder = (a: string[], b: string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

export type Row =
  | { id: string; kind: 'folder'; fid: string; depth: 0 }
  | { id: string; kind: 'note'; depth: 0 | 1; parentId: string | null };

// Walk the persisted token order into the visible rows. Notes under a collapsed
// folder - and, mid-drag, the children of the folder being dragged - are held
// back so a folder moves as one block.
export function buildRows(
  flat: string[], folderSet: Set<string>, notesById: Map<string, NoteDoc>,
  openFolders: Set<string>, hideChildrenOf?: string,
): Row[] {
  const rows: Row[] = [];
  for (const t of flat) {
    if (isFolderId(t)) {
      const fid = folderIdOf(t);
      if (folderSet.has(fid)) rows.push({ id: t, kind: 'folder', fid, depth: 0 });
    } else {
      const n = notesById.get(t);
      if (!n) continue;
      const parentId = n.folderId && folderSet.has(n.folderId) ? n.folderId : null;
      if (parentId) {
        if (!openFolders.has(parentId)) continue;
        if (hideChildrenOf && parentId === hideChildrenOf) continue;
        rows.push({ id: t, kind: 'note', depth: 1, parentId });
      } else {
        rows.push({ id: t, kind: 'note', depth: 0, parentId: null });
      }
    }
  }
  return rows;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

// A note may nest (depth 1) only when the row above can host it: a folder header
// or another note already inside a folder. Folders are always depth 0.
function maxDepthBelow(prev: Row | undefined): 0 | 1 {
  if (!prev) return 0;
  if (prev.kind === 'folder') return 1;
  return prev.depth;
}
// It must stay nested if the row below is itself nested (else it would split the
// folder off from its own children).
function minDepthAbove(next: Row | undefined): 0 | 1 {
  return next && next.kind === 'note' && next.depth === 1 ? 1 : 0;
}
function nearestFolderAbove(prev: Row | undefined): string | null {
  if (!prev) return null;
  if (prev.kind === 'folder') return prev.fid;
  if (prev.kind === 'note' && prev.parentId) return prev.parentId;
  return null;
}

// Where the dragged row would land: its target depth, the folder it would join
// (parentId), and the row it would sit under (prevToken).
export function getProjection(
  rows: Row[], activeId: string, overId: string, offsetLeft: number,
): { depth: 0 | 1; parentId: string | null; prevToken: string | null } | null {
  const overIndex = rows.findIndex(r => r.id === overId);
  const activeIndex = rows.findIndex(r => r.id === activeId);
  if (overIndex < 0 || activeIndex < 0) return null;
  const active = rows[activeIndex];
  const over = rows[overIndex];
  const moved = arrayMove(rows, activeIndex, overIndex);
  const prev = moved[overIndex - 1];
  const next = moved[overIndex + 1];
  const prevToken = prev ? prev.id : null;

  if (active.kind === 'folder') return { depth: 0, parentId: null, prevToken };

  const dragDepth = Math.round(offsetLeft / INDENT);
  // Hovering a folder header with any rightward intent files the note into that
  // folder (as its first child) - this is how you reach an empty or collapsed
  // folder. Without the rightward nudge it falls through and lands beside it.
  if (over.kind === 'folder' && active.depth + dragDepth >= 1) {
    return { depth: 1, parentId: over.fid, prevToken: over.id };
  }

  const projected = active.depth + dragDepth;
  const depth = clamp(projected, minDepthAbove(next), maxDepthBelow(prev)) as 0 | 1;
  return { depth, parentId: depth === 1 ? nearestFolderAbove(prev) : null, prevToken };
}

// Index in `flat` just past a folder header and all of its notes, so a
// top-level insertion never splits a folder's block.
function skipFolderBlock(flat: string[], headerIndex: number, fid: string, notesById: Map<string, NoteDoc>): number {
  let i = headerIndex + 1;
  while (i < flat.length && !isFolderId(flat[i]) && notesById.get(flat[i])?.folderId === fid) i++;
  return i;
}

// Pure resolution of a drop: given the current flat order and where the drag
// landed, return the new flat order plus (for a note) the folder it now belongs
// to. Returns null for a no-op. Side-effect-free so it can be unit tested.
export function computeDrop(
  flat: string[], rows: Row[], notesById: Map<string, NoteDoc>, folderSet: Set<string>,
  dragId: string, overId: string, offsetLeft: number,
): { flat: string[]; noteId?: string; newFolderId?: string; openFolder?: string } | null {
  const proj = getProjection(rows, dragId, overId, offsetLeft);
  if (!proj) return null;
  const { parentId, prevToken } = proj;
  const isFolder = isFolderId(dragId);

  // Lift the moving block out: a folder carries its own notes with it.
  const block = isFolder
    ? [dragId, ...flat.filter(t => !isFolderId(t) && notesById.get(t)?.folderId === folderIdOf(dragId))]
    : [dragId];
  const blockSet = new Set(block);
  const remaining = flat.filter(t => !blockSet.has(t));

  // Where does it re-enter?
  let at: number;
  if (!prevToken) {
    at = 0;
  } else if (!isFolder && parentId) {
    at = remaining.indexOf(prevToken) + 1;                 // right after header/sibling
  } else if (isFolderId(prevToken)) {
    at = skipFolderBlock(remaining, remaining.indexOf(prevToken), folderIdOf(prevToken), notesById);
  } else {
    const pn = notesById.get(prevToken);                   // a note - clear its whole folder block
    if (pn?.folderId && folderSet.has(pn.folderId)) {
      const hi = remaining.indexOf(`folder:${pn.folderId}`);
      at = hi >= 0 ? skipFolderBlock(remaining, hi, pn.folderId, notesById) : remaining.indexOf(prevToken) + 1;
    } else {
      at = remaining.indexOf(prevToken) + 1;
    }
  }
  if (at < 0) at = remaining.length;

  const nextFlat = [...remaining.slice(0, at), ...block, ...remaining.slice(at)];
  const parentUnchanged = notesById.get(dragId)?.folderId ?? undefined;
  if (sameOrder(nextFlat, flat) && (isFolder || parentUnchanged === (parentId ?? undefined))) {
    return null;
  }
  if (isFolder) return { flat: nextFlat };
  return { flat: nextFlat, noteId: dragId, newFolderId: parentId ?? undefined, openFolder: parentId ?? undefined };
}

// Rebuild a well-formed flat order from whatever exists now, preserving the
// previous ordering as far as possible. Guarantees every folder's notes sit
// contiguously right after its header - the invariant the drop math relies on -
// and drops tokens for anything deleted while appending anything new. Doubles as
// the seed (pass the stored order as `prev`).
export function reconcileFlat(prev: string[], folders: NoteFolder[], liveDocs: NoteDoc[]): string[] {
  const folderSet = new Set(folders.map(f => f.id));
  const noteById = new Map(liveDocs.map(d => [d.id, d]));
  const rank = new Map(prev.map((t, i) => [t, i]));
  const byPrev = (a: string, b: string) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity);

  const notesByFolder = new Map<string, string[]>();
  const loose: string[] = [];
  for (const d of liveDocs) {
    if (d.folderId && folderSet.has(d.folderId)) {
      const a = notesByFolder.get(d.folderId) ?? [];
      a.push(d.id);
      notesByFolder.set(d.folderId, a);
    } else {
      loose.push(d.id);
    }
  }
  notesByFolder.forEach(a => a.sort(byPrev));
  loose.sort(byPrev);

  // Top-level sequence (folders + loose notes) from prev, then anything new.
  const top: string[] = [];
  const seen = new Set<string>();
  for (const t of prev) {
    if (isFolderId(t)) {
      if (folderSet.has(folderIdOf(t)) && !seen.has(t)) { seen.add(t); top.push(t); }
    } else {
      const d = noteById.get(t);
      if (d && !(d.folderId && folderSet.has(d.folderId)) && !seen.has(t)) { seen.add(t); top.push(t); }
    }
  }
  for (const f of folders) { const tok = `folder:${f.id}`; if (!seen.has(tok)) { seen.add(tok); top.push(tok); } }
  for (const id of loose) { if (!seen.has(id)) { seen.add(id); top.push(id); } }

  // Expand each folder header with its notes.
  const out: string[] = [];
  for (const t of top) {
    out.push(t);
    if (isFolderId(t)) for (const nid of notesByFolder.get(folderIdOf(t)) ?? []) out.push(nid);
  }
  return out;
}
