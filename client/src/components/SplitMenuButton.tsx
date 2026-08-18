import { useState, useRef, useEffect, useLayoutEffect, CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';
import styles from './SplitMenuButton.module.css';

// A split button: a label that commits to the obvious thing, and a caret that
// opens the rest.
//
// This was SaveButton's, and it stayed SaveButton's for as long as saving was
// the only decision on a card with more than one answer. Once the comment pill
// beside it grew a menu too - Explore, Repost - keeping the popover/sheet
// machinery in one of them and copying it into the other would have meant two
// menus that agree today and drift by the next change. So the shell lives here
// and both cards' controls are the same control with different contents.
//
// What it owns: the pill geometry, open/close (including the two ways a menu on
// a scrolling card gets closed out from under you), and the popover-vs-sheet
// choice. What it doesn't: anything about what the menu is *for*. Callers build
// their own rows out of MenuItem/MenuHeading/MenuSeparator below.

interface Props {
  /** The main segment's label. Short - it sits next to another pill. */
  label: string;
  /**
   * A tail on the label that a narrow card is allowed to drop - the word in
   * "3 comments", leaving the 3. See the collapse note in the stylesheet.
   */
  labelExtra?: string;
  icon?: ReactNode;
  /** What pressing the label does. */
  onPrimary: () => void;
  /**
   * Draws the pill as switched on rather than at rest, for a label that reports
   * a state instead of offering an action - Save, once the article is saved.
   * Hover already lights the pill this way; this is the same look, held.
   */
  active?: boolean;
  /** Tooltip on the label half. The caret's is `menuLabel`. */
  primaryTitle?: string;
  /** Heading over the menu, the sheet's title, and the caret's accessible name. */
  menuLabel: string;
  className?: string;
  /**
   * The menu's rows. `close` shuts the menu - a row that acts calls it, a row
   * that only opens a field inside the menu (see SaveButton) doesn't.
   */
  menu: (close: () => void) => ReactNode;
  /**
   * Fired as the menu opens and closes, for callers holding state that belongs
   * to one opening of it - a half-typed folder name, say.
   */
  onOpenChange?: (open: boolean) => void;
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

/** A heading over a run of rows. Presentational - not a focus stop. */
export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className={styles.heading} role="presentation">{children}</div>;
}

export function MenuSeparator() {
  return <div className={styles.sep} role="presentation" />;
}

export function MenuItem({ label, icon, hint, current, muted, onClick }: {
  label: string;
  icon?: ReactNode;
  /** Small right-hand note - "Default", or where the thing is now. */
  hint?: string;
  /** Marked as the row you are already on. Replaces the hint with a tick. */
  current?: boolean;
  /** A row that makes something rather than picking something. */
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={[
        styles.item,
        current ? styles.itemCurrent : '',
        muted ? styles.itemMuted : '',
      ].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      {icon && <span className={styles.itemIcon} aria-hidden>{icon}</span>}
      <span className={styles.itemLabel}>{label}</span>
      {current ? <CheckIcon />
        : hint ? <span className={styles.hint}>{hint}</span>
        : null}
    </button>
  );
}

export default function SplitMenuButton({
  label, labelExtra, icon, onPrimary, active = false, primaryTitle, menuLabel,
  className = '', menu, onOpenChange,
}: Props) {
  const [open, setOpen] = useState(false);
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
   * nothing to scroll it into view, and it puts the choices where a thumb can
   * reach them rather than at the top of the reach.
   */
  const asSheet = useMediaQuery('(max-width: 640px)');

  /**
   * Where the popover goes, in viewport coordinates.
   *
   * It is portalled and fixed rather than absolutely positioned inside the
   * button, for the same reason the sheet is: an absolute menu is cropped by any
   * ancestor that scrolls, and these buttons live at the foot of things that
   * scroll. In the article reader that produced a menu with its top half sliced
   * off under the toolbar, which read as the menu opening *behind* the close
   * button. Nothing about the arithmetic below fixes that - being out of the
   * scrolling box is what fixes it.
   *
   * Measured once, when the menu opens. It cannot go stale: any scroll closes
   * the menu, which is the rule that was already here, and so does a resize.
   */
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open || asSheet) { setMenuPos(null); return; }
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const edge = 8;
    // What a menu with a few destinations and a new-folder row wants. Only used
    // to choose a side; the max-height below is what actually holds it in.
    const wanted = 260;
    const above = r.top - gap - edge;
    const below = window.innerHeight - r.bottom - gap - edge;
    // Upward by preference - the button sits at the foot of a card, so downward
    // would put the menu over the next card, or off the end of the last row.
    // Downward only when up is genuinely too tight and down is better.
    const up = above >= Math.min(wanted, below) || above >= wanted;
    setMenuPos({
      // Right-aligned with the button, as it was, and never past the edge.
      right: Math.max(edge, window.innerWidth - r.right),
      ...(up
        ? { bottom: window.innerHeight - r.top + gap, maxHeight: above }
        : { top: r.bottom + gap, maxHeight: below }),
    });
  }, [open, asSheet]);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      const t = e.target as Node;
      // Both the popover and the sheet are portalled to <body>, so neither is
      // inside wrapRef and both have to be asked separately.
      if (menuRef.current?.contains(t)) return;
      if (wrapRef.current && !wrapRef.current.contains(t)) setOpen(false);
    }
    // Cards move under you - a popover measured against a button that has since
    // scrolled away is worse than no popover. A sheet is anchored to the screen
    // instead, so this doesn't apply to it: closing on scroll there would mean
    // the on-screen keyboard, which scrolls the page when a field inside the
    // sheet takes focus, shutting the menu you opened it from.
    function onMoved() { setOpen(false); }
    document.addEventListener('mousedown', onOutside);
    if (!asSheet) {
      window.addEventListener('scroll', onMoved, true);
      window.addEventListener('resize', onMoved);
    }
    return () => {
      document.removeEventListener('mousedown', onOutside);
      window.removeEventListener('scroll', onMoved, true);
      window.removeEventListener('resize', onMoved);
    };
  }, [open, asSheet]);

  // The menu is opened deliberately, so the first choice should be one keystroke
  // away rather than a tab away. `preventScroll` because moving focus is not a
  // request to move the page - see the note on `asSheet` for what that cost.
  useEffect(() => {
    if (open) menuRef.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [open]);

  // Through a ref, and keyed on `open` alone: callers pass this inline, so a
  // dependency on the function itself would fire it on every render - which for
  // the caller that uses it to clear a field would clear the field on every
  // keystroke typed into it.
  const openChangeRef = useRef(onOpenChange);
  useEffect(() => { openChangeRef.current = onOpenChange; }, [onOpenChange]);
  useEffect(() => { openChangeRef.current?.(open); }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    // Rows that hold their own transient state stop this event before it gets
    // here, so Escape backs out of one step at a time rather than closing more
    // than you meant it to.
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      caretRef.current?.focus();
    }
  }

  // Only while it is up: a closed menu's rows are not worth building, and some
  // of them cost a lookup to build.
  const body = open ? menu(() => setOpen(false)) : null;

  return (
    <div className={`${styles.wrap} ${className}`} ref={wrapRef}>
      {/* The open state is a class rather than :focus-within, because focus is
          inside a menu that now lives in <body> - the pill would go grey the
          moment its own menu took focus. */}
      <div className={[
        styles.group,
        open ? styles.groupOpen : '',
        active ? styles.groupOn : '',
      ].filter(Boolean).join(' ')}>
        <button
          type="button"
          className={styles.main}
          onClick={onPrimary}
          title={primaryTitle}
          // Spelled out rather than left to whatever survived the collapse: on
          // a narrow card the visible text is a number, or nothing at all, and
          // the button's name should not change with the width of the card it
          // happens to be in.
          aria-label={labelExtra ? `${label} ${labelExtra}` : label}
        >
          {icon && <span className={styles.icon} aria-hidden>{icon}</span>}
          <span className={styles.label} aria-hidden>
            {label}
            {/* The space lives inside the span, so it goes when the word does
                and the pill doesn't keep a gap where the label was. */}
            {labelExtra && <span className={styles.labelExtra}> {labelExtra}</span>}
          </span>
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

      {/* Both forms are portalled to <body> so no card, list or dialog can crop
          them, and so each is measured against the screen rather than against
          whatever the button happens to be sitting inside. */}
      {open && !asSheet && menuPos && createPortal(
        <div
          className={styles.menu}
          style={menuPos}
          ref={menuRef}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={onMenuKeyDown}
        >
          {body}
        </div>,
        document.body,
      )}

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
            <div className={styles.sheetList}>{body}</div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
