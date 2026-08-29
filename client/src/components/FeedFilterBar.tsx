import { useState, useEffect, useRef } from 'react';
import { StarIcon } from './TagChip';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useElementWidth } from '../hooks/useElementWidth';
import { tagKey } from '../utils/favoriteTags';
import styles from './FeedFilterBar.module.css';

/*
 * ── The bar is one line, at every width ───────────────────────────────────
 *
 * `.bar` is `flex-wrap: nowrap`. Everything below exists to make that true
 * without the row overflowing its box, because an overflowing row is worse than
 * a wrapped one: it widens the document, and mobile Safari answers that by
 * scaling the whole page out (the same fault the Filters panel hit in v1.19.0).
 *
 * So the bar sheds, in this order, as it narrows:
 *
 *   1. the active-filter pills give up width first, ellipsising (`.pills`)
 *   2. the three filter chips fold into one Filters menu   (EXPAND_AT)
 *   3. the actions fold into one ⋯ menu                    (FOLD_ACTIONS_AT)
 *   4. the Filters chip drops its word for its glyph       (GLYPH_FILTERS_AT)
 *
 * Every threshold is the *bar's own* width, measured, not the viewport's. The
 * viewport is not a proxy for it and never was: the feed's bar lives in a
 * column beside a 248px rail, so a 900px window gives the bar ~848px (the rail
 * has just dropped away) and a 901px window gives it ~543px (the rail is back).
 * A viewport threshold is wrong on one side of that jump whichever number it
 * picks, and it was picking the wrong side at exactly the width where three
 * chips and three labelled buttons stopped fitting. See useElementWidth.
 *
 * The numbers are measured, not guessed - see scripts/measure-filter-bar.mjs,
 * which renders the widest form of each cluster and reports where the row
 * stops fitting. Re-run it if you add a control to either half.
 */

/**
 * Where one chip per group stops fitting and they fold into a single Filters
 * menu. Below this, three labelled chips plus their selections plus whatever
 * the consumer put in `actions` is more than the row can hold.
 *
 * Set by where the chips stop having to ellipsise rather than by where they
 * stop overflowing - the row survives a good 60px below this, but it survives
 * it by cutting "Transportation" down to "Transport…" in all three chips at
 * once, and one folded chip showing a whole word beats three showing stubs.
 */
const EXPAND_AT = 740;

/**
 * Where labelled action buttons stop fitting beside the filters, and go behind
 * one ⋯ menu instead. They keep their words in there - which is the point, and
 * why nothing in this bar has to become an unlabelled glyph any more.
 */
const FOLD_ACTIONS_AT = 430;

/**
 * Where even "Filters" is more word than the row can spare. The funnel glyph
 * and the count carry it below this; the word stays in the title and the
 * accessible name. Only the filter chip is allowed to do this - it opens a menu
 * and changes nothing, so a wrong guess costs a tap.
 */
const GLYPH_FILTERS_AT = 330;

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
  /**
   * A dot and a count for the "all" row, for when it is a place rather than the
   * absence of a filter.
   *
   * The reading list's shelf group is the reason: its "all" row *is* the pile,
   * which has a colour and a number exactly as every folder beneath it does,
   * and a row carrying neither reads as the odd one out in its own list.
   */
  allColor?: string;
  allHint?: string;
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
  /**
   * An on/off filter that belongs to this group's axis but doesn't pick one of
   * its options.
   *
   * The feed's Favorites filter is the only one, and this is where it went: it
   * selects by star rather than by name, so it can't be a value in `options`,
   * but it is emphatically a topic filter and had no business being a fifth
   * chip in the row. It sits at the head of the group's list, above `allLabel`,
   * next to the stars that decide what it matches.
   *
   * It composes with `value` rather than replacing it — favourites *and* one
   * topic is a real thing to ask for, so a group can be doubly active and shows
   * both in its read-out.
   */
  toggle?: {
    label: string;
    /** How many rows on screen match. The filter is pointless at zero. */
    count: number;
    active: boolean;
    onToggle: () => void;
  };
  /**
   * Starred values that aren't in `options`.
   *
   * A favourite that has stopped matching anything has to stay reachable from
   * the page it's affecting, or the only way to switch it off is to go and find
   * it in Settings. These get a star and nothing else — there is no point
   * offering to filter down to a topic with no articles under it.
   */
  orphanStars?: string[];
  /**
   * This group says where you are, not what you are hiding.
   *
   * The reading list's shelves are the only one. Picking a folder does not
   * narrow the pile, it swaps the pile for a different set of articles, and the
   * two filters beside it rebuild themselves out of whatever it landed on.
   * Three things follow, and together they are why this is a flag rather than
   * an ordinary group whose "all" row happens to be the pile:
   *
   *   - it earns its chip on a single option, because its "all" row is a
   *     destination and not the absence of a filter — one folder plus the pile
   *     is two places to be, where one site out of one is no filter at all;
   *   - it never counts as an active filter, so it stays out of the count, the
   *     read-out and the pills;
   *   - and "Clear all filters" leaves it alone. Clearing your filters means
   *     show me everything on this shelf, never walk me off the shelf.
   *
   * Its chip reads out where you are at all times and carries no ✕: you leave a
   * shelf by picking another one.
   */
  scope?: boolean;
}

interface Props {
  groups: FilterGroup[];
  /** Read state only exists when read-on-scroll is on, so this is optional. */
  unread?: {
    count: number;
    active: boolean;
    onToggle: () => void;
    /**
     * Rows for a caret menu on the chip's right-hand end, in the same shape as
     * the shell's avatar menu.
     *
     * This is where "Mark all read" lives. It was in the actions cluster at the
     * far end of the bar, which is a fine place for it except that it is the
     * widest control in the row and it has nothing to do with the other two -
     * they set the feed up and change how it is drawn, and it writes to every
     * article you have. It belongs to the same axis as this chip: one shows you
     * what is unread, the other makes none of it unread. Putting it behind the
     * caret pairs it with its own filter and takes ~130px out of the row, which
     * is most of what the row was short of.
     *
     * Omit when there is nothing to offer - a caret opening an empty menu is
     * worse than no caret.
     */
    menu?: React.ReactNode;
  };
  /**
   * A favourites control of the consumer's own. The feed folds favourites into
   * its Topic group instead (see FilterGroup.toggle); the reading list still
   * passes its own pill through here.
   */
  favorites?: React.ReactNode;
  /**
   * Buttons that *do* something, kept at the far end of the bar.
   *
   * This slot existed once, was taken away, and is back deliberately — so the
   * reason it was taken away is worth restating: putting "Mark all read" in the
   * same row and the same dress as a filter chip pairs an irreversible write
   * with a control that only changes what you're looking at.
   *
   * The answer to that isn't a second row. That scattered the feed's controls
   * across two bands, and neither band could follow you down the page. It's
   * that the two halves of one row must not be mistakable for each other: these
   * sit behind a rule at the opposite end, wear a solid fill against the chips'
   * outlines, and keep their words. See `.actions` in the stylesheet and the
   * controlBar note in FeedPanel.
   */
  actions?: React.ReactNode;
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

const MoreIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.9" />
    <circle cx="12" cy="12" r="1.9" />
    <circle cx="19" cy="12" r="1.9" />
  </svg>
);

/**
 * One place to narrow the feed, and the far end of the same bar for the things
 * that act on it.
 *
 * Category, site and topic used to be three separate chips sitting beside a row
 * of every topic in the feed, which meant the controls were both scattered and
 * the loudest thing on the page. They're one dropdown now: what you've actually
 * chosen shows as removable pills, and everything you haven't stays folded away.
 * Unread keeps its own chip because it carries a count and is the one filter
 * people reach for without thinking.
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
export default function FeedFilterBar({ groups, unread, favorites, actions, className = '' }: Props) {
  // Which popover is showing. In the folded bar that's ROOT for the group list
  // or a group id once you've drilled into one; spread out, it's just the id of
  // the chip you clicked. Sharing one value is what lets both shapes reuse the
  // same list and the same dismiss handling.
  const [openId, setOpenId] = useState<string | null>(null);
  // The bar's two non-filter popovers: the unread chip's caret and the folded
  // actions' ⋯. One value rather than a boolean each, so opening either shuts
  // the other without any code having to remember to.
  const [barMenu, setBarMenu] = useState<'unread' | 'actions' | null>(null);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);
  // What the row can actually hold, asked of the row. See the shedding order at
  // the head of this file for what each threshold gives up.
  const [barRef, barWidth] = useElementWidth<HTMLDivElement>();
  // Zero is "not measured yet", which useLayoutEffect makes a single pre-paint
  // frame at most. It reads as the narrowest shape on purpose: that one fits
  // everywhere, so the worst case is a frame of a bar that is too folded rather
  // than a frame of one that overflows the page.
  const wide = barWidth >= EXPAND_AT;
  const foldActions = barWidth < FOLD_ACTIONS_AT;
  const glyphFilters = barWidth < GLYPH_FILTERS_AT;
  // A starrable group carries a search box at any length (it doubles as the way
  // to favourite a tag the feed has not published), so the box now turns up on
  // lists short enough not to need one - and on a phone an autofocused box
  // throws a keyboard over the list you opened the menu to read. Focus it only
  // where focusing costs nothing.
  const coarse = useMediaQuery('(hover: none)');

  useEffect(() => {
    if (openId === null && barMenu === null) return;
    function onOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t)) close();
      const host = barMenu === 'unread' ? unreadRef.current : actionsRef.current;
      if (host && !host.contains(t)) setBarMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { close(); setBarMenu(null); }
    }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [openId, barMenu]);

  // The ⋯ menu only exists while the actions are folded, and a menu left open
  // through a resize past that threshold would be hanging off a button that no
  // longer exists.
  useEffect(() => {
    if (!foldActions) setBarMenu(m => (m === 'actions' ? null : m));
  }, [foldActions]);

  /** Opening any bar menu shuts whatever filter panel was open, and vice versa. */
  function openBarMenu(which: 'unread' | 'actions') {
    setBarMenu(m => (m === which ? null : which));
    setOpenId(null);
    setQ('');
  }

  // Only groups with something to choose between are worth showing: a feed from
  // a single site has no site filter worth opening.
  //
  // A group can also earn its place without options at all — a Topic group in a
  // feed that has published no tags yet still carries the favourites toggle and
  // the favourites themselves, and those have to stay reachable precisely when
  // nothing on screen matches them.
  const usable = groups.filter(g =>
    g.options.length > 1 ||
    g.value !== null ||
    g.toggle !== undefined ||
    (g.orphanStars?.length ?? 0) > 0 ||
    // A scope group counts its "all" row as one of the choices, because it is
    // one: the reading list with a single folder beside it is two places to be.
    (g.scope === true && g.options.length > 0)
  );
  const expanded = wide && usable.length > 0 && usable.length <= EXPAND_MAX_GROUPS;

  // Rotating the phone or dragging the window across EXPAND_AT moves the anchor
  // the panel is hanging off, and a panel left open through that lands next to a
  // chip that is no longer the one you pressed.
  useEffect(() => { setOpenId(null); }, [expanded]);

  function close() { setOpenId(null); setQ(''); }

  function toggle(id: string) {
    setOpenId(prev => (prev === id ? null : id));
    setBarMenu(null);
    setQ('');
  }

  /** The folded bar's trigger: pressing it again shuts the menu, even from two
   *  levels in. `toggle(ROOT)` would walk you back to the group list instead,
   *  which is what the back row inside the panel is for. */
  function toggleRoot() {
    setOpenId(prev => (prev === null ? ROOT : null));
    setBarMenu(null);
    setQ('');
  }

  function labelFor(group: FilterGroup): string {
    return group.options.find(o => o.value === group.value)?.label ?? group.value ?? '';
  }

  /**
   * What one group is set to, as a single string, for the chip and the folded
   * group list.
   *
   * Every other read-out in the bar is built out of `bitsOf`, which a scope
   * group deliberately has none of - so this is the one that has to answer for
   * both kinds. A scope group always reads out somewhere, the pile included; an
   * ordinary one reads out its `allLabel` when nothing is on.
   */
  function readOutFor(group: FilterGroup): string {
    if (group.scope) return group.value !== null ? labelFor(group) : group.allLabel;
    const bits = bitsOf(group);
    return bits.length === 0 ? group.allLabel : bits.map(b => b.label).join(' · ');
  }

  /**
   * One active filter, as something the bar can print and clear.
   *
   * A group can narrow the list in two independent ways at once now — its
   * toggle and its selection — so "what is on" stopped being one label per
   * group. Every read-out in here is built from this list (the chip value, the
   * folded summary, the pills, the count badge), so they can't come to
   * different conclusions about how many filters are running.
   */
  interface ActiveBit { key: string; label: string; clear: () => void }

  function bitsOf(group: FilterGroup): ActiveBit[] {
    // A scope group has no bits by design, not by omission: being on a shelf is
    // not a filter you have switched on, so it must not show up in the count,
    // in the pills, or in what "Clear all filters" clears. Its read-out comes
    // from readOutFor instead, which is the one place that knows about both.
    if (group.scope) return [];
    const out: ActiveBit[] = [];
    if (group.toggle?.active) {
      const t = group.toggle;
      out.push({ key: `${group.id}:toggle`, label: t.label, clear: t.onToggle });
    }
    if (group.value !== null) {
      out.push({ key: group.id, label: labelFor(group), clear: () => group.onChange(null) });
    }
    return out;
  }

  const activeBits = usable.flatMap(bitsOf);

  function clearGroup(group: FilterGroup) {
    bitsOf(group).forEach(b => b.clear());
  }

  if (usable.length === 0 && !unread && !favorites && !actions) return null;

  const current = usable.find(g => g.id === openId) ?? null;

  /**
   * Search matches the hint as well as the label.
   *
   * The Site list is why: a subscription carries the reader's own name for it,
   * and the hint carries the host it actually publishes from. Those are often
   * different words for the same publisher - "ABC News" against `abc.com` - and
   * the one people reach for is whichever they happen to be thinking in. A box
   * that only searched the label would answer "no sites" to a domain that is
   * printed on the very row being looked for.
   */
  function matches(o: FilterOption, query: string): boolean {
    const lower = query.toLowerCase();
    return o.label.toLowerCase().includes(lower)
      || (o.hint ?? '').toLowerCase().includes(lower);
  }

  const filtered = current && q.trim()
    ? current.options.filter(o => matches(o, q.trim()))
    : current?.options ?? [];

  /**
   * The rows you pick from, identical in both shapes. Only what sits above them
   * differs: the folded bar puts a back row there, the spread-out one nothing,
   * because its chip is already the thing you'd be going back to.
   */
  function optionsFor(group: FilterGroup) {
    const star = group.onToggleStar;
    const query = q.trim();
    const lower = query.toLowerCase();

    // Favourites the feed has stopped carrying, searched alongside the real
    // options so the box narrows the whole panel rather than half of it.
    const orphans = star ? (group.orphanStars ?? []).filter(t => !query || t.toLowerCase().includes(lower)) : [];

    // Typing a tag nothing has published yet is the only way to favourite it
    // ahead of time, and it is why a starrable group gets a search box at any
    // length: this row is the other half of what that box is for. It withdraws
    // as soon as the tag is in the list either way — the row above does the job
    // then, and says so with a filled star or an empty one.
    const canAdd = !!star && query !== '' && tagKey(query) !== '' &&
      ![...group.options.map(o => o.label), ...(group.orphanStars ?? [])]
        .some(l => tagKey(l) === tagKey(query));

    return (
      <>
        {/* The group's own axis, switched on and off rather than picked from.
            First, above even "All topics", because it is the broadest thing the
            list can be narrowed to, and because it is the one row here that is
            about your standing interests rather than this feed's vocabulary. */}
        {group.toggle && (
          <button
            className={`${styles.toggleRow} ${group.toggle.active ? styles.toggleRowOn : ''}`}
            onClick={() => { group.toggle!.onToggle(); close(); }}
            disabled={!group.toggle.active && group.toggle.count === 0}
            aria-pressed={group.toggle.active}
            title={group.toggle.count === 0
              ? 'Nothing here matches your favorite tags'
              : `Show only ${group.toggle.label.toLowerCase()}`}
          >
            <StarIcon filled className={styles.toggleStar} />
            <span className={styles.optionLabel}>{group.toggle.label}</span>
            <span className={styles.optionHint}>{group.toggle.count}</span>
          </button>
        )}

        {group.searchable && (
          <input
            className={styles.search}
            placeholder={star ? 'Search or add a favorite…' : 'Search…'}
            value={q}
            onChange={e => setQ(e.target.value)}
            autoFocus={!coarse}
          />
        )}
        <div className={styles.optionList}>
          {/* Built like the rows below it rather than as a bare line of text,
              so a group that gives its "all" row a colour and a count (see
              allColor/allHint) gets one that lines up with them. Without a dot
              or a hint it renders exactly as it always did. */}
          <button
            className={`${styles.option} ${group.value === null ? styles.optionActive : ''}`}
            onClick={() => { group.onChange(null); close(); }}
          >
            {group.allColor && (
              <span className={styles.optionDot} style={{ background: group.allColor }} aria-hidden />
            )}
            <span className={styles.optionLabel}>{group.allLabel}</span>
            {group.allHint && <span className={styles.optionHint}>{group.allHint}</span>}
          </button>
          {filtered.map(o => {
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
          {filtered.length === 0 && orphans.length === 0 && !canAdd && (
            <div className={styles.noMatch}>No matches</div>
          )}

          {/* Starred, but nothing in the feed is tagged that way any more. A
              star and a label, with nothing to press to filter by it: that
              filter can only return an empty list, and the one useful thing you
              can do to one of these is stop it being a favourite. */}
          {orphans.length > 0 && (
            <>
              <div className={styles.sectionHead}>Favorites not in this feed</div>
              {orphans.map(t => (
                <span key={`orphan:${t}`} className={`${styles.option} ${styles.orphanRow}`}>
                  <button
                    className={`${styles.starBtn} ${styles.starOn}`}
                    onClick={() => star!(t)}
                    aria-pressed
                    title={`Remove “${t}” from favorites`}
                  >
                    <StarIcon filled />
                  </button>
                  <span className={styles.optionLabel}>{t}</span>
                </span>
              ))}
            </>
          )}

          {canAdd && (
            <button
              className={styles.addStar}
              onClick={() => { star!(query); setQ(''); }}
              title={`Favorite “${query}” - articles tagged this way get flagged`}
            >
              <StarIcon filled={false} />
              <span className={styles.optionLabel}>Favorite “{query}”</span>
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={`${styles.bar} ${className}`} ref={barRef}>
      <div className={styles.left}>
        {/* ── Unread, and what you can do about it ──
            The filter on the left, a caret on the right for the things that
            act on read state - which today is "Mark all read" and is the whole
            reason this chip grew a second half. Same two-buttons-in-a-span
            arrangement as an active filter chip and as the favorites pill: a
            button inside a button is invalid markup that browsers untangle
            differently, so the chip is a span and each half is its own button.

            Without a menu it stays exactly the plain chip it always was. */}
        {unread && (
          <div className={styles.unreadWrap} ref={unreadRef}>
            {unread.menu ? (
              <span className={`${styles.chip} ${styles.unreadChip} ${styles.splitChip} ${unread.active ? styles.chipActive : ''}`}>
                <button
                  className={styles.splitTrigger}
                  onClick={unread.onToggle}
                  aria-pressed={unread.active}
                  disabled={!unread.active && unread.count === 0}
                  title={unread.active
                    ? 'Show every article again'
                    : `Show only articles you haven’t read yet (${unread.count} unread)`}
                >
                  <span className={styles.chipText}>Unread</span>
                  <span className={styles.chipCount}>{unread.count}</span>
                </button>
                <button
                  className={styles.chipCaret}
                  onClick={() => openBarMenu('unread')}
                  aria-expanded={barMenu === 'unread'}
                  aria-haspopup="menu"
                  aria-label="Read actions"
                  title="Mark articles as read"
                >
                  <ChevronIcon />
                </button>
              </span>
            ) : (
              <button
                className={`${styles.chip} ${styles.unreadChip} ${unread.active ? styles.chipActive : ''}`}
                onClick={unread.onToggle}
                aria-pressed={unread.active}
                disabled={!unread.active && unread.count === 0}
                title={unread.active
                  ? 'Show every article again'
                  : `Show only articles you haven’t read yet (${unread.count} unread)`}
              >
                <span className={styles.chipText}>Unread</span>
                <span className={styles.chipCount}>{unread.count}</span>
              </button>
            )}

            {barMenu === 'unread' && unread.menu && (
              <div className={styles.menuPanel} role="menu" onClick={() => setBarMenu(null)}>
                {unread.menu}
              </div>
            )}
          </div>
        )}

        {/* ── Spread out: a chip per group ──
            Each one is its own dropdown and its own read-out. What you've
            chosen is printed on the chip that chose it, which is the whole
            reason to spend the width: the folded bar can tell you that two
            filters are on, but not which two without opening it. */}
        {expanded && (
          <div className={styles.filterSet} ref={ref}>
            {usable.map(g => {
              const isOpen = openId === g.id;
              const bits = bitsOf(g);
              return (
                <div key={g.id} className={styles.filterWrap}>
                  {g.scope ? (
                    /* Where you are, with no ✕ to leave it by - there is no
                       such thing as no shelf. It reads out the pile as readily
                       as a folder, and only wears the active fill once you have
                       gone somewhere, so the bar can be glanced at for "am I
                       looking at all of it?" the same way the filter chips can. */
                    <button
                      className={`${styles.chip} ${g.value !== null ? styles.chipActive : ''}`}
                      onClick={() => toggle(g.id)}
                      aria-expanded={isOpen}
                      aria-haspopup="menu"
                      title={`Change ${g.label.toLowerCase()}`}
                    >
                      <span className={styles.chipLabel}>{g.label}</span>
                      <span className={styles.chipValue}>{readOutFor(g)}</span>
                      <ChevronIcon />
                    </button>
                  ) : bits.length > 0 ? (
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
                        {/* Both halves when both are on. "Favorites · Design"
                            is two filters and has to read as two, or clearing
                            the chip looks like it removed one thing. */}
                        <span className={styles.chipValue}>{bits.map(b => b.label).join(' · ')}</span>
                        <ChevronIcon />
                      </button>
                      <button
                        className={styles.chipClear}
                        onClick={() => { clearGroup(g); close(); }}
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
            The chip carries the read-out itself, exactly as the spread-out ones
            do: what is on, and an ✕ to turn it off.

            It used to be a row of removable pills beside the chip instead, and
            that was the last thing in this bar that could be any width it
            liked. Two of them plus the chip plus the actions is more than a
            360px row holds, and because a pill cannot shrink below its own ✕
            they stopped shrinking at ~31px each and spilled over the buttons at
            the far end. One chip that ellipsises has a bounded width by
            construction, which is the only kind of promise a nowrap row can
            keep. Which filters are on is still legible: one of them reads out
            in full, several give a count and their names in the tooltip, and
            the menu underneath lists every group with its value.

            Below GLYPH_FILTERS_AT even the word goes and the funnel carries the
            chip alone. The word stays in the accessible name and the tooltip,
            so nothing is lost but the pixels - and this is the one control that
            can afford the guess, since it opens a menu and changes nothing. */}
        {!expanded && usable.length > 0 && (
          <div className={styles.filterWrap} ref={ref}>
            {(() => {
              const on = activeBits.length > 0;
              const readOut = activeBits.length === 1
                ? activeBits[0].label
                : `${activeBits.length} filters`;
              const hint = on
                ? `Filters - ${activeBits.map(b => b.label).join(', ')}`
                : 'Narrow the list';

              const trigger = (
                <>
                  <FilterIcon />
                  {!glyphFilters && (
                    <span className={styles.chipText}>{on ? readOut : 'Filters'}</span>
                  )}
                  {on && <span className={styles.chipCount}>{activeBits.length}</span>}
                  {!glyphFilters && <ChevronIcon />}
                </>
              );

              // Nothing on, or no room for an ✕: a plain button. A span holding
              // two buttons only when there is a second thing to press, because
              // a button inside a button is invalid markup that browsers
              // untangle differently.
              if (!on || glyphFilters) {
                return (
                  <button
                    className={`${styles.chip} ${on ? styles.chipActive : ''} ${glyphFilters ? styles.glyphChip : ''}`}
                    onClick={toggleRoot}
                    aria-expanded={openId !== null}
                    aria-haspopup="menu"
                    aria-label="Filters"
                    title={hint}
                  >
                    {trigger}
                  </button>
                );
              }

              return (
                <span className={`${styles.chip} ${styles.chipActive} ${styles.splitChip}`}>
                  <button
                    className={styles.splitTrigger}
                    onClick={toggleRoot}
                    aria-expanded={openId !== null}
                    aria-haspopup="menu"
                    aria-label="Filters"
                    title={hint}
                  >
                    {trigger}
                  </button>
                  <button
                    className={styles.chipClear}
                    onClick={() => { activeBits.forEach(b => b.clear()); close(); }}
                    title={activeBits.length === 1
                      ? `Clear “${activeBits[0].label}”`
                      : 'Clear all filters'}
                    aria-label="Clear all filters"
                  >
                    <XIcon />
                  </button>
                </span>
              );
            })()}

            {openId !== null && (
              <div className={styles.panel} role="menu">
                {current === null ? (
                  <div className={styles.groupList}>
                    {usable.map(g => (
                      <button key={g.id} className={styles.groupRow} onClick={() => toggle(g.id)}>
                        <span className={styles.groupLabel}>{g.label}</span>
                        <span className={styles.groupValue}>{readOutFor(g)}</span>
                        <span className={styles.groupChevron}><ChevronIcon /></span>
                      </button>
                    ))}
                    {activeBits.length > 0 && (
                      <button
                        className={styles.clearAll}
                        onClick={() => { activeBits.forEach(b => b.clear()); close(); }}
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

        {/* After the groups, not before them. The feed never sees this - it
            folds favourites into its Topic group's toggle - but the reading
            list passes its own pill, and a pill sitting ahead of the chips put
            a filter in front of the shelf group, which is the one control in
            the row that says which articles you are looking at at all. Where
            you are, then what you are narrowing it to. */}
        {favorites}

      </div>

      {/* The other half of the bar. Pushed to the far end by .actions' auto
          margin and fenced off by a rule, because the only thing these have in
          common with the chips beside them is the strip they ride on.

          Below FOLD_ACTIONS_AT they go behind one ⋯ button, stacked at full
          width with their labels showing. That is what lets the bar stay a
          single line on a phone without anything becoming an unlabelled glyph:
          "Mark all read" clears every article you have, and the last time this
          row ran out of room it answered by dropping words, which is how an
          irreversible write ended up as a bare double-tick. A menu has room for
          sentences; a 358px row does not. */}
      {actions && (
        <div className={styles.actions} ref={actionsRef}>
          {(usable.length > 0 || unread || favorites) && (
            <span className={styles.divider} aria-hidden />
          )}
          {foldActions ? (
            <>
              <button
                className={styles.moreBtn}
                onClick={() => openBarMenu('actions')}
                aria-expanded={barMenu === 'actions'}
                aria-haspopup="menu"
                aria-label="Feed actions"
                title="Manage feeds, change the layout"
              >
                <MoreIcon />
              </button>
              {barMenu === 'actions' && (
                <div
                  className={styles.menuPanel}
                  role="menu"
                  /* Pressing anything in here closes it, the way a menu should.
                     One click on the container rather than wrapping each child,
                     because the children are the consumer's own nodes and this
                     component has no business rewriting their handlers. */
                  onClick={() => setBarMenu(null)}
                >
                  {actions}
                </div>
              )}
            </>
          ) : actions}
        </div>
      )}
    </div>
  );
}
