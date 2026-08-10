import { useState, useRef, useEffect, Fragment, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';
import styles from './SaveButton.module.css';

// The one "save this article" control, shared by the feed cards and the reading
// list cards.
//
// It is a split button, because saving has a default and a choice and those
// used to be two different buttons in two different corners: a small icon that
// filed instantly, and a "Save to…" that opened a picker. Pressing the label
// saves to the obvious place; the caret is there when it isn't the place you
// wanted. Nothing about it is destructive - every surface that uses it leaves an
// Undo behind - so the default committing on one press is safe.
//
// Sized as a pill to match CommentBar, which sits beside it on every card.

export interface SaveDestination {
  /** Stable key, handed straight back to onSelect. */
  id: string;
  label: string;
  /** Heading this item files under. Consecutive items sharing one are grouped. */
  group?: string;
  /** Small right-hand note - "Default", or where the article is now. */
  hint?: string;
}

interface Props {
  /** The main segment's label. Short - it sits next to a comment pill. */
  label: string;
  /** Which destination the main segment commits to. */
  defaultId: string;
  destinations: SaveDestination[];
  onSelect: (id: string) => void;
  icon: ReactNode;
  /** Marked as current in the menu - where the article already lives. */
  currentId?: string;
  /** Heading over the menu, and the caret's accessible name. */
  menuLabel?: string;
  className?: string;
  /**
   * Offered as a last row in the menu when present: make a destination by this
   * name and save into it. Naming one is a decision about *this* article, so it
   * happens here rather than sending you off to the Library to make a folder
   * and come back.
   *
   * Create and save are one call rather than "resolve an id, then onSelect it",
   * because the new destination is by definition not in `destinations` yet -
   * this button would be selecting an id it cannot name. Rejecting leaves the
   * menu open with the typed name intact.
   */
  onCreateDestination?: (name: string) => Promise<void>;
  createLabel?: string;
}

function CaretIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4.5L6 8l3.5-3.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className={styles.check} width="11" height="11" viewBox="0 0 12 12" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 6.5L4.5 9.5 10.5 2.5" />
    </svg>
  );
}

export default function SaveButton({
  label, defaultId, destinations, onSelect, icon, currentId,
  menuLabel = 'Save to…', className = '',
  onCreateDestination, createLabel = 'New folder…',
}: Props) {
  const [open, setOpen] = useState(false);
  // The name being typed, or null while the row is still just a row.
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * On a phone the menu is a sheet at the bottom of the screen, not a popover
   * hanging off the button.
   *
   * As a popover it did neither of the things a menu has to do. It opens
   * upward, because the button sits at the foot of a card - and the card lists
   * it opens over scroll inside a box, so a card near the top of that box had
   * its menu cropped by the box's own edge. What you saw instead was the view
   * jumping: focusing the first item scrolled the list to bring the clipped
   * menu into range, and the scroll handler below - which is there so a menu
   * never floats over a list that has moved on - then closed the thing that had
   * just caused the scroll. One tap, a lurch, and nothing open.
   *
   * A sheet is fixed to the viewport, so there is nothing to clip it and
   * nothing to scroll it into view, and it puts a list of folders where a thumb
   * can reach it rather than at the top of the reach.
   */
  const asSheet = useMediaQuery('(max-width: 640px)');

  const target = destinations.find(d => d.id === defaultId) ?? destinations[0];

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      const t = e.target as Node;
      // The sheet is portalled to <body>, so it is not inside wrapRef.
      if (menuRef.current?.contains(t)) return;
      if (wrapRef.current && !wrapRef.current.contains(t)) setOpen(false);
    }
    // Cards move under you - a popover that stays put while the list it is
    // anchored to scrolls away is worse than one that closes. A sheet is
    // anchored to the screen instead, so this doesn't apply to it: closing on
    // scroll there would mean the on-screen keyboard, which scrolls the page
    // when the new-folder field takes focus, shutting the menu you opened it
    // from.
    function onScroll() { setOpen(false); }
    document.addEventListener('mousedown', onOutside);
    if (!asSheet) window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, asSheet]);

  // The menu is opened deliberately, so the first choice should be one keystroke
  // away rather than a tab away. `preventScroll` because moving focus is not a
  // request to move the page - see the note on `asSheet` for what that cost.
  useEffect(() => {
    if (open) menuRef.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [open]);

  // A closed menu forgets a half-typed folder name. Reopening to find one
  // waiting would be a draft nobody asked to keep.
  useEffect(() => {
    if (!open) { setNewName(null); setCreating(false); }
  }, [open]);

  function choose(id: string) {
    setOpen(false);
    onSelect(id);
  }

  // Naming a folder here is not filing under "somewhere to put things later",
  // it is filing this article - so the caller does both and this just closes.
  async function createAndSave() {
    const name = (newName ?? '').trim();
    if (!name || !onCreateDestination || creating) return;
    setCreating(true);
    try {
      await onCreateDestination(name);
      setOpen(false);
    } catch {
      // The menu stays up with the name intact, so it can be tried again
      setCreating(false);
    }
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // Escape backs out of the name field first, then out of the menu - one
      // key, one step, so it never closes more than you meant it to.
      if (newName !== null) { setNewName(null); return; }
      setOpen(false);
      caretRef.current?.focus();
    }
  }

  let lastGroup: string | undefined;

  const menuBody = (
    <>
      {destinations.map(d => {
        const heading = d.group && d.group !== lastGroup ? d.group : null;
        lastGroup = d.group;
        return (
          <Fragment key={d.id}>
            {heading && (
              <div className={styles.heading} role="presentation">{heading}</div>
            )}
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${d.id === currentId ? styles.itemCurrent : ''}`}
              onClick={() => choose(d.id)}
            >
              <span className={styles.itemLabel}>{d.label}</span>
              {d.id === currentId ? <CheckIcon />
                : d.hint ? <span className={styles.hint}>{d.hint}</span>
                : null}
            </button>
          </Fragment>
        );
      })}

      {onCreateDestination && (
        <>
          <div className={styles.sep} role="presentation" />
          {newName === null ? (
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${styles.itemNew}`}
              onClick={() => setNewName('')}
            >
              <span className={styles.plus} aria-hidden>+</span>
              <span className={styles.itemLabel}>{createLabel}</span>
            </button>
          ) : (
            <div className={styles.newRow}>
              <input
                className={styles.newInput}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Folder name"
                aria-label={createLabel}
                autoFocus
                disabled={creating}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void createAndSave(); } }}
              />
              <button
                type="button"
                className={styles.newGo}
                onClick={() => void createAndSave()}
                disabled={creating || !newName.trim()}
              >
                {creating ? '…' : 'Save'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );

  return (
    <div className={`${styles.wrap} ${className}`} ref={wrapRef}>
      <div className={styles.group}>
        <button
          type="button"
          className={styles.main}
          onClick={() => target && onSelect(target.id)}
          title={target ? `${menuLabel.replace(/…$/, '')} ${target.label}` : label}
        >
          <span className={styles.icon} aria-hidden>{icon}</span>
          <span className={styles.label}>{label}</span>
        </button>
        <button
          type="button"
          ref={caretRef}
          className={styles.caret}
          onClick={() => setOpen(v => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={menuLabel}
          title={menuLabel}
        >
          <CaretIcon />
        </button>
      </div>

      {open && !asSheet && (
        <div className={styles.menu} ref={menuRef} role="menu" onKeyDown={onMenuKeyDown}>
          {menuBody}
        </div>
      )}

      {/* Portalled to <body> so no card, list or dialog can crop it, and so the
          sheet is measured against the screen rather than against whatever the
          button happens to be sitting inside. */}
      {open && asSheet && createPortal(
        <div className={styles.sheetScrim} onClick={() => setOpen(false)}>
          <div
            className={styles.sheet}
            ref={menuRef}
            role="menu"
            aria-label={menuLabel}
            onKeyDown={onMenuKeyDown}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.sheetGrip} aria-hidden />
            <div className={styles.sheetTitle}>{menuLabel}</div>
            <div className={styles.sheetList}>{menuBody}</div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
