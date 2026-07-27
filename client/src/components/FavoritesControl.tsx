import { useState, useRef, useEffect } from 'react';
import { StarIcon } from './TagChip';
import { tagKey, hasFavorite } from '../utils/favoriteTags';
import styles from './FavoritesControl.module.css';

// The favorites chip, and the place you manage the list behind it.
//
// Two controls in one pill: the label filters the view down to matches, the
// caret opens the manager. Managing favorites shouldn't mean leaving the page
// you're reading - you notice a favorite is too broad *while* looking at the
// feed it's flooding, which is exactly when you want to fix it.
//
// The surface passes its own chip classes; the feed and the reading list style
// their filter rows differently and shouldn't be forced to agree.
export default function FavoritesControl({
  favorites, onChange, count, filterOn, onToggleFilter,
  chipClassName = '', chipActiveClassName = '',
}: {
  favorites: string[];
  onChange: (next: string[]) => void;
  /** How many items on screen match - the filter is pointless at zero. */
  count: number;
  filterOn: boolean;
  onToggleFilter: () => void;
  chipClassName?: string;
  chipActiveClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const wrapRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Same dismissal contract as the shell's menus: outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  function add() {
    const tag = draft.trim();
    setDraft('');
    // A tag with no word characters can never match, and a duplicate would sit
    // in the list doing nothing - both are silently declined.
    if (!tagKey(tag) || hasFavorite(favorites, tag)) return;
    onChange([...favorites, tag]);
  }

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <span className={`${chipClassName} ${filterOn ? chipActiveClassName : ''} ${styles.chip}`}>
        <button
          className={styles.filterBtn}
          onClick={onToggleFilter}
          disabled={count === 0}
          aria-pressed={filterOn}
          title={count === 0
            ? 'Nothing here matches your favorite tags'
            : 'Show only articles matching your favorite tags'}
        >
          <StarIcon filled className={styles.star} />
          Favorites
          <span className={styles.count}>{count}</span>
        </button>
        <button
          className={styles.caretBtn}
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Manage favorite tags"
        >
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>
      </span>

      {open && (
        <div className={styles.menu} role="dialog" aria-label="Manage favorite tags">
          <div className={styles.menuHead}>Favorite tags</div>
          <p className={styles.menuHint}>
            Matched by whole word - “Apple” also catches “Apple News” and “apple-tv”,
            but not “Snapple”.
          </p>

          <div className={styles.list}>
            {favorites.length === 0 && (
              <div className={styles.empty}>
                Nothing favorited yet. Star a tag on any article, or add one below.
              </div>
            )}
            {favorites.map(t => (
              <span key={t} className={styles.item}>
                <StarIcon filled className={styles.itemStar} />
                <span className={styles.itemLabel}>{t}</span>
                <button
                  className={styles.remove}
                  onClick={() => onChange(favorites.filter(f => f !== t))}
                  title={`Remove “${t}”`}
                  aria-label={`Remove ${t}`}
                >
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M1 1l10 10M11 1L1 11" />
                  </svg>
                </button>
              </span>
            ))}
          </div>

          <div className={styles.addRow}>
            <input
              ref={inputRef}
              className={styles.input}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder="Add a tag…"
              spellCheck={false}
              aria-label="Add a favorite tag"
            />
            <button className={styles.addBtn} onClick={add} disabled={!draft.trim()}>
              Add
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
