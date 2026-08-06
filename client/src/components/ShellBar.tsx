import { ReactNode, useEffect, useRef, useState } from 'react';
import styles from './ShellBar.module.css';
import NewtMark from './NewtMark';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { accountMenuItems, ShellMenuItem } from '../utils/shellNav';

// The bookmarks rail rides beside the new tab's body while there are two columns
// to ride in. Below this it moves into the hamburger - same width at which
// NewTabPage's .bodyGrid drops to one column, so the rail is never homeless and
// never rendered twice. Exported because NewTabPage owns the other half of that
// either/or.
export const RAIL_NARROW = '(max-width: 900px)';

// Below this the bar can't carry the brand, the search box and three actions on
// one row and leave search wide enough to read what you typed - on a phone it
// came out around 130px, narrower than most of the hints it rotates through. So
// search stops being a permanent box down here and becomes a magnifier that
// expands over the whole row when tapped, which is the trade every mobile
// chrome makes: search is the widest thing in the bar or it isn't in the bar.
const SEARCH_NARROW = '(max-width: 620px)';

// The compact chrome for reading views - a profile, a post, the blog manager.
// The new tab keeps its tall greeting header; those pages don't want 120px of
// salutation above the thing you actually came to read, so everything collapses
// into one sticky glass row: where-you-can-go on the left, search in the middle,
// what-you-can-do on the right.

interface Props {
  username: string;
  avatar?: string | null;
  isAdmin?: boolean;
  notifUnread: number;

  navigate: (to: string) => void;
  onOpenSettings: () => void;
  onOpenAdmin: () => void;
  onOpenNotifications: () => void;
  onLogout: () => void;

  /** The shell's SearchBar, passed in so ShellBar doesn't need its data sources. */
  search: ReactNode;

  /**
   * The bookmarks rail, rendered here instead of beside the body once the
   * viewport is too narrow to carry two columns. A render prop rather than a
   * node because the rail has to be able to dismiss the menu it's sitting in:
   * picking a folder or opening a dialog from inside a dropdown should close
   * that dropdown. Omitted on views that have no rail (a profile, a post).
   */
  bookmarksRail?: (close: () => void) => ReactNode;
}

// A dropdown anchored under its trigger. Closes on outside click and Escape.
// `role` is opt-out because only one of the two carries a list of menuitems -
// the other holds the bookmarks rail, and calling that a menu would promise
// arrow-key navigation between rows that aren't menuitems.
function Menu({ open, onClose, align = 'left', role = 'menu', className = '', children }: {
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  role?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      // The trigger is the menu's previous sibling - clicks on it toggle, so
      // let it handle its own close rather than double-firing here.
      const wrap = ref.current?.parentElement;
      if (wrap && !wrap.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`${styles.menu} ${align === 'right' ? styles.menuRight : ''} ${className}`}
      role={role}
    >
      {children}
    </div>
  );
}

function MenuRow({ item, onPick }: { item: ShellMenuItem; onPick: (item: ShellMenuItem) => void }) {
  return (
    <button
      role="menuitem"
      className={`${styles.menuItem} ${item.danger ? styles.menuItemDanger : ''}`}
      onClick={() => onPick(item)}
    >
      <span className={styles.menuLabel}>{item.label}</span>
    </button>
  );
}

export default function ShellBar({
  username, avatar, isAdmin, notifUnread,
  navigate, onOpenSettings, onOpenAdmin, onOpenNotifications, onLogout,
  search, bookmarksRail,
}: Props) {
  const [navOpen, setNavOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const railNarrow = useMediaQuery(RAIL_NARROW);
  const searchNarrow = useMediaQuery(SEARCH_NARROW);
  const searchExpanded = searchNarrow && searchOpen;
  const centerRef = useRef<HTMLDivElement>(null);

  // Publish the bar's height so anything pinned beneath it can clear it. The
  // bar grows and shrinks with its own breakpoints (and with the search box's
  // font metrics), so this is measured rather than hard-coded - a stale
  // constant would tuck the sticky rail under the glass.
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const publish = () => {
      document.documentElement.style.setProperty('--shellbar-h', `${el.offsetHeight}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The hamburger is only rendered while it has the rail to hold; without that
  // it would be a menu of one entry the brand button already covers.
  const showNav = railNarrow && !!bookmarksRail;

  // Widening the window takes the button away, so the menu it opened has to go
  // with it - otherwise narrowing again reopens a dropdown nobody asked for.
  useEffect(() => {
    if (!showNav) setNavOpen(false);
  }, [showNav]);

  // Widening past the breakpoint puts the permanent search box back, so the
  // expanded state has to go with it - otherwise the desktop bar comes back with
  // its brand and actions hidden behind a search box nobody can dismiss.
  useEffect(() => {
    if (!searchNarrow) setSearchOpen(false);
  }, [searchNarrow]);

  // Expanding is a tap that means "I want to type", so the caret has to land in
  // the box - on a phone that is also what raises the keyboard. The search box
  // arrives as an opaque ReactNode (see the `search` prop), so there's no ref to
  // forward; reaching for its input through the wrapper is the price of ShellBar
  // not having to know how SearchBar is built.
  useEffect(() => {
    if (!searchExpanded) return;
    centerRef.current?.querySelector('input')?.focus();
  }, [searchExpanded]);

  useEffect(() => {
    if (!searchExpanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSearchOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchExpanded]);

  // One menu at a time - two open dropdowns on the same row read as a bug.
  function openNav() { setAcctOpen(false); setNavOpen(o => !o); }
  function openAcct() { setNavOpen(false); setAcctOpen(o => !o); }

  function handleAccount(item: ShellMenuItem) {
    setAcctOpen(false);
    switch (item.id) {
      case 'profile': navigate(`/u/${encodeURIComponent(username)}`); break;
      // The blog manager, not the profile's public Posts tab - this menu is
      // your own things, and drafts only exist in the manager.
      case 'myblog': navigate('/blog'); break;
      case 'settings': onOpenSettings(); break;
      case 'admin': onOpenAdmin(); break;
      case 'signout': onLogout(); break;
    }
  }

  return (
    <header className={styles.bar} ref={barRef}>
      <div className={`${styles.inner} ${searchExpanded ? styles.innerSearching : ''}`}>
        {/* ── Left: who we are, and where you can go ── */}
        <div className={styles.left}>
          <button className={styles.brand} onClick={() => navigate('/')} title="Newt - home">
            <NewtMark className={styles.brandMark} />
            <span className={styles.brandText}>newt</span>
          </button>

          {/* Purely the bookmarks rail's home on viewports too narrow to show
              it beside the body. It held a short list of destinations too, but
              the mark to its left already goes home and everything else about
              you lives under the avatar - so the whole dropdown is bookmarks,
              and above RAIL_NARROW the button isn't rendered at all. */}
          {showNav && (
            <div className={styles.menuWrap}>
              <button
                className={`${styles.iconBtn} ${navOpen ? styles.iconBtnOpen : ''}`}
                onClick={openNav}
                aria-expanded={navOpen}
                title="Bookmarks"
                aria-label="Bookmarks"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              {/* Not a menu of menuitems - see Menu. The rail scrolls within
                  itself so a long folder list can't push it past the bottom of
                  the screen. */}
              <Menu open={navOpen} onClose={() => setNavOpen(false)} role="group" className={styles.menuSheet}>
                <div className={styles.menuRailHead}>
                  <div className={styles.menuRailLabel}>Bookmarks</div>
                  {/* Only drawn once this is a sheet - a dropdown closes by
                      clicking off it, a sheet has no off. */}
                  <button
                    className={styles.sheetClose}
                    onClick={() => setNavOpen(false)}
                    aria-label="Close bookmarks"
                  >
                    ✕
                  </button>
                </div>
                <div className={styles.menuRail}>
                  {bookmarksRail?.(() => setNavOpen(false))}
                </div>
              </Menu>
            </div>
          )}

          {/* Search's stand-in on a narrow bar. Sits on the left rather than in
              the action row because that is the edge the expanded box grows
              from: tapping a magnifier on the right and watching the row fill
              leftward reads as the box coming from somewhere else. Hidden above
              SEARCH_NARROW, where the permanent box is in the middle. */}
          <button
            className={`${styles.iconBtn} ${styles.searchBtn}`}
            onClick={() => setSearchOpen(true)}
            aria-expanded={searchExpanded}
            title="Search"
            aria-label="Search"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>
        </div>

        {/* ── Middle: search, the widest thing that will fit ──
            Below SEARCH_NARROW this is hidden until the magnifier on the right
            expands it, at which point it claims the whole row. Kept mounted
            either way: unmounting would throw away whatever had been typed, and
            remounting is what would need the ref this deliberately doesn't
            have. */}
        <div className={styles.center} ref={centerRef}>{search}</div>

        {/* Only reachable while search is expanded, and the only way back - the
            row's other controls are hidden behind it. */}
        <button
          className={styles.searchCancel}
          onClick={() => setSearchOpen(false)}
          aria-label="Close search"
        >
          Cancel
        </button>

        {/* ── Right: what you can do ── */}
        <div className={styles.right}>
          <button className={styles.createBtn} onClick={() => navigate('/blog/new')} title="Write a post">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className={styles.createLabel}>Create</span>
          </button>

          <button
            className={`${styles.iconBtn} ${notifUnread > 0 ? styles.iconBtnActive : ''}`}
            onClick={onOpenNotifications}
            title="Notifications"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {notifUnread > 0 && (
              <span className={styles.notifBadge}>{notifUnread > 9 ? '9+' : notifUnread}</span>
            )}
          </button>

          <div className={styles.menuWrap}>
            <button
              className={`${styles.avatarBtn} ${acctOpen ? styles.avatarBtnOpen : ''}`}
              onClick={openAcct}
              aria-haspopup="menu"
              aria-expanded={acctOpen}
              title={username}
            >
              {avatar
                ? <img src={avatar} alt="" className={styles.avatarImg} />
                : <span className={styles.avatarFallback}>{username.charAt(0).toUpperCase()}</span>}
              <svg className={styles.caret} width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4.5 6 7.5 9 4.5" />
              </svg>
            </button>
            <Menu open={acctOpen} onClose={() => setAcctOpen(false)} align="right">
              <div className={styles.menuHead}>
                <span className={styles.menuHandle}>@{username}</span>
              </div>
              {accountMenuItems({ isAdmin }).map(item => (
                <MenuRow key={item.id} item={item} onPick={handleAccount} />
              ))}
            </Menu>
          </div>
        </div>
      </div>
    </header>
  );
}
