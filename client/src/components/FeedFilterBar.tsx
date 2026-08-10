import { useState, useEffect, useRef } from 'react';
import { StarIcon } from './TagChip';
import { useMediaQuery } from '../hooks/useMediaQuery';
import styles from './FeedFilterBar.module.css';

/**
 * Where one chip per group stops fitting and they fold into a single Filters
 * menu. Deliberately generous: below this the bar shares its row with a layout
 * switch and an Add button on the reading list, and three labelled chips plus
 * their selections is what tipped that row into wrapping.
 *
 * A viewport query rather than a measurement of the bar itself, because both
 * surfaces that use it are as wide as the window (the feed column, the reading
 * list's full-bleed modal) - so the window is a fair proxy, and it costs no
 * layout pass to ask.
 */
const EXPAND_AT = 900;

/**
 * Beyond this many groups the row is too busy to spread out whatever the width,
 * so it folds regardless. Nothing passes more than three today; this is here so
 * that a fourth doesn't quietly make the bar the loudest thing on the page.
 */
const EXPAND_MAX_GROUPS = 3;

/** The group list itself, as an `openId`. Only the folded bar has one. */
const ROOT = '__root';

export interface FilterOption {
  value: string;
  label: string;
  /** Shown right-aligned — a count, a hostname, whatever qualifies the row. */
  hint?: string;
  /** Category swatches use this; sites and topics don't have one. */
  color?: string;
  /** Whether this option is a favourite. Only read when the group is starrable. */
  starred?: boolean;
  /** Why it counts as starred, when a broader favourite is what matched it. */
  starTitle?: string;
}

export interface FilterGroup {
  /** Stable key, used for the active-pill labels. */
  id: string;
  label: string;
  /** What "no selection" reads as in the menu — "All sites", "All topics". */
  allLabel: string;
  options: FilterOption[];
  value: string | null;
  onChange: (v: string | null) => void;
  /** Adds a search box once the list gets long enough to need one. */
  searchable?: boolean;
  /**
   * Makes each row's label a star as well as a filter.
   *
   * The reading list needs this: folding its tags into a dropdown would
   * otherwise take away the only place you can favourite one, since the tags
   * printed on a card there aren't buttons. Starring deliberately does NOT close
   * the panel — you're curating a list, not picking from it.
   */
  onToggleStar?: (value: string) => void;
}

interface Props {
  groups: FilterGroup[];
  /** Read state only exists when read-on-scroll is on, so this is optional. */
  unread?: { count: number; active: boolean; onToggle: () => void };
  /** The favourites toggle keeps its own control (it manages a list too). */
  favorites?: React.ReactNode;
  /**
   * Spacing, and nothing else. The bar carries no margin of its own because it
   * is sometimes a row (the feed, where it needs a gap to the grid below) and
   * sometimes one item inside a row (the reading list's toolbar, where a margin
   * would knock it off the shared centre line).
   */
  className?: string;
}

const ChevronIcon = () => (
  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 4.5L6 8l3.5-3.5" />
  </svg>
);

const FilterIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 5h18M6 12h12M10 19h4" />
  </svg>
);

const XIcon = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M1 1l10 10M11 1L1 11" />
  </svg>
);

/**
 * One place to narrow the feed.
 *
 * Category, site and topic used to be three separate chips sitting beside a row
 * of every topic in the feed, which meant the controls were both scattered and
 * the loudest thing on the page. They're one dropdown now: what you've actually
 * chosen shows as removable pills, and everything you haven't stays folded away.
 * Unread keeps its own chip because it carries a count and is the one filter
 * people reach for without thinking.
 *
 * Everything in here changes what you are looking at and nothing in here writes
 * anything. It used to carry an `actions` slot for the feed's buttons too, which
 * put "Mark all read" in the same row, in the same dress, as a filter chip - one
 * of those is undoable and the other is not. The feed lays its actions out
 * itself now, above this bar; see the controlBar note in FeedPanel.
 *
 * ── Two shapes, one control ──
 * Folding everything behind one button is the right answer on a phone and a
 * needless extra tap on a desktop, where there is room to put Category, Site and
 * Topic side by side and show what each is set to without opening anything. So
 * above EXPAND_AT each group gets its own chip and its own dropdown, and below
 * it they collapse back into the Filters menu and its drill-down.
 *
 * The two shapes share their option list (`optionsFor`) and their open/close
 * state (`openId`), so they can't drift apart: only the trigger differs.
 */
export default function FeedFilterBar({ groups, unread, favorites, className = '' }: Props) {
  // Which popover is showing. In the folded bar that's ROOT for the group list
  // or a group id once you've drilled into one; spread out, it's just the id of
  // the chip you clicked. Sharing one value is what lets both shapes reuse the
  // same list and the same dismiss handling.
  const [openId, setOpenId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery(`(min-width: ${EXPAND_AT}px)`);

  useEffect(() => {
    if (openId === null) return;
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  // Only groups with something to choose between are worth showing: a feed from
  // a single site has no site filter worth opening.
  const usable = groups.filter(g => g.options.length > 1 || g.value !== null);
  const active = usable.filter(g => g.value !== null);
  const expanded = wide && usable.length > 0 && usable.length <= EXPAND_MAX_GROUPS;

  // Rotating the phone or dragging the window across EXPAND_AT moves the anchor
  // the panel is hanging off, and a panel left open through that lands next to a
  // chip that is no longer the one you pressed.
  useEffect(() => { setOpenId(null); }, [expanded]);

  function close() { setOpenId(null); setQ(''); }

  function toggle(id: string) {
    setOpenId(prev => (prev === id ? null : id));
    setQ('');
  }

  /** The folded bar's trigger: pressing it again shuts the menu, even from two
   *  levels in. `toggle(ROOT)` would walk you back to the group list instead,
   *  which is what the back row inside the panel is for. */
  function toggleRoot() {
    setOpenId(prev => (prev === null ? ROOT : null));
    setQ('');
  }

  function labelFor(group: FilterGroup): string {
    return group.options.find(o => o.value === group.value)?.label ?? group.value ?? '';
  }

  if (usable.length === 0 && !unread && !favorites) return null;

  const current = usable.find(g => g.id === openId) ?? null;
  const filtered = current && q.trim()
    ? current.options.filter(o => o.label.toLowerCase().includes(q.trim().toLowerCase()))
    : current?.options ?? [];

  /**
   * The rows you pick from, identical in both shapes. Only what sits above them
   * differs: the folded bar puts a back row there, the spread-out one nothing,
   * because its chip is already the thing you'd be going back to.
   */
  function optionsFor(group: FilterGroup) {
    return (
      <>
        {group.searchable && (
          <input
            className={styles.search}
            placeholder="Search…"
            value={q}
            onChange={e => setQ(e.target.value)}
            autoFocus
          />
        )}
        <div className={styles.optionList}>
          <button
            className={`${styles.option} ${group.value === null ? styles.optionActive : ''}`}
            onClick={() => { group.onChange(null); close(); }}
          >
            {group.allLabel}
          </button>
          {filtered.map(o => {
            const star = group.onToggleStar;
            // Two controls in one row when the group is starrable:
            // the star curates, the label filters. Same bargain the
            // reading list's tag chips struck before they folded in
            // here, so nothing was lost by folding them.
            const row = (
              <>
                {o.color && <span className={styles.optionDot} style={{ background: o.color }} aria-hidden />}
                <span className={styles.optionLabel}>{o.label}</span>
                {o.hint && <span className={styles.optionHint}>{o.hint}</span>}
              </>
            );
            const pick = () => {
              group.onChange(o.value === group.value ? null : o.value);
              close();
            };
            if (!star) {
              return (
                <button
                  key={o.value}
                  className={`${styles.option} ${o.value === group.value ? styles.optionActive : ''}`}
                  onClick={pick}
                >
                  {row}
                </button>
              );
            }
            return (
              <span
                key={o.value}
                className={`${styles.option} ${styles.optionStarrable} ${o.value === group.value ? styles.optionActive : ''}`}
              >
                <button
                  className={`${styles.starBtn} ${o.starred ? styles.starOn : ''}`}
                  onClick={() => star(o.value)}
                  aria-pressed={o.starred === true}
                  title={o.starTitle ?? (o.starred
                    ? `Remove “${o.label}” from favorites`
                    : `Favorite “${o.label}” - articles tagged this way get flagged`)}
                >
                  <StarIcon filled={o.starred === true} />
                </button>
                <button className={styles.optionPick} onClick={pick}>{row}</button>
              </span>
            );
          })}
          {filtered.length === 0 && <div className={styles.noMatch}>No matches</div>}
        </div>
      </>
    );
  }

  return (
    <div className={`${styles.bar} ${className}`}>
      <div className={styles.left}>
        {unread && (
          <button
            className={`${styles.chip} ${styles.unreadChip} ${unread.active ? styles.chipActive : ''}`}
            onClick={unread.onToggle}
            aria-pressed={unread.active}
            disabled={!unread.active && unread.count === 0}
            title={unread.active
              ? 'Show every article again'
              : `Show only articles you haven’t read yet (${unread.count} unread)`}
          >
            Unread
            <span className={styles.chipCount}>{unread.count}</span>
          </button>
        )}

        {favorites}

        {/* ── Spread out: a chip per group ──
            Each one is its own dropdown and its own read-out. What you've
            chosen is printed on the chip that chose it, which is the whole
            reason to spend the width: the folded bar can tell you that two
            filters are on, but not which two without opening it. */}
        {expanded && (
          <div className={styles.filterSet} ref={ref}>
            {usable.map(g => {
              const isOpen = openId === g.id;
              const on = g.value !== null;
              return (
                <div key={g.id} className={styles.filterWrap}>
                  {on ? (
                    /* A span holding two buttons, not a button holding a
                       button: an active chip both re-opens its list and
                       clears itself, and nesting the second inside the first
                       is invalid markup that browsers untangle differently.
                       Same arrangement as a starrable option row below. */
                    <span className={`${styles.chip} ${styles.chipActive} ${styles.splitChip}`}>
                      <button
                        className={styles.splitTrigger}
                        onClick={() => toggle(g.id)}
                        aria-expanded={isOpen}
                        aria-haspopup="menu"
                        title={`Change ${g.label.toLowerCase()} filter`}
                      >
                        <span className={styles.chipLabel}>{g.label}</span>
                        <span className={styles.chipValue}>{labelFor(g)}</span>
                        <ChevronIcon />
                      </button>
                      <button
                        className={styles.chipClear}
                        onClick={() => { g.onChange(null); close(); }}
                        title={`Clear ${g.label.toLowerCase()} filter`}
                        aria-label={`Clear ${g.label.toLowerCase()} filter`}
                      >
                        <XIcon />
                      </button>
                    </span>
                  ) : (
                    <button
                      className={styles.chip}
                      onClick={() => toggle(g.id)}
                      aria-expanded={isOpen}
                      aria-haspopup="menu"
                    >
                      {g.label}
                      <ChevronIcon />
                    </button>
                  )}

                  {isOpen && (
                    <div className={styles.panel} role="menu">{optionsFor(g)}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Folded: one chip, everything behind it ──
            The narrow shape, and the only one that needs the active pills:
            with the selections hidden inside the menu, they are the only thing
            on screen saying what is currently narrowing the list. */}
        {!expanded && usable.length > 0 && (
          <div className={styles.filterWrap} ref={ref}>
            <button
              className={`${styles.chip} ${active.length > 0 ? styles.chipActive : ''}`}
              onClick={toggleRoot}
              aria-expanded={openId !== null}
              aria-haspopup="menu"
            >
              <FilterIcon />
              Filters
              {active.length > 0 && <span className={styles.chipCount}>{active.length}</span>}
              <ChevronIcon />
            </button>

            {openId !== null && (
              <div className={styles.panel} role="menu">
                {current === null ? (
                  <div className={styles.groupList}>
                    {usable.map(g => (
                      <button key={g.id} className={styles.groupRow} onClick={() => toggle(g.id)}>
                        <span className={styles.groupLabel}>{g.label}</span>
                        <span className={styles.groupValue}>
                          {g.value === null ? g.allLabel : labelFor(g)}
                        </span>
                        <span className={styles.groupChevron}><ChevronIcon /></span>
                      </button>
                    ))}
                    {active.length > 0 && (
                      <button
                        className={styles.clearAll}
                        onClick={() => { active.forEach(g => g.onChange(null)); close(); }}
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <button className={styles.backRow} onClick={() => toggle(ROOT)}>
                      <span className={styles.backChevron}><ChevronIcon /></span>
                      {current.label}
                    </button>
                    {optionsFor(current)}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* What's actually narrowing the list, and how to stop it doing so.
            Only while folded - spread out, each chip carries its own value and
            its own clear, so these would be a second copy of both. */}
        {!expanded && active.map(g => (
          <button
            key={g.id}
            className={styles.activePill}
            onClick={() => g.onChange(null)}
            title={`Clear ${g.label.toLowerCase()} filter`}
          >
            <span className={styles.pillLabel}>{labelFor(g)}</span>
            <XIcon />
          </button>
        ))}
      </div>
    </div>
  );
}
