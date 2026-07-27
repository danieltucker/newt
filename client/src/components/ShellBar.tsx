import { ReactNode, useEffect, useRef, useState } from 'react';
import styles from './ShellBar.module.css';
import NewtMark from './NewtMark';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { navMenuItems, accountMenuItems, ShellMenuItem } from '../utils/shellNav';

// The bookmarks rail rides beside the new tab's body while there are two columns
// to ride in. Below this it moves into the hamburger - same width at which
// NewTabPage's .bodyGrid drops to one column, so the rail is never homeless and
// never rendered twice. Exported because NewTabPage owns the other half of that
// either/or.
export const RAIL_NARROW = '(max-width: 900px)';

// The compact chrome for reading views - a profile, a post, the blog manager.
// The new tab keeps its tall greeting header; those pages don't want 120px of
// salutation above the thing you actually came to read, so everything collapses
// into one sticky glass row: where-you-can-go on the left, search in the middle,
// what-you-can-do on the right.

interface Props {
  username: string;
  avatar?: string | null;
  isAdmin?: boolean;
  path: string;
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
function Menu({ open, onClose, align = 'left', children }: {
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
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
      className={`${styles.menu} ${align === 'right' ? styles.menuRight : ''}`}
      role="menu"
    >
      {children}
    </div>
  );
}

function MenuRow({ item, onPick }: { item: ShellMenuItem; onPick: (item: ShellMenuItem) => void }) {
  return (
    <button
      role="menuitem"
      className={`${styles.menuItem} ${item.current ? styles.menuItemCurrent : ''} ${item.danger ? styles.menuItemDanger : ''}`}
      onClick={() => onPick(item)}
    >
      {/* Home wears the mark - it's the one entry that names the app itself
          rather than a section of it. */}
      <span className={styles.menuLabel}>
        {item.id === 'home' && <NewtMark className={styles.menuMark} />}
        {item.label}
      </span>
      {item.current && <span className={styles.menuDot} aria-hidden />}
    </button>
  );
}

export default function ShellBar({
  username, avatar, isAdmin, path, notifUnread,
  navigate, onOpenSettings, onOpenAdmin, onOpenNotifications, onLogout,
  search, bookmarksRail,
}: Props) {
  const [navOpen, setNavOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const railNarrow = useMediaQuery(RAIL_NARROW);

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

  // One menu at a time - two open dropdowns on the same row read as a bug.
  function openNav() { setAcctOpen(false); setNavOpen(o => !o); }
  function openAcct() { setNavOpen(false); setAcctOpen(o => !o); }

  function handleNav(item: ShellMenuItem) {
    setNavOpen(false);
    if (item.to) navigate(item.to);
  }

  function handleAccount(item: ShellMenuItem) {
    setAcctOpen(false);
    switch (item.id) {
      case 'profile': navigate(`/u/${encodeURIComponent(username)}`); break;
      case 'settings': onOpenSettings(); break;
      case 'admin': onOpenAdmin(); break;
      case 'signout': onLogout(); break;
    }
  }

  return (
    <header className={styles.bar} ref={barRef}>
      <div className={styles.inner}>
        {/* ── Left: who we are, and where you can go ── */}
        <div className={styles.left}>
          <button className={styles.brand} onClick={() => navigate('/')} title="Newt - home">
            <NewtMark className={styles.brandMark} />
            <span className={styles.brandText}>newt</span>
          </button>

          <div className={styles.menuWrap}>
            <button
              className={`${styles.iconBtn} ${navOpen ? styles.iconBtnOpen : ''}`}
              onClick={openNav}
              aria-haspopup="menu"
              aria-expanded={navOpen}
              title="Menu"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <Menu open={navOpen} onClose={() => setNavOpen(false)}>
              {navMenuItems({ username, path }).map(item => (
                <MenuRow key={item.id} item={item} onPick={handleNav} />
              ))}
              {/* Under the destinations: the bookmarks rail, once the body is
                  too narrow to hold it alongside. It scrolls within itself so a
                  long folder list can't push the menu past the bottom of the
                  screen. */}
              {railNarrow && bookmarksRail && (
                <>
                  <div className={styles.menuSep} />
                  <div className={styles.menuRailLabel}>Bookmarks</div>
                  <div className={styles.menuRail}>
                    {bookmarksRail(() => setNavOpen(false))}
                  </div>
                </>
              )}
            </Menu>
          </div>
        </div>

        {/* ── Middle: search, the widest thing that will fit ── */}
        <div className={styles.center}>{search}</div>

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
