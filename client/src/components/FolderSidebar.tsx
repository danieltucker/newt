import { useState, useEffect, useRef } from 'react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  DragEndEvent, DragOverlay, DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, rectSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import styles from './FolderSidebar.module.css';
import { Folder, Bookmark } from '../types';
import { bookmarkHref, faviconUrl } from '../utils/color';

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
  sites: Bookmark[];
  expandable?: boolean;
  expanded?: boolean;
  onSelect: (id: string, el: HTMLElement) => void;
  onEdit: (f: Folder) => void;
  onDelete: (id: string) => void;
  onMarkRead: (id: string) => void;
  folderRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
}

function SortableFolder({ folder, isActive, sites, expandable, expanded, onSelect, onEdit, onDelete, onMarkRead, folderRefs }: SortableFolderProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id });
  const previewSites = sites.slice(0, 4);

  return (
    <div
      ref={el => { setNodeRef(el); folderRefs.current[folder.id] = el; }}
      className={`${styles.folderItem} ${isActive ? styles.active : ''} ${isDragging ? styles.dragging : ''}`}
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
      <div className={styles.preview}>
        {Array.from({ length: 4 }).map((_, i) => {
          const site = previewSites[i];
          return (
            <div key={i} className={styles.previewCell}>
              {site ? (
                <>
                  <img
                    className={styles.previewFavicon}
                    src={faviconUrl(site.domain)}
                    alt=""
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className={styles.previewMonogram} style={{ color: site.color }}>
                    {site.name.charAt(0).toUpperCase()}
                  </span>
                </>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className={styles.folderText}>
        <div className={styles.folderNameRow}>
          <span className={styles.colorDot} style={{ background: folder.color }} />
          <span className={styles.folderName}>{folder.name}</span>
          {(() => {
            const total = sites.reduce((s, b) => s + (b.unreadCount ?? 0), 0);
            return total > 0 ? (
              <span className={styles.folderUnread}>{total > 99 ? '∞' : total}</span>
            ) : null;
          })()}
        </div>
      </div>

      {expandable && (
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} aria-hidden>
          ›
        </span>
      )}

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
        {(bookmark.unreadCount ?? 0) > 0 && (
          <span className={styles.folderUnread}>{(bookmark.unreadCount ?? 0) > 99 ? '∞' : bookmark.unreadCount}</span>
        )}
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

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
      <DragOverlay>
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
      </DragOverlay>
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
    <div className={styles.pinTileWrap} ref={setNodeRef} style={style}>
      <a
        href={bookmarkHref(bookmark.domain)}
        className={styles.pinTile}
        onClick={() => onOpen(bookmark.id)}
        {...(openMode === 'new-tab' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...attributes}
        {...listeners}
      >
        <span className={styles.pinFaviconWrap} style={{ background: `color-mix(in oklab, ${bookmark.color} 14%, var(--surface2))` }}>
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

function PinGrid({ pinned, openMode, onOpen, onEdit, onDelete, onUnpin, onReorder }: {
  pinned: Bookmark[];
  openMode: 'same-tab' | 'new-tab';
  onOpen: (id: string) => void;
  onEdit: (b: Bookmark) => void;
  onDelete: (id: string) => void;
  onUnpin: (id: string) => void;
  onReorder: (reordered: Bookmark[]) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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
        <DragOverlay>
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
        </DragOverlay>
      </DndContext>
    </div>
  );
}

export default function FolderSidebar({
  folders, activeFolderId, bookmarksByFolder, pinnedBookmarks, layout, username, bookmarkOpenMode = 'same-tab',
  onSelectFolder, onNewFolder, onNewBookmark, onEditFolder, onDeleteFolder, onMarkFolderRead, onReorderFolders,
  onEditBookmark, onDeleteBookmark, onVisitBookmark, onPinBookmark, onUnpinBookmark, onReorderPinned,
  onReorderBookmarks, folderRefs,
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

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
      {pinnedBookmarks.length > 0 && (
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
                  sites={sites}
                  expandable={isInline}
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

        <DragOverlay>
          {activeFolder ? (
            <div className={`${styles.folderItem} ${styles.dragOverlay}`}
              style={{ '--folder-color': activeFolder.color } as React.CSSProperties}
            >
              <div className={styles.folderText}>
                <div className={styles.folderNameRow}>
                  <span className={styles.colorDot} style={{ background: activeFolder.color }} />
                  <span className={styles.folderName}>{activeFolder.name}</span>
                </div>
              </div>
            </div>
          ) : null}
        </DragOverlay>
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
