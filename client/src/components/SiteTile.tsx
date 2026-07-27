import { useRef, useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import styles from './SiteTile.module.css';
import { Bookmark } from '../types';
import { bookmarkHref, faviconUrl } from '../utils/color';

interface Props {
  bookmark: Bookmark;
  dragOverlay?: boolean;
  onEdit?: (b: Bookmark) => void;
  onDelete?: (id: string) => void;
  onVisit?: (id: string) => void;
  onPin?: (id: string) => void;
  openMode?: 'same-tab' | 'new-tab';
}

export default function SiteTile({ bookmark, dragOverlay, onEdit, onDelete, onVisit, onPin, openMode = 'same-tab' }: Props) {
  const unreadCount = bookmark.unreadCount ?? 0;
  const hasNewContent = unreadCount > 0;
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const tileRef = useRef<HTMLAnchorElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bookmark.id });

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [menuOpen]);

  const style = {
    background: `color-mix(in oklab, ${bookmark.color} ${isDragging ? '24%' : '15%'}, var(--surface))`,
    border: `1px solid color-mix(in oklab, ${bookmark.color} ${isDragging ? '48%' : '26%'}, transparent)`,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging && !dragOverlay ? 0.4 : 1,
    boxShadow: isDragging ? `0 20px 44px rgba(0,0,0,0.45)` : undefined,
    zIndex: isDragging ? 60 : undefined,
  };

  function handleClick(e: React.MouseEvent) {
    if (!tileRef.current) return;
    tileRef.current.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(0.9)', offset: 0.35 },
        { transform: 'scale(1.05)', offset: 0.7 },
        { transform: 'scale(1)' },
      ],
      { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' }
    );
    onVisit?.(bookmark.id);
  }

  return (
    <a
      ref={node => { setNodeRef(node); (tileRef as React.MutableRefObject<HTMLAnchorElement | null>).current = node; }}
      href={bookmarkHref(bookmark.domain)}
      className={styles.tile}
      style={style}
      onClick={handleClick}
      {...(openMode === 'new-tab' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...attributes}
      {...listeners}
    >
      <div className={styles.faviconWrap}>
        <div className={styles.faviconChip}>
          <span className={styles.monogram} style={{ color: bookmark.color }}>
            {bookmark.name.charAt(0).toUpperCase()}
          </span>
          {!faviconFailed && (
            <img
              className={styles.favicon}
              src={faviconUrl(bookmark.domain)}
              alt=""
              onError={() => setFaviconFailed(true)}
            />
          )}
        </div>
        {hasNewContent && (
          <span className={styles.feedBadge}>
            {unreadCount > 99 ? '∞' : unreadCount}
          </span>
        )}
      </div>
      <span className={styles.name}>{bookmark.name}</span>

      {(onEdit || onDelete || onPin) && (
        <div className={styles.menuWrap} ref={menuRef}>
          <button
            className={styles.menuTrigger}
            aria-label="Tile options"
            onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
            onPointerDown={e => e.stopPropagation()}
          >
            ···
          </button>
          {menuOpen && (
            <div className={styles.dropdown}>
              {onPin && (
                <button
                  className={styles.dropdownItem}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onPin(bookmark.id); }}
                >
                  Pin to top
                </button>
              )}
              {onEdit && (
                <button
                  className={styles.dropdownItem}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onEdit(bookmark); }}
                >
                  Edit
                </button>
              )}
              {onDelete && (
                <button
                  className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(false); onDelete(bookmark.id); }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </a>
  );
}
