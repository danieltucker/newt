import { useState, useEffect, useRef } from 'react';
import { StarIcon } from './TagChip';
import styles from './FeedFilterBar.module.css';

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
 */
export default function FeedFilterBar({ groups, unread, favorites, className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Only groups with something to choose between are worth showing: a feed from
  // a single site has no site filter worth opening.
  const usable = groups.filter(g => g.options.length > 1 || g.value !== null);
  const active = usable.filter(g => g.value !== null);

  function openGroup(id: string) {
    setActiveGroup(prev => (prev === id ? null : id));
    setQ('');
  }

  function labelFor(group: FilterGroup): string {
    return group.options.find(o => o.value === group.value)?.label ?? group.value ?? '';
  }

  if (usable.length === 0 && !unread && !favorites) return null;

  const current = usable.find(g => g.id === activeGroup) ?? null;
  const filtered = current && q.trim()
    ? current.options.filter(o => o.label.toLowerCase().includes(q.trim().toLowerCase()))
    : current?.options ?? [];

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

        {usable.length > 0 && (
          <div className={styles.filterWrap} ref={ref}>
            <button
              className={`${styles.chip} ${active.length > 0 ? styles.chipActive : ''}`}
              onClick={() => { setOpen(v => !v); setActiveGroup(null); }}
              aria-expanded={open}
              aria-haspopup="menu"
            >
              <FilterIcon />
              Filters
              {active.length > 0 && <span className={styles.chipCount}>{active.length}</span>}
              <ChevronIcon />
            </button>

            {open && (
              <div className={styles.panel} role="menu">
                {current === null ? (
                  <div className={styles.groupList}>
                    {usable.map(g => (
                      <button key={g.id} className={styles.groupRow} onClick={() => openGroup(g.id)}>
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
                        onClick={() => { active.forEach(g => g.onChange(null)); setOpen(false); }}
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <button className={styles.backRow} onClick={() => setActiveGroup(null)}>
                      <span className={styles.backChevron}><ChevronIcon /></span>
                      {current.label}
                    </button>
                    {current.searchable && (
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
                        className={`${styles.option} ${current.value === null ? styles.optionActive : ''}`}
                        onClick={() => { current.onChange(null); setOpen(false); }}
                      >
                        {current.allLabel}
                      </button>
                      {filtered.map(o => {
                        const star = current.onToggleStar;
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
                          current.onChange(o.value === current.value ? null : o.value);
                          setOpen(false);
                        };
                        if (!star) {
                          return (
                            <button
                              key={o.value}
                              className={`${styles.option} ${o.value === current.value ? styles.optionActive : ''}`}
                              onClick={pick}
                            >
                              {row}
                            </button>
                          );
                        }
                        return (
                          <span
                            key={o.value}
                            className={`${styles.option} ${styles.optionStarrable} ${o.value === current.value ? styles.optionActive : ''}`}
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
                )}
              </div>
            )}
          </div>
        )}

        {/* What's actually narrowing the list, and how to stop it doing so. */}
        {active.map(g => (
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
