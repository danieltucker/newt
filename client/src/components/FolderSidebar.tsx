import { useState, useEffect, useLayoutEffect, useRef, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext, closestCenter,
  DragEndEvent, DragOverlay, DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, rectSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import styles from './FolderSidebar.module.css';
import { Folder, Bookmark } from '../types';
import { bookmarkHref, faviconUrl } from '../utils/color';
import { useDragSensors } from '../hooks/useDragSensors';

type Layout = 'panel' | 'inline';

interface Props {
  folders: Folder[];
  activeFolderId: string | null;
  bookmarksByFolder: Record<string, Bookmark[]>;
  pinnedBookmarks: Bookmark[];
  layout: Layout;
  username: string;
  bookmarkOpenMode?: 'same-tab' | 'new-tab';
  onSelectFolder: (id: string, el: HTMLElement) => void;
  onNewFolder: () => void;
  onNewBookmark: () => void;
  onEditFolder: (f: Folder) => void;
  onDeleteFolder: (id: string) => void;
  onMarkFolderRead: (id: string) => void;
  onReorderFolders: (reordered: Folder[]) => void;
  onEditBookmark: (b: Bookmark) => void;
  onDeleteBookmark: (id: string) => void;
  onVisitBookmark: (id: string) => void;
  onPinBookmark: (id: string) => void;
  onUnpinBookmark: (id: string) => void;
  onReorderPinned: (reordered: Bookmark[]) => void;
  onReorderBookmarks: (folderId: string, reordered: Bookmark[]) => void;
  folderRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  /**
   * Whether to render the pinned tiles at the top. False inside the navigation
   * rail, which renders them itself at the head of its bookmarks group.
   */
  showPinned?: boolean;
}

/**
 * dnd-kit's DragOverlay, portalled to the body.
 *
 * The overlay is `position: fixed`, and the rail's column carries a
 * backdrop-filter - which makes that column the containing block for anything
 * fixed inside it. Rendered in place, the card you are dragging is therefore
 * positioned against the rail rather than the viewport, so it hangs tens of
 * pixels away from the cursor and drifts further the further down the page the
 * rail has scrolled. Measured at 80px on a folder row: the overlay reported
 * `top: 368px` and identity transform while painting at y=448.
 *
 * ShellBar's mobile sheet walked into the same wall for the same reason; this
 * is the same answer. The portal is called from inside the DndContext subtree,
 * so React context still reaches the overlay.
 */
function PortalDragOverlay({ children }: { children: ReactNode }) {
  return createPortal(<DragOverlay>{children}</DragOverlay>, document.body);
}

// Shared outside-click behaviour for the ··· dropdowns.
function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open, onClose]);
  return ref;
}

function FolderMenu({ folder, onEdit, onDelete, onMarkRead }: { folder: Folder; onEdit: (f: Folder) => void; onDelete: (id: string) => void; onMarkRead: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useOutsideClose(open, () => setOpen(false));

  return (
    <div className={styles.menuWrap} ref={menuRef}>
      <button
        className={styles.menuTrigger}
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        onPointerDown={e => e.stopPropagation()}
        aria-label="Folder options"
      >
        ···
      </button>
      {open && (
        <div className={styles.dropdown}>
          <button className={styles.dropdownItem} onClick={e => { e.stopPropagation(); setOpen(false); onMarkRead(folder.id); }} onPointerDown={e => e.stopPropagation()}>
            Mark as read
          </button>
          <button className={styles.dropdownItem} onClick={e => { e.stopPropagation(); setOpen(false); onEdit(folder); }} onPointerDown={e => e.stopPropagation()}>
            Edit
          </button>
          <button className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`} onClick={e => { e.stopPropagation(); setOpen(false); onDelete(folder.id); }} onPointerDown={e => e.stopPropagation()}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

interface SortableFolderProps {
  folder: Folder;
  isActive: boolean;
  expanded?: boolean;
  onSelect: (id: string, el: HTMLElement) => void;
  onEdit: (f: Folder) => void;
  onDelete: (id: string) => void;
  onMarkRead: (id: string) => void;
  folderRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
}

function SortableFolder({
  folder, isActive, expanded,
  onSelect, onEdit, onDelete, onMarkRead, folderRefs,
}: SortableFolderProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id });

  // Stable, deliberately. An inline `ref={el => ...}` is a new function on every
  // render, so React tears the ref down and sets it up again each time - and
  // dnd-kit, whose setNodeRef this wraps, de-registers and re-measures the node
  // with it. That was survivable while this list only re-rendered when its data
  // changed. It stopped being survivable when the travelling marker started
  // re-rendering it on hover: a drag re-renders continuously, so every folder
  // was being re-registered mid-gesture and the drop landed wherever the
  // half-rebuilt measurements pointed.
  const setRefs = useCallback((el: HTMLDivElement | null) => {
    setNodeRef(el);
    folderRefs.current[folder.id] = el;
  }, [setNodeRef, folderRefs, folder.id]);

  return (
    <div
      ref={setRefs}
      className={[
        styles.folderItem,
        isActive ? styles.active : '',
        isDragging ? styles.dragging : '',
      ].filter(Boolean).join(' ')}
      style={{
        '--folder-color': folder.color,
        transform: CSS.Transform.toString(transform),
        transition,
      } as React.CSSProperties}
      onClick={e => onSelect(folder.id, e.currentTarget)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(folder.id, e.currentTarget); }}
      {...attributes}
      {...listeners}
    >
      {/* Colour only. The dot used to swell into a pill carrying the folder's
          unread count, which put a number on every row whether or not anyone
          had asked what it was - and a rail full of counts reads as a dashboard
          rather than a list of places to go. */}
      <span className={styles.folderDot} />

      <span className={styles.folderName}>{folder.name}</span>

      {/* The whole hover state. There is no highlight behind the row any more -
          this nudges right and brightens instead, which is enough to say "this
          one" and quiet enough to say nothing at all when the pointer is
          elsewhere. Rendered in both layouts: inline uses it to mean "opens
          here" and rotates it when it does, panel to mean "opens on the right",
          and a row with no affordance at all in one of the two would read as
          the layout having forgotten something. */}
      <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} aria-hidden>
        ›
      </span>

      <FolderMenu folder={folder} onEdit={onEdit} onDelete={onDelete} onMarkRead={onMarkRead} />
    </div>
  );
}

// A bookmark listed vertically under an expanded folder (inline layout).
// Draggable within its folder - the drag listeners ride the link, so a click
// still opens it (the 8px activation distance separates click from drag).
function InlineBookmarkRow({ bookmark, openMode, onOpen, onEdit, onDelete, onPin }: {
  bookmark: Bookmark;
  openMode: 'same-tab' | 'new-tab';
  onOpen: (id: string) => void;
  onEdit: (b: Bookmark) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const menuRef = useOutsideClose(menuOpen, () => setMenuOpen(false));
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bookmark.id });

  return (
    <div
      ref={setNodeRef}
      className={`${styles.inlineRow} ${isDragging ? styles.inlineRowDragging : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <a
        href={bookmarkHref(bookmark.domain)}
        className={styles.inlineLink}
        onClick={() => onOpen(bookmark.id)}
        {...(openMode === 'new-tab' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...attributes}
        {...listeners}
      >
        <span className={styles.inlineFaviconWrap}>
          <span className={styles.inlineMonogram} style={{ color: bookmark.color }}>
            {bookmark.name.charAt(0).toUpperCase()}
          </span>
          {!faviconFailed && (
            <img className={styles.inlineFavicon} src={faviconUrl(bookmark.domain)} alt="" onError={() => setFaviconFailed(true)} />
          )}
        </span>
        <span className={styles.inlineName}>{bookmark.name}</span>
      </a>
      <div className={styles.menuWrap} ref={menuRef}>
        <button
          className={styles.menuTrigger}
          aria-label="Bookmark options"
          onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
        >
          ···
        </button>
        {menuOpen && (
          <div className={styles.dropdown}>
            <button className={styles.dropdownItem} onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onPin(bookmark.id); }}>
              Pin to top
            </button>
            <button className={styles.dropdownItem} onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onEdit(bookmark); }}>
              Edit
            </button>
            <button className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`} onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onDelete(bookmark.id); }}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// The expanded bookmark list under a folder, with its own drag context so a
// bookmark can be reordered within its folder. It's nested inside the folder
// sidebar's context, but the two never conflict: each sortable node carries only
// its own context's listeners.
function InlineBookmarkList({ folderId, sites, openMode, onReorder, onOpen, onEdit, onDelete, onPin }: {
  folderId: string;
  sites: Bookmark[];
  openMode: 'same-tab' | 'new-tab';
  onReorder: (folderId: string, reordered: Bookmark[]) => void;
  onOpen: (id: string) => void;
  onEdit: (b: Bookmark) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useDragSensors(8);

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = sites.findIndex(b => b.id === active.id);
    const newIndex = sites.findIndex(b => b.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(folderId, arrayMove(sites, oldIndex, newIndex));
  }

  const activeBookmark = activeId ? sites.find(b => b.id === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e: DragStartEvent) => setActiveId(e.active.id as string)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={sites.map(b => b.id)} strategy={verticalListSortingStrategy}>
        {sites.map(b => (
          <InlineBookmarkRow
            key={b.id}
            bookmark={b}
            openMode={openMode}
            onOpen={onOpen}
            onEdit={onEdit}
            onDelete={onDelete}
            onPin={onPin}
          />
        ))}
      </SortableContext>
      <PortalDragOverlay>
        {activeBookmark ? (
          <div className={`${styles.inlineRow} ${styles.inlineDragOverlay}`}>
            <span className={styles.inlineLink}>
              <span className={styles.inlineFaviconWrap}>
                <span className={styles.inlineMonogram} style={{ color: activeBookmark.color }}>
                  {activeBookmark.name.charAt(0).toUpperCase()}
                </span>
                <img className={styles.inlineFavicon} src={faviconUrl(activeBookmark.domain)} alt="" />
              </span>
              <span className={styles.inlineName}>{activeBookmark.name}</span>
            </span>
          </div>
        ) : null}
      </PortalDragOverlay>
    </DndContext>
  );
}

// A pinned bookmark tile in the top grid. Pinned bookmarks keep their folder;
// unpinning simply returns them to it.
function PinnedTile({ bookmark, openMode, onOpen, onEdit, onDelete, onUnpin }: {
  bookmark: Bookmark;
  openMode: 'same-tab' | 'new-tab';
  onOpen: (id: string) => void;
  onEdit: (b: Bookmark) => void;
  onDelete: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bookmark.id });
  const [menuOpen, setMenuOpen] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const menuRef = useOutsideClose(menuOpen, () => setMenuOpen(false));

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div className={`${styles.pinTileWrap} ${isDragging ? styles.dragging : ''}`} ref={setNodeRef} style={style}>
      <a
        href={bookmarkHref(bookmark.domain)}
        className={styles.pinTile}
        // The bookmark's colour, for the whole tile rather than the plate behind
        // its icon - see .pinTile. Everything the tile tints reads off this.
        style={{ '--tile-tint': bookmark.color } as React.CSSProperties}
        onClick={() => onOpen(bookmark.id)}
        {...(openMode === 'new-tab' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...attributes}
        {...listeners}
      >
        <span className={styles.pinFaviconWrap}>
          <span className={styles.pinMonogram} style={{ color: bookmark.color }}>
            {bookmark.name.charAt(0).toUpperCase()}
          </span>
          {!faviconFailed && (
            <img className={styles.pinFavicon} src={faviconUrl(bookmark.domain)} alt="" onError={() => setFaviconFailed(true)} />
          )}
        </span>
        <span className={styles.pinName}>{bookmark.name}</span>
      </a>
      <div className={styles.menuWrap} ref={menuRef}>
        <button
          className={styles.pinMenuTrigger}
          aria-label="Pinned bookmark options"
          onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
          onPointerDown={e => e.stopPropagation()}
        >
          ···
        </button>
        {menuOpen && (
          <div className={styles.dropdown}>
            <button className={styles.dropdownItem} onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onUnpin(bookmark.id); }}>
              Unpin
            </button>
            <button className={styles.dropdownItem} onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onEdit(bookmark); }}>
              Edit
            </button>
            <button className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`} onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onDelete(bookmark.id); }}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The pinned-bookmark tiles.
 *
 * Exported because the navigation rail renders these itself, above its list of
 * destinations, rather than letting them ride at the top of the folder tree.
 * The rail's tree follows whichever place you are on, and pinned links have to
 * survive that - see the `pinned` prop on ShellRail for the whole argument.
 */
export function PinGrid({ pinned, openMode, onOpen, onEdit, onDelete, onUnpin, onReorder }: {
  pinned: Bookmark[];
  openMode: 'same-tab' | 'new-tab';
  onOpen: (id: string) => void;
  onEdit: (b: Bookmark) => void;
  onDelete: (id: string) => void;
  onUnpin: (id: string) => void;
  onReorder: (reordered: Bookmark[]) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useDragSensors(6);

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = pinned.findIndex(b => b.id === active.id);
    const newIndex = pinned.findIndex(b => b.id === over.id);
    onReorder(arrayMove(pinned, oldIndex, newIndex));
  }

  const activePin = activeId ? pinned.find(b => b.id === activeId) : null;

  return (
    <div className={styles.pinSection}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e: DragStartEvent) => setActiveId(e.active.id as string)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={pinned.map(b => b.id)} strategy={rectSortingStrategy}>
          <div className={styles.pinGrid}>
            {pinned.map(b => (
              <PinnedTile
                key={b.id}
                bookmark={b}
                openMode={openMode}
                onOpen={onOpen}
                onEdit={onEdit}
                onDelete={onDelete}
                onUnpin={onUnpin}
              />
            ))}
          </div>
        </SortableContext>
        <PortalDragOverlay>
          {activePin ? (
            <div className={`${styles.pinTileWrap} ${styles.pinDragOverlay}`}>
              <div className={styles.pinTile}>
                <span className={styles.pinFaviconWrap} style={{ background: `color-mix(in oklab, ${activePin.color} 14%, var(--surface2))` }}>
                  <span className={styles.pinMonogram} style={{ color: activePin.color }}>{activePin.name.charAt(0).toUpperCase()}</span>
                  <img className={styles.pinFavicon} src={faviconUrl(activePin.domain)} alt="" />
                </span>
                <span className={styles.pinName}>{activePin.name}</span>
              </div>
            </div>
          ) : null}
        </PortalDragOverlay>
      </DndContext>
    </div>
  );
}

export default function FolderSidebar({
  folders, activeFolderId, bookmarksByFolder, pinnedBookmarks, layout, username, bookmarkOpenMode = 'same-tab',
  onSelectFolder, onNewFolder, onNewBookmark, onEditFolder, onDeleteFolder, onMarkFolderRead, onReorderFolders,
  onEditBookmark, onDeleteBookmark, onVisitBookmark, onPinBookmark, onUnpinBookmark, onReorderPinned,
  onReorderBookmarks, folderRefs, showPinned = true,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const isInline = layout === 'inline';

  // On mobile the sidebar is cramped, so only one folder may be open at a time
  // (accordion). Desktop keeps multi-expand.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Which folders are expanded in inline layout - persisted per user.
  const EXP_KEY = `sidebarExpanded_${username}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXP_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(EXP_KEY, JSON.stringify([...expanded])); } catch {}
  }, [expanded, EXP_KEY]);

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const isOpen = prev.has(id);
      // Mobile: accordion - collapse everything else when opening a folder.
      if (isMobile) return isOpen ? new Set() : new Set([id]);
      const next = new Set(prev);
      if (isOpen) next.delete(id); else next.add(id);
      return next;
    });
  }

  const sensors = useDragSensors(8);

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = folders.findIndex(f => f.id === active.id);
    const newIndex = folders.findIndex(f => f.id === over.id);
    onReorderFolders(arrayMove(folders, oldIndex, newIndex));
  }

  const activeFolder = activeId ? folders.find(f => f.id === activeId) : null;

  function handleFolderClick(id: string, el: HTMLElement) {
    if (isInline) {
      toggleExpanded(id);
      onSelectFolder(id, el); // keep RSS on the right in sync with the last-opened folder
    } else {
      onSelectFolder(id, el);
    }
  }

  return (
    <div className={`${styles.sidebar} ${isInline ? styles.inline : ''}`}>
      {showPinned && pinnedBookmarks.length > 0 && (
        <PinGrid
          pinned={pinnedBookmarks}
          openMode={bookmarkOpenMode}
          onOpen={onVisitBookmark}
          onEdit={onEditBookmark}
          onDelete={onDeleteBookmark}
          onUnpin={onUnpinBookmark}
          onReorder={onReorderPinned}
        />
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={folders.map(f => f.id)} strategy={verticalListSortingStrategy}>
          {folders.map(folder => {
            const sites = bookmarksByFolder[folder.id] || [];
            const isOpen = isInline && expanded.has(folder.id);
            return (
              <div key={folder.id} className={styles.folderGroup}>
                <SortableFolder
                  folder={folder}
                  isActive={folder.id === activeFolderId}
                  expanded={isOpen}
                  onSelect={handleFolderClick}
                  onEdit={onEditFolder}
                  onDelete={onDeleteFolder}
                  onMarkRead={onMarkFolderRead}
                  folderRefs={folderRefs}
                />
                {isOpen && (
                  <div className={styles.inlineList}>
                    {sites.length === 0 ? (
                      <div className={styles.inlineEmpty}>No bookmarks</div>
                    ) : (
                      <InlineBookmarkList
                        folderId={folder.id}
                        sites={sites}
                        openMode={bookmarkOpenMode}
                        onReorder={onReorderBookmarks}
                        onOpen={onVisitBookmark}
                        onEdit={onEditBookmark}
                        onDelete={onDeleteBookmark}
                        onPin={onPinBookmark}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </SortableContext>

        <PortalDragOverlay>
          {activeFolder ? (
            <div className={`${styles.folderItem} ${styles.dragOverlay}`}
              style={{ '--folder-color': activeFolder.color } as React.CSSProperties}
            >
              <span className={styles.folderDot} />
              <span className={styles.folderName}>{activeFolder.name}</span>
            </div>
          ) : null}
        </PortalDragOverlay>
      </DndContext>

      <div className={styles.sidebarFooter}>
        <button className={styles.newFolder} onClick={onNewFolder}>
          + New folder
        </button>
        <button className={styles.newFolder} onClick={onNewBookmark}>
          + New bookmark
        </button>
      </div>
    </div>
  );
}
