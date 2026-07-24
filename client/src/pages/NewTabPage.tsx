import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import styles from './NewTabPage.module.css';
import Header from '../components/Header';
import SearchBar from '../components/SearchBar';
import FolderSidebar from '../components/FolderSidebar';
import BookmarksGrid from '../components/BookmarksGrid';
import ReadingList from '../components/ReadingList';
import AddLinkModal from '../components/AddLinkModal';
import NewFolderModal from '../components/NewFolderModal';
import EditBookmarkModal from '../components/EditBookmarkModal';
import EditFolderModal from '../components/EditFolderModal';
import SettingsModal, { Section as SettingsSection, UserProfile } from '../components/SettingsModal';
import ImportBookmarksModal from '../components/ImportBookmarksModal';
import ArticleModal from '../components/ArticleModal';
import Console from '../components/Console';
import NotesConsole from '../components/NotesConsole';
import FolderArticles from '../components/FolderArticles';
import SaveArticleModal from '../components/SaveArticleModal';
import AdminModal from '../components/AdminModal';
import FriendsModal from '../components/FriendsModal';
import { useFolders } from '../hooks/useFolders';
import { useNotifications } from '../hooks/useNotifications';
import { useBookmarks } from '../hooks/useBookmarks';
import { useReadingList } from '../hooks/useReadingList';
import { useSettings } from '../hooks/useSettings';
import { apiGet, apiFetch, apiPost, apiPut } from '../services/api';
import { Bookmark, Folder, FeedArticle, CommentPrefs } from '../types';
import { ThemeSetting, ResolvedTheme } from '../App';

// Background depth — max px each blob leans as the cursor crosses the viewport.
// The far layer leans opposite the near ones, which is what sells the depth.
// The glow layer spans the whole page and scrolls with it (see .bgRoot), so the
// only motion applied here is the pointer lean — there is no scroll parallax.
const BLOB_LEAN = [-18, 32, 56] as const;

interface Props {
  accessToken: string;
  username: string;
  isAdmin?: boolean;
  themeSetting: ThemeSetting;
  resolvedTheme: ResolvedTheme;
  onSetTheme: (t: ThemeSetting) => void;
  onLogout: () => void;
}

// Bare-letter shortcuts must not fire while the user is typing — otherwise "n"
// in a note or the search box would fling overlays open mid-sentence.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export default function NewTabPage({ accessToken, username, isAdmin, themeSetting, resolvedTheme, onSetTheme, onLogout }: Props) {
  const { settings, update: updateSetting, loaded: settingsLoaded } = useSettings(accessToken);

  // Sync theme setting from server on first load
  useEffect(() => {
    if (!settingsLoaded) return;
    if (settings.theme !== themeSetting) onSetTheme(settings.theme);
  }, [settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSetTheme(t: ThemeSetting) {
    onSetTheme(t);
    updateSetting({ theme: t });
  }

  const { folders, createFolder, updateFolder, deleteFolder, reorderFolders } = useFolders(accessToken);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (folders.length > 0 && !activeFolderId) {
      setActiveFolderId(folders[0].id);
    }
  }, [folders, activeFolderId]);

  const { bookmarks, setBookmarks, addBookmark, updateBookmark, deleteBookmark, reorderBookmarks, persistBookmarkOrder, checkFeed, markVisited } = useBookmarks(accessToken, activeFolderId);
  const { items: readingList, saveItem, updateItem, archiveItem, removeItem } = useReadingList(accessToken);

  const CACHE_KEY = `bfc_${username}`;

  const [bookmarksByFolder, setBookmarksByFolder] = useState<Record<string, Bookmark[]>>(() => {
    // Serve from localStorage instantly — avoids the blank-grid flash on every new tab
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, Bookmark[]>) : {};
    } catch { return {}; }
  });

  // Folder-less bookmarks — "pinned" to the top of the sidebar. Cached in the
  // same localStorage payload under a reserved key so they survive a reload.
  const PIN_CACHE_KEY = `bpc_${username}`;
  const [pinnedBookmarks, setPinnedBookmarks] = useState<Bookmark[]>(() => {
    try {
      const raw = localStorage.getItem(PIN_CACHE_KEY);
      return raw ? (JSON.parse(raw) as Bookmark[]) : [];
    } catch { return []; }
  });

  const cachePinned = useCallback((list: Bookmark[]) => {
    try { localStorage.setItem(PIN_CACHE_KEY, JSON.stringify(list)); } catch {}
  }, [PIN_CACHE_KEY]);

  // Sync active folder bookmarks into the display cache (and localStorage).
  // Guard: only update when bookmarks actually belong to activeFolderId.
  useEffect(() => {
    if (!activeFolderId) return;
    if (bookmarks.length > 0 && bookmarks[0].folderId !== activeFolderId) return;
    setBookmarksByFolder(prev => {
      const next = { ...prev, [activeFolderId]: bookmarks };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [bookmarks, activeFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bulk-load all bookmarks in one round-trip on first load
  useEffect(() => {
    if (!accessToken) return;
    apiGet<Bookmark[]>('/api/v1/bookmarks/all').then(all => {
      const grouped: Record<string, Bookmark[]> = {};
      const pinned: Bookmark[] = [];
      for (const bm of all) {
        // Pinned bookmarks show in BOTH the top pin grid and their own folder.
        if (bm.pinned) pinned.push(bm);
        if (bm.folderId == null) continue;
        if (!grouped[bm.folderId]) grouped[bm.folderId] = [];
        grouped[bm.folderId].push(bm);
      }
      setBookmarksByFolder(grouped);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(grouped)); } catch {}
      setPinnedBookmarks(pinned);
      cachePinned(pinned);
    }).catch(() => {});
  }, [accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Background feed checking — on folder switch and every 30min while the tab stays open
  const bookmarksRef = useRef(bookmarks);
  useEffect(() => { bookmarksRef.current = bookmarks; }, [bookmarks]);

  useEffect(() => {
    if (!activeFolderId) return;
    if (settings.rssEnabled === false) return;
    const STALE_MS = 30 * 60 * 1000;

    const runCheck = () => {
      bookmarksRef.current
        .filter(b => !b.feedCheckedAt || Date.now() - new Date(b.feedCheckedAt).getTime() > STALE_MS)
        .forEach(b => checkFeed(b.id).catch(() => {}));
    };

    // Delay initial check slightly so bookmarks have time to load
    const initial = setTimeout(runCheck, 2000);
    const interval = setInterval(runCheck, STALE_MS);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [activeFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Feed articles for search (accumulated across folder switches)
  const [feedArticles, setFeedArticles] = useState<FeedArticle[]>([]);

  function handleFeedArticlesLoaded(articles: FeedArticle[]) {
    setFeedArticles(prev => {
      const existingIds = new Set(prev.map(a => a.id));
      const fresh = articles.filter(a => !existingIds.has(a.id));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }

  // Pending feed article save (shows SaveArticleModal)
  type PendingSave = { id: string; url: string; title: string; source: string; categories: string[]; readTime: number | null; imageUrl: string | null; markSaved: () => void };
  const [savingArticle, setSavingArticle] = useState<PendingSave | null>(null);

  // Bookmarklet mode — true when this window was opened by a bookmarklet
  const bookmarkletModeRef = useRef(false);
  const [bookmarkletAddUrl, setBookmarkletAddUrl] = useState('');

  // Modal state
  const [showAddLink, setShowAddLink] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const { unread: notifUnread, notifications, loading: notifLoading, loadList: loadNotifications, markAllRead: markNotificationsRead } = useNotifications(accessToken);

  // Profile (avatar) for the top bar; kept in sync by SettingsModal's Account tab
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    if (!accessToken) return;
    apiGet<UserProfile>('/api/v1/account').then(setProfile).catch(() => {});
  }, [accessToken]);
  const [articleUrl, setArticleUrl] = useState<string | null>(null);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleFading, setConsoleFading] = useState(false);
  const showConsoleRef = useRef(false);
  showConsoleRef.current = showConsole;
  const consoleFadingRef = useRef(false);
  consoleFadingRef.current = consoleFading;

  function closeConsole() {
    if (consoleFadingRef.current) return;
    setConsoleFading(true);
    setTimeout(() => { setShowConsole(false); setConsoleFading(false); }, 320);
  }
  const closeConsoleRef = useRef(closeConsole);
  closeConsoleRef.current = closeConsole;

  // Notes console — slides up from the bottom, opened via the launcher button
  const [showNotes, setShowNotes] = useState(false);
  const showNotesRef = useRef(false);
  showNotesRef.current = showNotes;
  const [notesFading, setNotesFading] = useState(false);
  const notesFadingRef = useRef(false);
  notesFadingRef.current = notesFading;
  // Set when notes are opened from a hit in the main search bar: which note to
  // land on, and the term that found it (seeded into the console's own filter).
  const [notesTarget, setNotesTarget] = useState<{ id: string; query: string } | null>(null);

  function closeNotes() {
    if (notesFadingRef.current) return;
    setNotesFading(true);
    setTimeout(() => { setShowNotes(false); setNotesFading(false); setNotesTarget(null); }, 320);
  }

  // Stable identity: the search bar memoises its suggestions on this
  const openNoteFromSearch = useCallback((id: string, query: string) => {
    setNotesTarget({ id, query });
    setShowNotes(true);
  }, []);

  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);

  // Only one overlay at a time. Opening the notes console, the command console,
  // or the new-bookmark dialog tears down every other dialog on screen —
  // otherwise a console typed over a half-filled settings pane leaves two
  // surfaces fighting for Escape and for focus.
  type Overlay = 'notes' | 'console' | 'addLink';
  const dismissOtherOverlays = useCallback((keep: Overlay) => {
    if (keep !== 'console') { setShowConsole(false); setConsoleFading(false); }
    if (keep !== 'notes') { setShowNotes(false); setNotesFading(false); setNotesTarget(null); }
    if (keep !== 'addLink') { setShowAddLink(false); setBookmarkletAddUrl(''); }
    setShowNewFolder(false);
    setShowSettings(false);
    setShowAdmin(false);
    setShowImport(false);
    setEditingBookmark(null);
    setEditingFolder(null);
    setSavingArticle(null);
    setArticleUrl(null);
  }, []);

  useEffect(() => { if (showNotes) dismissOtherOverlays('notes'); }, [showNotes, dismissOtherOverlays]);
  useEffect(() => { if (showConsole) dismissOtherOverlays('console'); }, [showConsole, dismissOtherOverlays]);
  useEffect(() => { if (showAddLink) dismissOtherOverlays('addLink'); }, [showAddLink, dismissOtherOverlays]);

  const [feedRefreshKey, setFeedRefreshKey] = useState(0);

  // Detect bookmarklet intent from URL params (set before React renders)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const intent = params.get('intent');
    if (!intent) return;
    bookmarkletModeRef.current = true;
    const url = decodeURIComponent(params.get('url') ?? '');
    const title = decodeURIComponent(params.get('title') ?? '');
    window.history.replaceState({}, '', window.location.pathname);
    if (intent === 'save-article') {
      let source = '';
      try { source = new URL(url).hostname.replace(/^www\./, ''); } catch {}
      setSavingArticle({ id: '', url, title, source, categories: [], readTime: null, imageUrl: null, markSaved: () => { if (window.opener) window.close(); } });
    } else if (intent === 'add-bookmark') {
      setBookmarkletAddUrl(url);
      setShowAddLink(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Backtick opens the console (when consoleEnabled in settings)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== 'Backquote') return;
      if (!settings.consoleEnabled) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (showConsoleRef.current) { closeConsoleRef.current(); } else { setShowConsole(true); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settings.consoleEnabled]);

  // "n" opens notes — the same letter the launcher button shows. Escape closes,
  // handled inside the console itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (showNotesRef.current) return;
      e.preventDefault();
      setShowNotes(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Refs for folder-switch animation
  const folderRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tileRefs = useRef<Record<string, HTMLElement | null>>({});
  const switchingRef = useRef(false);
  const pendingEnterFolderIdRef = useRef<string | null>(null);

  const handleSelectFolder = useCallback((folderId: string, _folderEl: HTMLElement) => {
    if (folderId === activeFolderId || switchingRef.current) return;
    switchingRef.current = true;
    pendingEnterFolderIdRef.current = folderId;

    const tiles = Object.values(tileRefs.current).filter(Boolean) as HTMLElement[];

    if (tiles.length > 0) {
      const exitAnimations = tiles.map(tile =>
        tile.animate(
          [{ opacity: '1' }, { opacity: '0' }],
          { duration: 90, easing: 'ease-out', fill: 'forwards' }
        )
      );
      Promise.all(exitAnimations.map(a => a.finished)).then(() => {
        setActiveFolderId(folderId);
        switchingRef.current = false;
      });
    } else {
      setActiveFolderId(folderId);
      switchingRef.current = false;
    }
  }, [activeFolderId]);

  // Fires after activeFolderId changes (post-exit-animation). Because bookmarksByFolder
  // is populated from the bulk load / localStorage, tiles are in the DOM immediately.
  // useLayoutEffect lets us zero their opacity before the first paint so there's no flash.
  useLayoutEffect(() => {
    if (!pendingEnterFolderIdRef.current) return;
    pendingEnterFolderIdRef.current = null;
    const tiles = Object.values(tileRefs.current).filter(Boolean) as HTMLElement[];
    if (tiles.length === 0) return;
    tiles.forEach(t => (t.style.opacity = '0'));
    requestAnimationFrame(() => {
      tiles.forEach(t => {
        t.style.opacity = '';
        t.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 110, easing: 'ease-out' });
      });
    });
  }, [activeFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeFolder = folders.find(f => f.id === activeFolderId) ?? null;

  // The search bar is position:sticky. A zero-height sentinel just above it
  // tells us when it has pinned to the top, so we can reveal the glass backdrop.
  const [searchStuck, setSearchStuck] = useState(false);
  const searchSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = searchSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setSearchStuck(!entry.isIntersecting),
      { rootMargin: '-15px 0px 0px 0px', threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  async function handleAddLink(payload: {
    folderId: string; domain: string; name: string; faviconUrl: string; color: string;
  }) {
    await addBookmark(payload);
    if (payload.folderId !== activeFolderId) setActiveFolderId(payload.folderId);
  }

  async function handleCreateFolder(name: string, color: string) {
    const folder = await createFolder(name, color);
    setActiveFolderId(folder.id);
  }

  async function handleSaveBookmark(id: string, updates: {
    domain: string; name: string; faviconUrl: string; color: string; folderId: string | null;
  }) {
    const updated = await updateBookmark(id, updates);
    // Refresh sidebar preview cache
    if (activeFolderId) {
      const bm = bookmarks.find(b => b.id === id);
      if (bm && bm.folderId !== updates.folderId) {
        // moved to different folder — remove from current folder cache
        setBookmarksByFolder(prev => ({
          ...prev,
          [activeFolderId]: prev[activeFolderId]?.filter(b => b.id !== id) ?? [],
        }));
      } else if (updated) {
        // update in place in cache
        setBookmarksByFolder(prev => ({
          ...prev,
          [activeFolderId]: prev[activeFolderId]?.map(b => b.id === id ? updated : b) ?? [],
        }));
      }
    }
    // Keep the pinned list in sync — the edited bookmark may be a pinned one
    // (edited from the sidebar). Only drop it if it's no longer pinned.
    if (updated) {
      setPinnedBookmarks(prev => {
        const next = prev.map(b => b.id === id ? updated : b).filter(b => b.pinned);
        cachePinned(next);
        return next;
      });
    }
  }

  async function handleDeleteBookmark(id: string) {
    await deleteBookmark(id);
    if (activeFolderId) {
      setBookmarksByFolder(prev => ({
        ...prev,
        [activeFolderId]: prev[activeFolderId]?.filter(b => b.id !== id) ?? [],
      }));
    }
    setPinnedBookmarks(prev => {
      if (!prev.some(b => b.id === id)) return prev;
      const next = prev.filter(b => b.id !== id);
      cachePinned(next);
      return next;
    });
  }

  // Pin: surface a bookmark in the top pin grid. It stays in its folder too, so
  // update it in place there (pinned flag) and add it to the pin list.
  async function handlePinBookmark(id: string) {
    const updated = await apiPost<Bookmark>(`/api/v1/bookmarks/${id}/pin`, {});
    setBookmarks(prev => prev.map(b => b.id === id ? updated : b));
    setBookmarksByFolder(prev => {
      const next: Record<string, Bookmark[]> = {};
      for (const [fid, list] of Object.entries(prev)) next[fid] = list.map(b => b.id === id ? updated : b);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    setPinnedBookmarks(prev => {
      const next = [...prev.filter(b => b.id !== id), updated];
      cachePinned(next);
      return next;
    });
  }

  // Unpin: drop it from the pin grid. It remains in its folder — update in place.
  async function handleUnpinBookmark(id: string) {
    const updated = await apiPost<Bookmark>(`/api/v1/bookmarks/${id}/unpin`, {});
    setPinnedBookmarks(prev => {
      const next = prev.filter(b => b.id !== id);
      cachePinned(next);
      return next;
    });
    setBookmarks(prev => prev.map(b => b.id === id ? updated : b));
    setBookmarksByFolder(prev => {
      const next: Record<string, Bookmark[]> = {};
      for (const [fid, list] of Object.entries(prev)) next[fid] = list.map(b => b.id === id ? updated : b);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function handleReorderPinned(reordered: Bookmark[]) {
    setPinnedBookmarks(reordered);
    cachePinned(reordered);
    await apiPut('/api/v1/bookmarks/reorder', reordered.map((b, i) => ({ id: b.id, position: i })));
  }

  // Reorder bookmarks inside any folder (the inline sidebar can reorder a folder
  // that isn't the active one, so this updates that folder's cache directly).
  async function handleReorderBookmarksInFolder(folderId: string, reordered: Bookmark[]) {
    setBookmarksByFolder(prev => {
      const next = { ...prev, [folderId]: reordered };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    if (folderId === activeFolderId) setBookmarks(reordered);
    await persistBookmarkOrder(reordered);
  }

  async function handleSaveFolder(id: string, updates: { name: string; color: string; feedUrls: string[] }) {
    await updateFolder(id, updates);
  }

  function handleMarkFolderRead(folderId: string) {
    // Optimistic: clear badges immediately, persist in the background
    apiFetch(`/api/v1/folders/${folderId}/mark-read`, { method: 'POST' }).catch(() => {});
    if (folderId === activeFolderId) {
      setBookmarks(prev => prev.map(b => ({ ...b, unreadCount: 0 })));
    }
    setBookmarksByFolder(prev => {
      const next = { ...prev, [folderId]: (prev[folderId] ?? []).map(b => ({ ...b, unreadCount: 0 })) };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  // Scrolling past a feed article draws down the badge on the site it came
  // from; the server does the article→site matching and reports the new counts
  const handleUnreadCountsChange = useCallback((updates: { id: string; unreadCount: number }[]) => {
    const byId = new Map(updates.map(u => [u.id, u.unreadCount]));
    const apply = (b: Bookmark) => byId.has(b.id) ? { ...b, unreadCount: byId.get(b.id)! } : b;
    setBookmarks(prev => prev.map(apply));
    setBookmarksByFolder(prev => {
      const next: Record<string, Bookmark[]> = {};
      for (const [folderId, list] of Object.entries(prev)) next[folderId] = list.map(apply);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [setBookmarks, CACHE_KEY]);

  async function handleDeleteFolder(id: string) {
    await deleteFolder(id);
    setBookmarksByFolder(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (id === activeFolderId) {
      const remaining = folders.filter(f => f.id !== id);
      setActiveFolderId(remaining[0]?.id ?? null);
    }
  }

  // Comment display prefs, shared by the feed and reading-list threads
  const commentPrefs = useMemo<CommentPrefs>(() => ({
    showPublic: settings.commentsShowPublic !== false,
    // Fall back to the legacy boolean for accounts saved before the 3-way setting
    defaultVisibility: settings.commentsDefaultVisibility
      ?? (settings.commentsDefaultPublic ? 'public' : 'private'),
    sort: settings.commentsSort ?? 'newest',
    autoExpand: settings.commentsAutoExpand === true,
  }), [settings.commentsShowPublic, settings.commentsDefaultVisibility, settings.commentsDefaultPublic, settings.commentsSort, settings.commentsAutoExpand]);

  // null when background is disabled, otherwise the resolved theme key
  const bgKey = settings.backgroundGradient !== 'none' ? resolvedTheme : null;

  const blobWrapRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Background motion — the blobs lean gently toward the cursor. The pointer is
  // lerped in a single rAF loop so the motion glides instead of tracking 1:1
  // (transforms are compositor-only, so the per-frame cost is negligible).
  useEffect(() => {
    if (!bgKey) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let rafId = -1;
    let px = 0, py = 0;       // pointer target, -0.5..0.5 of viewport
    let cpx = 0, cpy = 0;     // current (lerped) values

    function frame() {
      cpx += (px - cpx) * 0.04;
      cpy += (py - cpy) * 0.04;
      BLOB_LEAN.forEach((lean, i) => {
        const el = blobWrapRefs.current[i];
        if (el) {
          const x = cpx * lean;
          const y = cpy * lean;
          el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
        }
      });
      rafId = requestAnimationFrame(frame);
    }

    function onMove(e: MouseEvent) {
      px = e.clientX / window.innerWidth - 0.5;
      py = e.clientY / window.innerHeight - 0.5;
    }

    window.addEventListener('mousemove', onMove, { passive: true });
    rafId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMove);
    };
  }, [bgKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className={styles.root}>
      {/* Background — spans the whole page, beneath all content (z-index 0) */}
      {bgKey && (
        <div className={styles.bgRoot}>
          <div className={styles.bgBase} />
          <div className={`${styles.blobWrap} ${styles.blobWrap1}`} ref={el => { blobWrapRefs.current[0] = el; }}>
            <div className={`${styles.blob} ${styles.blob1}`} />
          </div>
          <div className={`${styles.blobWrap} ${styles.blobWrap2}`} ref={el => { blobWrapRefs.current[1] = el; }}>
            <div className={`${styles.blob} ${styles.blob2}`} />
          </div>
          <div className={`${styles.blobWrap} ${styles.blobWrap3}`} ref={el => { blobWrapRefs.current[2] = el; }}>
            <div className={`${styles.blob} ${styles.blob3}`} />
          </div>
          <div className={styles.bgGrain} />
        </div>
      )}
    <div className={styles.page}>
      <div className={styles.content}>
      {/* Top-right bar: username + icon buttons */}
      <div className={styles.topBar}>
        <button
          className={styles.userBtn}
          onClick={() => { setSettingsSection('account'); setShowSettings(true); }}
          title="Account settings"
        >
          {profile?.avatar
            ? <img src={profile.avatar} alt="" className={styles.userAvatar} />
            : <span className={styles.userAvatarFallback}>{username.charAt(0).toUpperCase()}</span>}
          <span className={styles.username}>{username}</span>
        </button>
        <button className={`${styles.iconBtn} ${notifUnread > 0 ? styles.iconBtnActive : ''}`} onClick={() => setShowFriends(true)} title="People & notifications">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          {notifUnread > 0 && (
            <span className={styles.notifBadge}>{notifUnread > 9 ? '9+' : notifUnread}</span>
          )}
        </button>
        {isAdmin && (
          <button className={styles.iconBtn} onClick={() => setShowAdmin(true)} title="Admin">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </button>
        )}
        <button className={styles.iconBtn} onClick={() => { setSettingsSection(undefined); setShowSettings(true); }} title="Settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button className={styles.iconBtn} onClick={onLogout} title="Sign out">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </button>
      </div>

        <div className={styles.header}>
          <Header
            weatherLocation={settings.weatherLocation}
            weatherUnit={settings.weatherUnit}
            onSetWeatherLocation={loc => updateSetting({ weatherLocation: loc })}
            onSetWeatherUnit={unit => updateSetting({ weatherUnit: unit })}
            clockZones={settings.worldClockZones ?? []}
            onSetClockZones={zones => updateSetting({ worldClockZones: zones })}
            clockFormat={settings.clockFormat ?? '12h'}
          />
        </div>
        <div ref={searchSentinelRef} className={styles.searchSentinel} aria-hidden="true" />
        <div className={`${styles.searchGlass} ${searchStuck ? styles.searchGlassStuck : ''}`} aria-hidden="true" />
        <div className={styles.searchbar}>
          <SearchBar
            searchEngine={settings.searchEngine}
            searchNewTab={settings.searchNewTab}
            bookmarks={[...Object.values(bookmarksByFolder).flat(), ...pinnedBookmarks]}
            readingItems={readingList}
            feedArticles={feedArticles.map(a => ({ id: a.id, url: a.link, title: a.title, source: a.source, categories: a.categories }))}
            notes={(settings.noteDocs ?? []).filter(n => !n.deletedAt)}
            onOpenNote={openNoteFromSearch}
          />
        </div>

        <div className={styles.bodyGrid}>
          <div className={styles.leftCol}>
            <FolderSidebar
              folders={folders}
              activeFolderId={activeFolderId}
              bookmarksByFolder={bookmarksByFolder}
              pinnedBookmarks={pinnedBookmarks}
              layout={settings.bookmarkLayout ?? 'panel'}
              username={username}
              bookmarkOpenMode={settings.bookmarkOpenMode}
              onSelectFolder={handleSelectFolder}
              onNewFolder={() => setShowNewFolder(true)}
              onNewBookmark={() => setShowAddLink(true)}
              onEditFolder={setEditingFolder}
              onDeleteFolder={handleDeleteFolder}
              onMarkFolderRead={handleMarkFolderRead}
              onReorderFolders={reorderFolders}
              onEditBookmark={setEditingBookmark}
              onDeleteBookmark={handleDeleteBookmark}
              onVisitBookmark={markVisited}
              onPinBookmark={handlePinBookmark}
              onUnpinBookmark={handleUnpinBookmark}
              onReorderPinned={handleReorderPinned}
              onReorderBookmarks={handleReorderBookmarksInFolder}
              folderRefs={folderRefs}
            />
          </div>

          <div>
            {(settings.bookmarkLayout ?? 'panel') === 'panel' && (
              <BookmarksGrid
                folder={activeFolder}
                bookmarks={activeFolderId ? (bookmarksByFolder[activeFolderId] ?? []) : []}
                tileRefs={tileRefs}
                onAddLink={() => setShowAddLink(true)}
                onReorder={reorderBookmarks}
                onEditBookmark={setEditingBookmark}
                onDeleteBookmark={handleDeleteBookmark}
                onVisit={markVisited}
                onPin={handlePinBookmark}
                bookmarkOpenMode={settings.bookmarkOpenMode}
              />
            )}
            <div className={styles.bottomRow}>
              <ReadingList
                items={readingList}
                onSave={saveItem}
                onUpdate={updateItem}
                onArchive={archiveItem}
                onDelete={removeItem}
                articleOpenMode={(() => {
                const m = settings.readingListOpenMode ?? settings.articleOpenMode;
                return m === 'reader' ? 'iframe' : m;
              })()}
                onOpenArticle={setArticleUrl}
                layout={settings.readingListLayout ?? 'cards'}
                onLayoutChange={l => updateSetting({ readingListLayout: l })}
                collapsed={settings.readingListCollapsed === true}
                onCollapsedChange={c => updateSetting({ readingListCollapsed: c })}
                commentPrefs={commentPrefs}
              />
            </div>
            {settings.rssEnabled !== false && activeFolderId && (activeFolder?.feedUrls?.length ?? 0) > 0 && (
              <FolderArticles
                key={activeFolderId}
                folderId={activeFolderId}
                onSaveArticle={async (a, markSaved) => {
                  if ((settings.saveArticleMode ?? 'dialog') === 'instant') {
                    // Save with the article's own metadata — no dialog
                    try {
                      await saveItem({
                        url: a.url,
                        title: a.title,
                        source: a.source,
                        readTime: a.readTime != null ? `${a.readTime} min` : '',
                        tag: a.categories.map(c => c.trim().toLowerCase()).filter(Boolean).join(','),
                        imageUrl: a.imageUrl ?? '',
                      });
                      markSaved();
                    } catch {}
                  } else {
                    setSavingArticle({ ...a, markSaved });
                  }
                }}
                onArticlesLoaded={handleFeedArticlesLoaded}
                refreshKey={feedRefreshKey}
                pageSize={settings.rssFeedPageSize ?? 10}
                layout={settings.rssLayout ?? 'cards'}
                onLayoutChange={l => updateSetting({ rssLayout: l })}
                markReadOnScroll={settings.markReadOnScroll !== false}
                onUnreadCountsChange={handleUnreadCountsChange}
                commentPrefs={commentPrefs}
                onFolderMarkedRead={handleMarkFolderRead}
              />
            )}
          </div>
        </div>

        <footer className={styles.footer}>
          <a href="https://github.com/danieltucker/newTab" target="_blank" rel="noopener noreferrer" className={styles.footerLink}>
            v1.6
          </a>
        </footer>
      </div>
      </div>

      {/* Notes launcher — small round button, bottom-right */}
      {!showNotes && (
        <button
          className={styles.notesLauncher}
          onClick={() => setShowNotes(true)}
          title="Notes"
          aria-label="Open notes"
        >
          <span className={styles.notesLauncherLetter} aria-hidden>n</span>
        </button>
      )}

      {showAddLink && (
        <AddLinkModal
          folders={folders}
          defaultFolderId={activeFolderId}
          defaultUrl={bookmarkletAddUrl || undefined}
          onAdd={handleAddLink}
          onClose={() => {
            setShowAddLink(false);
            setBookmarkletAddUrl('');
            if (bookmarkletModeRef.current && window.opener) window.close();
          }}
        />
      )}

      {showNewFolder && (
        <NewFolderModal
          onCreate={handleCreateFolder}
          onClose={() => setShowNewFolder(false)}
        />
      )}

      {editingBookmark && (
        <EditBookmarkModal
          bookmark={editingBookmark}
          folders={folders}
          onSave={handleSaveBookmark}
          onDelete={handleDeleteBookmark}
          onClose={() => setEditingBookmark(null)}
        />
      )}

      {editingFolder && (
        <EditFolderModal
          folder={editingFolder}
          bookmarkFeeds={(bookmarksByFolder[editingFolder.id] ?? [])
            .filter(b => !!b.feedUrl)
            .map(b => ({ name: b.name, domain: b.domain, feedUrl: b.feedUrl! }))}
          onSave={handleSaveFolder}
          onDelete={handleDeleteFolder}
          onClose={() => setEditingFolder(null)}
        />
      )}

      {showImport && (
        <ImportBookmarksModal
          folders={folders}
          activeFolderId={activeFolderId}
          onClose={() => setShowImport(false)}
          onImported={() => {
            // Refetch the bulk bookmark cache so new imports appear immediately
            apiGet<Bookmark[]>('/api/v1/bookmarks/all').then(all => {
              const grouped: Record<string, Bookmark[]> = {};
              const pinned: Bookmark[] = [];
              for (const bm of all) {
                if (bm.pinned) pinned.push(bm);
                if (bm.folderId == null) continue;
                if (!grouped[bm.folderId]) grouped[bm.folderId] = [];
                grouped[bm.folderId].push(bm);
              }
              setBookmarksByFolder(grouped);
              try { localStorage.setItem(CACHE_KEY, JSON.stringify(grouped)); } catch {}
              setPinnedBookmarks(pinned);
              cachePinned(pinned);
            }).catch(() => {});
          }}
        />
      )}

      {savingArticle && (
        <SaveArticleModal
          url={savingArticle.url}
          title={savingArticle.title}
          source={savingArticle.source}
          imageUrl={savingArticle.imageUrl ?? ''}
          initialTag={savingArticle.categories.join(',')}
          initialReadTime={savingArticle.readTime != null ? `${savingArticle.readTime} min` : ''}
          onSave={async data => {
            await saveItem(data);
            savingArticle.markSaved();
            setSavingArticle(null);
            if (bookmarkletModeRef.current && window.opener) window.close();
          }}
          onClose={() => {
            setSavingArticle(null);
            if (bookmarkletModeRef.current && window.opener) window.close();
          }}
        />
      )}

      {articleUrl && (
        <ArticleModal
          url={articleUrl}
          onClose={() => {
            setArticleUrl(null);
            // Lets the reading list offer post-read actions on the card just read
            window.dispatchEvent(new Event('article-reader-closed'));
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={{ ...settings, theme: themeSetting }}
          onUpdate={async (patch) => { if (patch.theme) handleSetTheme(patch.theme); await updateSetting(patch); }}
          onClose={() => setShowSettings(false)}
          onImport={() => { setShowSettings(false); setShowImport(true); }}
          initialSection={settingsSection}
          onProfileChange={setProfile}
        />
      )}

      {showAdmin && (
        <AdminModal currentUsername={username} onClose={() => setShowAdmin(false)} />
      )}

      {showFriends && (
        <FriendsModal
          accessToken={accessToken}
          notifications={notifications}
          notifLoading={notifLoading}
          onLoadNotifications={loadNotifications}
          onMarkAllRead={markNotificationsRead}
          onClose={() => setShowFriends(false)}
        />
      )}

      {showConsole && (
        <Console
          folders={folders}
          theme={resolvedTheme}
          isAdmin={!!isAdmin}
          onSelectFolder={setActiveFolderId}
          onCreateFolder={handleCreateFolder}
          onSetTheme={handleSetTheme}
          onRefreshFeeds={() => setFeedRefreshKey(k => k + 1)}
          onAddSite={handleAddLink}
          closing={consoleFading}
          onClose={closeConsole}
        />
      )}

      {showNotes && (
        <NotesConsole
          docs={settings.noteDocs ?? []}
          folders={settings.noteFolders ?? []}
          order={settings.noteTreeOrder ?? []}
          sidebarWidth={settings.noteSidebarWidth ?? 210}
          onSidebarWidth={noteSidebarWidth => updateSetting({ noteSidebarWidth })}
          legacyNotes={settings.notes}
          onSave={(noteDocs, noteFolders, noteTreeOrder) => updateSetting({ noteDocs, noteFolders, noteTreeOrder })}
          initialNoteId={notesTarget?.id}
          initialQuery={notesTarget?.query}
          closing={notesFading}
          onClose={closeNotes}
        />
      )}
    </div>
    </>
  );
}
