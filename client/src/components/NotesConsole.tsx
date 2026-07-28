import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors,
  DragStartEvent, DragMoveEvent, DragOverEvent, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import styles from './NotesConsole.module.css';
import RichEditor from './RichEditor';
import { NoteDoc, NoteFolder } from '../hooks/useSettings';
import { searchNotes } from '../utils/noteText';
import { markdownToHtml } from '../utils/noteMigrate';
import { uploadImage } from '../utils/imageUpload';
import { fetchPageMeta } from '../utils/pageMeta';
import { EmbedData, embeddedUrls } from '../utils/noteEmbed';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { modLabel } from '../utils/platform';
import {
  INDENT, isFolderId, folderIdOf, sameOrder, buildRows, getProjection, computeDrop, reconcileFlat,
} from '../utils/noteTree';

// Same swatch set the bookmark folders use, so a folder color means the same
// thing everywhere in the app (see EditFolderModal).
const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

function uid(): string {
  return (crypto as any)?.randomUUID?.() ?? `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Recently deleted ──────────────────────────────────────────────────
// Deleting a note stamps it with `deletedAt` instead of dropping it. It stays
// recoverable for this long, then is purged the next time the console opens.
const TRASH_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysLeft(deletedAt: number): number {
  return Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS));
}

function expiryLabel(deletedAt: number): string {
  const d = daysLeft(deletedAt);
  if (d <= 0) return 'Deleting today';
  return `${d} day${d === 1 ? '' : 's'} left`;
}

function blankNote(): NoteDoc {
  return { id: uid(), title: '', body: '', updatedAt: Date.now() };
}

interface NoteRowProps {
  doc: NoteDoc;
  active: boolean;
  snippet?: string;          // body context, shown when a search matched the text
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

const DocIcon = () => (
  <svg className={styles.treeIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

const TrashIcon = () => (
  <svg className={styles.treeIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" /><path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
  </svg>
);

const RestoreIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    className={`${styles.trashChevron} ${open ? styles.trashChevronOpen : ''}`}
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
  >
    <path d="M9 18l6-6-6-6" />
  </svg>
);

// Filled with the folder's own color so the tree reads at a glance.
const FolderIcon = ({ color }: { color: string }) => (
  <svg className={styles.folderIcon} width="14" height="14" viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="1.5" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const GearIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <path d="M7 2v10M2 7h10" />
  </svg>
);

function DeleteBtn({ id, onDelete }: { id: string; onDelete: (id: string) => void }) {
  return (
    <button
      className={styles.treeDelete}
      onClick={e => { e.stopPropagation(); onDelete(id); }}
      onPointerDown={e => e.stopPropagation()}
      title="Delete note"
      aria-label="Delete note"
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M1 1l10 10M11 1L1 11" />
      </svg>
    </button>
  );
}

// Plain (non-draggable) row - used while a search filters the tree, since
// dropping onto a filtered list can't express a position in the full order.
function NoteRow({ doc, active, snippet, onSelect, onDelete }: NoteRowProps) {
  return (
    <div
      className={`${styles.treeItem} ${active ? styles.treeItemActive : ''} ${snippet ? styles.treeItemHit : ''}`}
      onClick={() => onSelect(doc.id)}
    >
      <DocIcon />
      <span className={styles.treeText}>
        <span className={styles.treeName}>{doc.title.trim() || 'Untitled'}</span>
        {snippet && <span className={styles.treeSnippet}>{snippet}</span>}
      </span>
      <DeleteBtn id={doc.id} onDelete={onDelete} />
    </div>
  );
}

// A row in Recently Deleted: how long it has left, and the two ways out.
function TrashRow({ doc, active, onSelect, onRestore, onPurge }: {
  doc: NoteDoc;
  active: boolean;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
}) {
  return (
    <div
      className={`${styles.treeItem} ${styles.trashItem} ${active ? styles.treeItemActive : ''}`}
      onClick={() => onSelect(doc.id)}
    >
      <TrashIcon />
      <span className={styles.treeText}>
        <span className={styles.treeName}>{doc.title.trim() || 'Untitled'}</span>
        <span className={styles.trashMeta}>{expiryLabel(doc.deletedAt!)}</span>
      </span>
      <span className={styles.trashActions}>
        <button
          className={styles.trashBtn}
          onClick={e => { e.stopPropagation(); onRestore(doc.id); }}
          title="Put this note back"
          aria-label="Restore note"
        >
          <RestoreIcon />
        </button>
        <button
          className={`${styles.trashBtn} ${styles.trashBtnDanger}`}
          onClick={e => { e.stopPropagation(); onPurge(doc.id); }}
          title="Delete permanently"
          aria-label="Delete permanently"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M1 1l10 10M11 1L1 11" />
          </svg>
        </button>
      </span>
    </div>
  );
}

function SortableNote({ doc, active, indent, onSelect, onDelete }: NoteRowProps & { indent?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: doc.id });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.treeItem} ${indent ? styles.treeItemNested : ''} ${active ? styles.treeItemActive : ''} ${isDragging ? styles.treeItemDragging : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={() => onSelect(doc.id)}
      {...attributes}
      {...listeners}
    >
      <DocIcon />
      <span className={styles.treeText}>
        <span className={styles.treeName}>{doc.title.trim() || 'Untitled'}</span>
      </span>
      <DeleteBtn id={doc.id} onDelete={onDelete} />
    </div>
  );
}

// The rename/recolor/delete card that drops under a folder header. Kept inside
// the tree so it never leaves the console; closes on outside click or Escape.
function FolderPopover({ folder, onRename, onRecolor, onDelete, onClose }: {
  folder: NoteFolder;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const [armDelete, setArmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // Commit the name before closing on any outside interaction.
  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { onRename(name.trim() || 'Folder'); onClose(); }
    }
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [name, onRename, onClose]);

  return (
    <div className={styles.folderPopover} ref={ref} onClick={e => e.stopPropagation()}>
      <input
        ref={inputRef}
        className={styles.folderNameInput}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { onRename(name.trim() || 'Folder'); onClose(); }
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        }}
        placeholder="Folder name"
        spellCheck={false}
        aria-label="Folder name"
      />
      <div className={styles.folderSwatchRow}>
        {PALETTE.map(c => (
          <button
            key={c}
            className={`${styles.folderSwatch} ${c === folder.color ? styles.folderSwatchSel : ''}`}
            style={{ background: c }}
            onClick={() => onRecolor(c)}
            title={c}
            aria-label={`Set color ${c}`}
          />
        ))}
      </div>
      <div className={styles.folderPopActions}>
        <button
          className={`${styles.folderDeleteBtn} ${armDelete ? styles.folderDeleteBtnArmed : ''}`}
          onClick={() => { if (!armDelete) { setArmDelete(true); return; } onDelete(); }}
        >
          {armDelete ? 'Delete folder?' : 'Delete folder'}
        </button>
        <button
          className={styles.folderDoneBtn}
          onClick={() => { onRename(name.trim() || 'Folder'); onClose(); }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

interface FolderRowProps {
  folder: NoteFolder;
  count: number;           // notes in this folder
  open: boolean;
  editing: boolean;
  dropTarget: boolean;     // a note is being dragged into this folder right now
  onToggle: () => void;
  onAddNote: () => void;
  onOpenEdit: () => void;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDeleteFolder: () => void;
  onCloseEdit: () => void;
}

// A single flat, sortable folder-header row. Its notes are separate rows in the
// same list (indented), not children here - that's what makes the whole tree one
// uniform sortable surface.
function SortableFolderRow({
  folder, count, open, editing, dropTarget,
  onToggle, onAddNote, onOpenEdit, onRename, onRecolor, onDeleteFolder, onCloseEdit,
}: FolderRowProps) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `folder:${folder.id}` });
  return (
    <div
      className={styles.folderGroup}
      ref={setNodeRef}
      // Translate only - CSS.Transform would add the strategy's scaleY, which
      // stretches a folder to the height of whatever it's swapping with.
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div
        className={`${styles.folderHead} ${isDragging ? styles.folderDragging : ''} ${dropTarget ? styles.folderDropActive : ''}`}
        onClick={onToggle}
        {...attributes}
        {...listeners}
      >
        <ChevronIcon open={open} />
        <FolderIcon color={folder.color} />
        <span className={styles.folderName}>{folder.name.trim() || 'Folder'}</span>
        <span className={styles.folderCount}>{count}</span>
        <span className={styles.folderActions}>
          <button
            className={styles.folderActBtn}
            onClick={e => { e.stopPropagation(); onAddNote(); }}
            onPointerDown={e => e.stopPropagation()}
            title="New note in folder"
            aria-label="New note in folder"
          >
            <PlusIcon />
          </button>
          <button
            className={styles.folderActBtn}
            onClick={e => { e.stopPropagation(); onOpenEdit(); }}
            onPointerDown={e => e.stopPropagation()}
            title="Edit folder"
            aria-label="Edit folder"
          >
            <GearIcon />
          </button>
        </span>
      </div>

      {editing && (
        <FolderPopover
          folder={folder}
          onRename={onRename}
          onRecolor={onRecolor}
          onDelete={onDeleteFolder}
          onClose={onCloseEdit}
        />
      )}
    </div>
  );
}

interface Props {
  docs: NoteDoc[];
  folders: NoteFolder[];
  order: string[];          // top-level tree order (folder / ungrouped-note tokens)
  legacyNotes: string;      // old settings.notes, migrated on first use
  onSave: (docs: NoteDoc[], folders: NoteFolder[], order: string[]) => Promise<unknown> | void;
  sidebarWidth?: number;                       // persisted tree-column width
  onSidebarWidth?: (w: number) => void;        // persist a resize
  initialNoteId?: string;   // opened from a search hit in the main search bar
  initialQuery?: string;    // …and the term that found it, seeded into the filter
  references?: EmbedData[]; // what /reference can embed - the saved articles

  closing?: boolean;
  onClose: () => void;
}

// The tree column can be dragged between these bounds.
const SIDEBAR_MIN = 168;
const SIDEBAR_MAX = 460;
const MAX_KEY = 'newt:notesMaximized';

export default function NotesConsole({
  docs, folders: foldersProp, order: orderProp, legacyNotes, onSave,
  sidebarWidth: sidebarWidthProp = 210, onSidebarWidth,
  initialNoteId, initialQuery = '', references, closing = false, onClose,
}: Props) {
  // Seed the working set once: existing docs → migrate legacy note → a blank
  // note. Anything that has outstayed its 15 days in Recently Deleted is purged
  // on the way in, and there's always at least one live note to open onto.
  const [initial] = useState<NoteDoc[]>(() => {
    const seed: NoteDoc[] =
      docs && docs.length ? docs
      : legacyNotes && legacyNotes.trim()
        ? [{ id: uid(), title: 'Notes', body: markdownToHtml(legacyNotes), updatedAt: Date.now() }]
        : [blankNote()];
    const kept = seed.filter(d => !d.deletedAt || Date.now() - d.deletedAt < TRASH_DAYS * DAY_MS);
    if (!kept.some(d => !d.deletedAt)) kept.unshift(blankNote());
    // Identity is the signal that nothing had to change - the effect below
    // persists the seed only when it isn't what's stored.
    return seed === docs && kept.length === seed.length ? docs : kept;
  });

  // docsRef holds the live source of truth (body edits are written here without
  // re-rendering, so typing never churns React); `list` mirrors it for the tree.
  const docsRef = useRef<NoteDoc[]>(initial);
  const [list, setList] = useState<NoteDoc[]>(initial);
  // Folders mirror the same pattern: a ref for the save channel, state for render.
  const foldersRef = useRef<NoteFolder[]>(foldersProp ?? []);
  const [folders, setFolders] = useState<NoteFolder[]>(foldersProp ?? []);
  // The whole tree as one flat, ordered token list (folder headers + every note,
  // each folder's notes contiguous after it). Seeded from the stored order.
  const [flat, setFlat] = useState<string[]>(
    () => reconcileFlat(orderProp ?? [], foldersProp ?? [], initial.filter(d => !d.deletedAt)),
  );
  const flatRef = useRef<string[]>(flat);
  // Expand/collapse is stored on the folder itself, so it survives a reload.
  const openFolders = useMemo(
    () => new Set(folders.filter(f => !f.collapsed).map(f => f.id)),
    [folders],
  );
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const clampWidth = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
  const [sidebarWidth, setSidebarWidth] = useState(() => clampWidth(sidebarWidthProp));
  // Fill-the-viewport toggle. A per-device view preference, so it lives in
  // localStorage and is remembered the next time the console is opened.
  const [maximized, setMaximized] = useState<boolean>(() => {
    try { return localStorage.getItem(MAX_KEY) === '1'; } catch { return false; }
  });
  function toggleMaximize() {
    setMaximized(m => {
      const next = !m;
      try { localStorage.setItem(MAX_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }
  // Live drag state: which row is moving, and where it currently projects to
  // (depth + the folder it would join) so the overlay and folder highlight can
  // reflect it. `offsetLeftRef` is the horizontal drag distance that drives depth.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [projected, setProjected] = useState<{ depth: 0 | 1; parentId: string | null } | null>(null);
  const offsetLeftRef = useRef(0);
  const overIdRef = useRef<string | null>(null);
  const [dragItem, setDragItem] = useState<
    | { kind: 'note'; title: string }
    | { kind: 'folder'; folder: NoteFolder }
    | null
  >(null);
  // The console opens with nothing selected - the editor stays blank until a note
  // is picked (unless it was opened straight onto a search hit).
  const [activeId, setActiveId] = useState<string | null>(
    () => (initialNoteId && initial.some(d => d.id === initialNoteId) ? initialNoteId : null)
  );
  // Narrow screens can't carry the tree and the editor at once - see the 720px
  // block in the stylesheet, where these become two full-height views. This says
  // which one is showing. Wide screens show both and ignore it entirely; it's
  // still tracked there so the right view is up if the window is narrowed.
  const [mobilePane, setMobilePane] = useState<'tree' | 'doc'>(
    () => (initialNoteId ? 'doc' : 'tree')
  );
  const [saved, setSaved] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [armEmpty, setArmEmpty] = useState(false);   // "Empty" asks once before it throws work away
  const [query, setQuery] = useState(initialQuery);
  const queryRef = useRef(query);
  queryRef.current = query;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    Promise.resolve(onSave(docsRef.current, foldersRef.current, flatRef.current)).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1400);
    }).catch(() => {});
  }, [onSave]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 700);
  }, [flush]);

  // Sets both the render state and the save-channel ref together.
  const commitFlat = useCallback((next: string[]) => {
    flatRef.current = next;
    setFlat(next);
    scheduleSave();
  }, [scheduleSave]);

  // The seed was rebuilt against stored notes (legacy migration or an expiry
  // purge) - write it back so what's stored matches what's on screen. A first
  // blank note isn't worth a save: nothing has been written yet.
  useEffect(() => {
    if (initial !== docs && (docs?.length || legacyNotes.trim())) scheduleSave();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const requestClose = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  // Escape closes (the header has advertised this all along). The editor's
  // command menu stops propagation when it's open, so the first Escape there
  // dismisses the menu and a second one closes the console. An active search
  // filter is likewise cleared first, before the console will close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (queryRef.current) { setQuery(''); return; }
      requestClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const active = activeId ? docsRef.current.find(d => d.id === activeId) : undefined;
  const activeTrashed = !!active?.deletedAt;

  // Comment counts for the references embedded in the open note. Seeded from
  // the saved body on every note switch - the editor is uncontrolled, so that
  // is where the HTML lives - and topped up by the editor when a reference is
  // added mid-session. The hook fetches each URL once and caches it, so moving
  // between notes costs nothing.
  const [embedUrls, setEmbedUrls] = useState<string[]>([]);
  useEffect(() => {
    setEmbedUrls(embeddedUrls(docsRef.current.find(d => d.id === activeId)?.body ?? ''));
  }, [activeId]);
  const { counts: commentCounts } = useCommentCounts(embedUrls);

  const liveDocs = useMemo(() => list.filter(d => !d.deletedAt), [list]);
  const trashDocs = useMemo(
    () => list.filter(d => d.deletedAt).sort((a, b) => b.deletedAt! - a.deletedAt!),
    [list]
  );

  const folderIdSet = useMemo(() => new Set(folders.map(f => f.id)), [folders]);
  const notesById = useMemo(() => new Map(liveDocs.map(d => [d.id, d])), [liveDocs]);
  const folderNoteCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of liveDocs) if (d.folderId && folderIdSet.has(d.folderId)) m.set(d.folderId, (m.get(d.folderId) ?? 0) + 1);
    return m;
  }, [liveDocs, folderIdSet]);

  // Keep the flat order in step with what exists - new folders/notes get a slot,
  // deleted ones lose theirs, folder blocks stay contiguous - without disturbing
  // the saved arrangement.
  useEffect(() => {
    const next = reconcileFlat(flatRef.current, folders, liveDocs);
    if (!sameOrder(next, flatRef.current)) { flatRef.current = next; setFlat(next); }
  }, [folders, liveDocs]);

  // The visible rows: hide the actively-dragged folder's children so it moves as
  // one block.
  const draggingFolderId = activeDragId && isFolderId(activeDragId) ? folderIdOf(activeDragId) : undefined;
  const rows = useMemo(
    () => buildRows(flat, folderIdSet, notesById, openFolders, draggingFolderId),
    [flat, folderIdSet, notesById, openFolders, draggingFolderId],
  );
  const rowIds = useMemo(() => rows.map(r => r.id), [rows]);

  // Search the tree by title and body text. Body edits are written straight to
  // the doc objects (no re-render), so this recomputes off the live text every
  // time the query changes.
  const q = query.trim().toLowerCase();
  const results = useMemo(() => searchNotes(liveDocs, q), [liveDocs, q]);
  const trashResults = useMemo(() => searchNotes(trashDocs, q), [trashDocs, q]);

  // Opening a hit from the main search bar: jump to that note once it's known.
  useEffect(() => {
    if (initialNoteId && docsRef.current.some(d => d.id === initialNoteId)) {
      setActiveId(initialNoteId);
      setMobilePane('doc');
    }
  }, [initialNoteId]);

  // Body edits: write straight to the ref (no re-render) + debounce a save.
  const handleBody = useCallback((html: string) => {
    const doc = docsRef.current.find(d => d.id === activeId);
    if (!doc) return;
    doc.body = html;
    doc.updatedAt = Date.now();
    scheduleSave();
  }, [activeId, scheduleSave]);

  function handleTitle(v: string) {
    docsRef.current = docsRef.current.map(d => d.id === activeId ? { ...d, title: v, updatedAt: Date.now() } : d);
    setList(docsRef.current);
    scheduleSave();
  }

  function addNote() {
    const doc = blankNote();
    docsRef.current = [doc, ...docsRef.current];
    setList(docsRef.current);
    setActiveId(doc.id);
    setMobilePane('doc');
    setQuery('');   // an empty new note would be hidden by an active filter
    commitFlat([doc.id, ...flatRef.current.filter(t => t !== doc.id)]);   // new loose note on top
  }

  // Commit a new working set, keeping one live note around and moving off a
  // note that just stopped being viewable.
  function commit(next: NoteDoc[], leaving?: string) {
    if (!next.some(d => !d.deletedAt)) next = [blankNote(), ...next];
    docsRef.current = next;
    setList(next);
    setArmEmpty(false);
    // Leaving the open note returns to the blank state rather than jumping - and
    // on a narrow screen, back to the tree, since an empty editor is not a view.
    if (leaving && leaving === activeId) { setActiveId(null); setMobilePane('tree'); }
    scheduleSave();
  }

  // Deleting moves the note to Recently Deleted rather than dropping it; the
  // folder springs open so it's clear where the note went.
  function deleteNote(id: string) {
    const now = Date.now();
    commit(docsRef.current.map(d => d.id === id ? { ...d, deletedAt: now } : d), id);
    setTrashOpen(true);
  }

  function restoreNote(id: string) {
    commit(docsRef.current.map(d => d.id === id ? { ...d, deletedAt: undefined } : d));
    setActiveId(id);
    setMobilePane('doc');
  }

  function purgeNote(id: string) {
    commit(docsRef.current.filter(d => d.id !== id), id);
  }

  function emptyTrash() {
    if (!armEmpty) { setArmEmpty(true); return; }
    commit(docsRef.current.filter(d => !d.deletedAt), activeTrashed ? activeId ?? undefined : undefined);
  }

  function selectNote(id: string) {
    // Picking a note is what opens the editor on a narrow screen, so this runs
    // even when the note is already the active one.
    setMobilePane('doc');
    if (id === activeId) return;
    // Body for the current note is already in docsRef; just switch.
    setActiveId(id);
  }

  // ── Folders ──────────────────────────────────────────────────────────
  function commitFolders(next: NoteFolder[]) {
    foldersRef.current = next;
    setFolders(next);
    scheduleSave();
  }

  function toggleFolder(id: string) {
    commitFolders(foldersRef.current.map(f => f.id === id ? { ...f, collapsed: !f.collapsed } : f));
  }

  // Ensure a folder is expanded (persisted) - used when something lands inside it.
  function openFolder(id: string) {
    if (foldersRef.current.some(f => f.id === id && f.collapsed)) {
      commitFolders(foldersRef.current.map(f => f.id === id ? { ...f, collapsed: false } : f));
    }
  }

  // Drag the divider between the tree and the editor to resize; the final width
  // is persisted so it holds across sessions.
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const move = (ev: PointerEvent) => setSidebarWidth(clampWidth(startW + ev.clientX - startX));
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const w = clampWidth(startW + ev.clientX - startX);
      setSidebarWidth(w);
      onSidebarWidth?.(w);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function addFolder() {
    const f: NoteFolder = { id: uid(), name: 'New folder', color: PALETTE[0] };
    commitFolders([...foldersRef.current, f]);
    setEditingFolder(f.id);   // open the rename popover straight away
    setQuery('');
  }

  function renameFolder(id: string, name: string) {
    commitFolders(foldersRef.current.map(f => f.id === id ? { ...f, name } : f));
  }

  function recolorFolder(id: string, color: string) {
    commitFolders(foldersRef.current.map(f => f.id === id ? { ...f, color } : f));
  }

  // Deleting a folder keeps its notes - they fall back to loose, sitting where
  // the folder was (reconcile turns the orphaned children into top-level notes).
  function deleteFolder(id: string) {
    docsRef.current = docsRef.current.map(d => d.folderId === id ? { ...d, folderId: undefined } : d);
    setList(docsRef.current);
    setEditingFolder(null);
    commitFolders(foldersRef.current.filter(f => f.id !== id));
  }

  function addNoteToFolder(fid: string) {
    const doc: NoteDoc = { ...blankNote(), folderId: fid };
    docsRef.current = [doc, ...docsRef.current];
    setList(docsRef.current);
    setActiveId(doc.id);
    setMobilePane('doc');
    setQuery('');
    openFolder(fid);
    // Slot the new note right after its folder header.
    const header = `folder:${fid}`;
    const at = flatRef.current.indexOf(header);
    const next = flatRef.current.filter(t => t !== doc.id);
    next.splice(at < 0 ? next.length : at + 1, 0, doc.id);
    commitFlat(next);
  }

  // ── Drag ─────────────────────────────────────────────────────────────
  // Recompute where the dragged row projects to, for live overlay/highlight.
  const refreshProjection = useCallback(() => {
    const activeId = activeDragId, overId = overIdRef.current;
    if (!activeId || !overId) { setProjected(null); return; }
    const p = getProjection(rows, activeId, overId, offsetLeftRef.current);
    setProjected(p ? { depth: p.depth, parentId: p.parentId } : null);
  }, [activeDragId, rows]);

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    offsetLeftRef.current = 0;
    overIdRef.current = id;
    setActiveDragId(id);
    if (isFolderId(id)) {
      const f = foldersRef.current.find(f => `folder:${f.id}` === id);
      if (f) setDragItem({ kind: 'folder', folder: f });
    } else {
      const d = docsRef.current.find(d => d.id === id);
      setDragItem({ kind: 'note', title: d?.title?.trim() || 'Untitled' });
    }
  }

  function handleDragOver(e: DragOverEvent) {
    overIdRef.current = e.over ? String(e.over.id) : null;
    refreshProjection();
  }

  function handleDragMove(e: DragMoveEvent) {
    offsetLeftRef.current = e.delta.x;
    refreshProjection();
  }

  function clearDrag() {
    setActiveDragId(null);
    setProjected(null);
    setDragItem(null);
    overIdRef.current = null;
    offsetLeftRef.current = 0;
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active: a, over } = e;
    const dragId = String(a.id);
    const overId = over ? String(over.id) : null;
    // Rows exclude the dragged folder's children, matching what getProjection saw.
    const rowsNow = buildRows(flatRef.current, folderIdSet, notesById, openFolders, draggingFolderId);
    const offset = offsetLeftRef.current;
    clearDrag();
    if (!overId) return;

    const result = computeDrop(flatRef.current, rowsNow, notesById, folderIdSet, dragId, overId, offset);
    if (!result) return;

    if (result.noteId) {
      docsRef.current = docsRef.current.map(d =>
        d.id === result.noteId ? { ...d, folderId: result.newFolderId } : d);
      setList(docsRef.current);
      if (result.openFolder) openFolder(result.openFolder);
    }
    commitFlat(result.flat);
  }

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) requestClose(); }}>
      <div
        className={`${styles.shell} ${closing ? styles.shellClosing : ''} ${maximized ? styles.shellMaximized : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.console}>
          <div className={styles.header}>
            <span className={styles.headerTitle}>NOTES</span>
            <span className={styles.headerRight}>
              {saved && <span className={styles.savedBadge}>Saved</span>}
              <span className={styles.headerHints}>
                <kbd>/</kbd>commands
                <span className={styles.dot}>·</span>
                <kbd>{modLabel('F')}</kbd>find
                <span className={styles.dot}>·</span>
                <kbd>tab</kbd>indent
                <span className={styles.dot}>·</span>
                <kbd>esc</kbd>close
              </span>
              <button
                className={`${styles.closeBtn} ${styles.maxBtn}`}
                onClick={toggleMaximize}
                title={maximized ? 'Restore' : 'Maximize'}
                aria-label={maximized ? 'Restore notes' : 'Maximize notes'}
              >
                {maximized ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                  </svg>
                )}
              </button>
              <button className={styles.closeBtn} onClick={requestClose} title="Close">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M1 1l10 10M11 1L1 11" />
                </svg>
              </button>
            </span>
          </div>

          <div
            className={`${styles.body} ${mobilePane === 'doc' ? styles.bodyDoc : ''}`}
            style={{ '--tree-w': `${sidebarWidth}px` } as React.CSSProperties}
          >
            {/* ── Note tree ── */}
            <aside className={styles.tree}>
              {/* Drag the right edge to resize the tree column */}
              <div
                className={styles.resizer}
                onPointerDown={startResize}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize notes sidebar"
              />
              <div className={styles.treeHead}>
                <span className={styles.treeLabel}>
                  {q ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'All notes'}
                </span>
                <span className={styles.treeHeadBtns}>
                  <button className={styles.addBtn} onClick={addFolder} title="New folder" aria-label="New folder">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      <path d="M12 11v4M10 13h4" />
                    </svg>
                  </button>
                  <button className={styles.addBtn} onClick={addNote} title="New note" aria-label="New note">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                      <path d="M7 2v10M2 7h10" />
                    </svg>
                  </button>
                </span>
              </div>

              <div className={styles.searchWrap}>
                <svg className={styles.searchIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  className={styles.searchInput}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search notes"
                  aria-label="Search notes"
                  spellCheck={false}
                />
                {query && (
                  <button
                    className={styles.searchClear}
                    onClick={() => setQuery('')}
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                      <path d="M1 1l10 10M11 1L1 11" />
                    </svg>
                  </button>
                )}
              </div>

              <div className={styles.treeList}>
                {q ? (
                  results.length === 0
                    ? <div className={styles.treeEmpty}>No notes match “{query.trim()}”</div>
                    : results.map(({ doc, snippet }) => (
                        <NoteRow
                          key={doc.id}
                          doc={doc}
                          active={doc.id === activeId}
                          snippet={snippet}
                          onSelect={selectNote}
                          onDelete={deleteNote}
                        />
                      ))
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCorners}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragMove={handleDragMove}
                    onDragEnd={handleDragEnd}
                    onDragCancel={clearDrag}
                  >
                    {/* One flat sortable list: folder headers and notes together. */}
                    <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
                      {rows.map(r => {
                        if (r.kind === 'folder') {
                          const f = folders.find(f => f.id === r.fid)!;
                          return (
                            <SortableFolderRow
                              key={r.id}
                              folder={f}
                              count={folderNoteCount.get(f.id) ?? 0}
                              open={openFolders.has(f.id)}
                              editing={editingFolder === f.id}
                              dropTarget={projected?.parentId === f.id}
                              onToggle={() => toggleFolder(f.id)}
                              onAddNote={() => addNoteToFolder(f.id)}
                              onOpenEdit={() => setEditingFolder(f.id)}
                              onRename={name => renameFolder(f.id, name)}
                              onRecolor={color => recolorFolder(f.id, color)}
                              onDeleteFolder={() => deleteFolder(f.id)}
                              onCloseEdit={() => setEditingFolder(null)}
                            />
                          );
                        }
                        const d = notesById.get(r.id);
                        if (!d) return null;
                        return (
                          <SortableNote
                            key={r.id}
                            doc={d}
                            active={d.id === activeId}
                            indent={r.depth === 1}
                            onSelect={selectNote}
                            onDelete={deleteNote}
                          />
                        );
                      })}
                    </SortableContext>

                    {/* Portaled to <body> so the floating copy escapes the tree's
                        overflow clipping and the shell's transform. Its indent
                        previews the projected drop depth. */}
                    {createPortal(
                      <DragOverlay dropAnimation={null}>
                        {dragItem?.kind === 'note' ? (
                          <div
                            className={`${styles.treeItem} ${styles.dragOverlayItem}`}
                            style={{ marginLeft: (projected?.depth ?? 0) * INDENT }}
                          >
                            <DocIcon />
                            <span className={styles.treeText}>
                              <span className={styles.treeName}>{dragItem.title}</span>
                            </span>
                          </div>
                        ) : dragItem?.kind === 'folder' ? (
                          <div className={`${styles.folderHead} ${styles.dragOverlayItem}`}>
                            <FolderIcon color={dragItem.folder.color} />
                            <span className={styles.folderName}>{dragItem.folder.name.trim() || 'Folder'}</span>
                          </div>
                        ) : null}
                      </DragOverlay>,
                      document.body
                    )}
                  </DndContext>
                )}

                {/* ── Recently deleted ── */}
                {trashDocs.length > 0 && (
                  <div className={styles.trashSection}>
                    <button
                      className={styles.trashHead}
                      onClick={() => { setTrashOpen(o => !o); setArmEmpty(false); }}
                      aria-expanded={trashOpen}
                    >
                      <ChevronIcon open={trashOpen} />
                      Recently deleted
                      <span className={styles.trashCount}>
                        {q ? `${trashResults.length}/${trashDocs.length}` : trashDocs.length}
                      </span>
                    </button>

                    {trashOpen && (
                      <>
                        {trashResults.map(({ doc }) => (
                          <TrashRow
                            key={doc.id}
                            doc={doc}
                            active={doc.id === activeId}
                            onSelect={selectNote}
                            onRestore={restoreNote}
                            onPurge={purgeNote}
                          />
                        ))}
                        {q && trashResults.length === 0 && (
                          <div className={styles.trashNote}>Nothing deleted matches “{query.trim()}”.</div>
                        )}
                        <div className={styles.trashNote}>
                          Notes here are deleted for good after {TRASH_DAYS} days.
                        </div>
                        <button
                          className={`${styles.trashEmptyBtn} ${armEmpty ? styles.trashEmptyBtnArmed : ''}`}
                          onClick={emptyTrash}
                        >
                          {armEmpty
                            ? `Delete ${trashDocs.length} note${trashDocs.length === 1 ? '' : 's'} for good?`
                            : 'Empty recently deleted'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </aside>

            {/* ── Editor ── */}
            <div className={styles.docPane}>
              {/* The way back to the tree. Only ever visible on the narrow
                  layout, where the two panes take turns - see the stylesheet. */}
              <button className={styles.backBtn} onClick={() => setMobilePane('tree')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                All notes
              </button>
              {active ? (
                <>
                  {activeTrashed && (
                    <div className={styles.trashBanner}>
                      <span className={styles.trashBannerText}>
                        In Recently deleted · {expiryLabel(active.deletedAt!).toLowerCase()}
                      </span>
                      <button className={styles.trashBannerBtn} onClick={() => restoreNote(active.id)}>
                        Restore
                      </button>
                      <button
                        className={`${styles.trashBannerBtn} ${styles.trashBannerBtnDanger}`}
                        onClick={() => purgeNote(active.id)}
                      >
                        Delete now
                      </button>
                    </div>
                  )}
                  <input
                    className={styles.docTitle}
                    value={active.title}
                    onChange={e => handleTitle(e.target.value)}
                    placeholder="Untitled"
                    spellCheck={false}
                    readOnly={activeTrashed}
                  />
                  {/* The read-only surface is a different tree, so the key carries
                      that state too - remounting is what re-renders the body. */}
                  <RichEditor
                    key={`${active.id}:${activeTrashed}`}
                    initialHtml={active.body}
                    onChange={handleBody}
                    readOnly={activeTrashed}
                    onUploadImage={uploadImage}
                    onFetchPageMeta={fetchPageMeta}
                    references={references}
                    commentCounts={commentCounts}
                    onEmbedsChange={setEmbedUrls}
                    findable
                  />
                </>
              ) : (
                <div className={styles.docEmpty}>
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h4" />
                  </svg>
                  <p className={styles.docEmptyText}>Select a note to open it</p>
                  <button className={styles.docEmptyBtn} onClick={addNote}>New note</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
