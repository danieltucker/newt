import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import styles from './NewTabPage.module.css';
import ShellBar, { RAIL_NARROW } from '../components/ShellBar';
import SiteFooter from '../components/SiteFooter';
import BackToTop from '../components/BackToTop';
import { toggleFavorite } from '../utils/favoriteTags';
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
import FeedPanel from '../components/FeedPanel';
import FeedManagerModal from '../components/FeedManagerModal';
import FeedOnboarding from '../components/FeedOnboarding';
import SaveArticleModal from '../components/SaveArticleModal';
import AdminModal from '../components/AdminModal';
import NotificationsModal from '../components/NotificationsModal';
import ArticleDetailModal from '../components/ArticleDetailModal';
import ProfilePage from './ProfilePage';
import BlogPostPage from './BlogPostPage';
import MyBlogPage from './MyBlogPage';
import SitePage from './SitePage';
import BlogEditorPage from './BlogEditorPage';
import { parseArticlePath } from '../utils/articleUrl';
import { profilePathFor } from '../utils/profileUrl';
import { sitePathFor } from '../utils/siteUrl';
import { canonicalFeedUrl } from '../utils/feedKey';
import { articleEmbed } from '../utils/noteEmbed';
import { stashSeed } from '../utils/composerSeed';
import { useFolders } from '../hooks/useFolders';
import { useFeeds, useImportableFeeds, useSuggestedFeeds } from '../hooks/useFeeds';
import { useNotifications } from '../hooks/useNotifications';
import { useBookmarks } from '../hooks/useBookmarks';
import { useReadingList } from '../hooks/useReadingList';
import { useReadingFolders, nextShelfColor } from '../hooks/useReadingFolders';
import { useSettings } from '../hooks/useSettings';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { apiGet, apiFetch, apiPost, apiPut } from '../services/api';
import { Bookmark, Folder, FeedArticle, CommentPrefs } from '../types';
import { ThemeSetting, ResolvedTheme } from '../App';

// Background depth - max px each blob leans as the cursor crosses the viewport.
// The far layer leans opposite the near ones, which is what sells the depth.
// The glow layer spans the whole page and scrolls with it (see .bgRoot), so the
// only motion applied here is the pointer lean - there is no scroll parallax.
const BLOB_LEAN = [-18, 32, 56] as const;

// A page that renders *inside* this shell instead of the new-tab body. Profiles
// and blog posts are read while signed in, so they keep the header, the search
// bar, the command console and the notes console rather than dropping the reader
// onto a bare page that has none of them. Logged-out visitors still get those
// same pages standalone - see App.tsx - since none of that chrome applies.
//
// The composer is in this list too. It is a writing surface, so the instinct is
// to strip the chrome away from it - but notes are the thing you write *from*,
// and sending an author back to the new tab to reread one is worse than a bar
// across the top. The bare-letter shortcuts below already stand down inside a
// text field, so nothing here steals a keystroke from the editor.
export type ShellView =
  | { kind: 'profile'; username: string; tab?: string | null }
  | { kind: 'post'; username: string; slug: string }
  | { kind: 'site'; domain: string }
  | { kind: 'myblog' }
  | { kind: 'editor'; postId: string | null };

interface Props {
  accessToken: string;
  username: string;
  isAdmin?: boolean;
  themeSetting: ThemeSetting;
  resolvedTheme: ResolvedTheme;
  onSetTheme: (t: ThemeSetting) => void;
  onLogout: () => void;
  onViewProfile?: (username: string) => void;
  navigate: (to: string) => void;
  view?: ShellView | null;
}

// Bare-letter shortcuts must not fire while the user is typing - otherwise "n"
// in a note or the search box would fling overlays open mid-sentence.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export default function NewTabPage({ accessToken, username, isAdmin, themeSetting, resolvedTheme, onSetTheme, onLogout, onViewProfile, navigate, view }: Props) {
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

  // Star or unstar a tag from wherever it's shown. The toggle rules - including
  // what unstarring a tag covered by a broader favorite does - live in
  // utils/favoriteTags, so every surface behaves the same.
  const handleToggleFavoriteTag = useCallback((tag: string) => {
    updateSetting({ favoriteTags: toggleFavorite(settings.favoriteTags ?? [], tag) });
  }, [settings.favoriteTags, updateSetting]);

  const handleSetFavoriteTags = useCallback((favoriteTags: string[]) => {
    updateSetting({ favoriteTags });
  }, [updateSetting]);

  const {
    folders, createFolder, updateFolder, deleteFolder, reorderFolders,
  } = useFolders(accessToken);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (folders.length > 0 && !activeFolderId) {
      setActiveFolderId(folders[0].id);
    }
  }, [folders, activeFolderId]);

  // ── Feeds ──────────────────────────────────────────────────────────────
  // Independent of bookmark folders since v1.11.0: one river, filed into its
  // own categories, managed from its own modal.
  const {
    subscriptions, folders: feedFolders, loaded: feedsLoaded,
    addFeed, addFeeds, updateFeed, removeFeed,
    createFolder: createFeedFolder, updateFolder: updateFeedFolder, removeFolder: removeFeedFolder,
  } = useFeeds(accessToken);
  const [showFeedManager, setShowFeedManager] = useState(false);
  const rssOn = settings.rssEnabled !== false;

  // The picker is a first-run thing, so it only asks the server for suggestions
  // when it's actually going to appear; the manager asks whenever it's open.
  const needsOnboarding = rssOn && settingsLoaded && feedsLoaded
    && settings.feedOnboarded !== true && subscriptions.length === 0;
  const { importable, reload: reloadImportable } = useImportableFeeds(accessToken, showFeedManager);
  const { suggested } = useSuggestedFeeds(accessToken, showFeedManager || needsOnboarding);

  const { bookmarks, setBookmarks, addBookmark, updateBookmark, deleteBookmark, reorderBookmarks, persistBookmarkOrder, checkFeed, markVisited } = useBookmarks(accessToken, activeFolderId);
  // Held whole as well as destructured: the embedded ProfilePage takes the
  // binding so its Library tab shares this exact list instead of loading a
  // second copy that would drift from it.
  const readingListBinding = useReadingList(accessToken);
  const { items: readingList, saveItem, updateItem, setInLibrary, removeItem, restoreItem, moveToFolder } = readingListBinding;
  // Shelves, so an article filed from the reading list can be dropped straight
  // onto one without a detour through the Library.
  const { folders: readingFolders, createFolder: createReadingFolder } = useReadingFolders(accessToken);

  // Naming a shelf from a card's Save menu. The colour isn't asked for there -
  // that menu is one field wide and the point is not to break the save you were
  // already making; the first unused hue is what the Library would have
  // suggested anyway, and it can be recoloured there.
  const handleCreateReadingFolder = useCallback(async (name: string) => {
    const created = await createReadingFolder(name, nextShelfColor(readingFolders));
    return created.id;
  }, [createReadingFolder, readingFolders]);

  const CACHE_KEY = `bfc_${username}`;

  const [bookmarksByFolder, setBookmarksByFolder] = useState<Record<string, Bookmark[]>>(() => {
    // Serve from localStorage instantly - avoids the blank-grid flash on every new tab
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, Bookmark[]>) : {};
    } catch { return {}; }
  });

  // Folder-less bookmarks - "pinned" to the top of the sidebar. Cached in the
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

  // Background feed checking - on folder switch and every 30min while the tab stays open
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

  // Bookmarklet mode - true when this window was opened by a bookmarklet
  const bookmarkletModeRef = useRef(false);
  const [bookmarkletAddUrl, setBookmarkletAddUrl] = useState('');

  // Modal state
  const [showAddLink, setShowAddLink] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [showAdmin, setShowAdmin] = useState(false);
  // Set when the admin panel is opened from a report alert, so it lands on that
  // report rather than the top of the queue. Cleared when the panel closes, or
  // when the moderator steps back to the full queue.
  const [focusReportId, setFocusReportId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const { unread: notifUnread, notifications, loading: notifLoading, loadList: loadNotifications, markAllRead: markNotificationsRead } = useNotifications(accessToken);
  // The thread reader: opened on a shared article link (/a/<id>) the app was
  // loaded at, or from a comment card on a profile, which also names the comment
  // to land on. It is an overlay rather than a shell view, so it carries its own
  // state instead of routing - ArticleDetailModal owns the /a/<id> history entry
  // while it is up, and putting it in the router as well would leave two things
  // pushing the same URL.
  const [thread, setThread] = useState<{ url: string; commentId?: string } | null>(() => {
    const url = parseArticlePath(window.location.pathname);
    if (!url) return null;
    const c = new URLSearchParams(window.location.search).get('c');
    return { url, commentId: c ?? undefined };
  });
  const openThread = useCallback((url: string, commentId?: string) => setThread({ url, commentId }), []);

  // A publisher's page is a real route, unlike the reader above: it is a page
  // you scroll and can link to, not an overlay over the one you were on.
  const goSite = useCallback((domain: string) => navigate(sitePathFor(domain)), [navigate]);

  // Following from a site page goes through the shell's subscription list, so
  // the feed panel, the manager and the category filter all see the new feed
  // without a reload. The URL handed over is the site's front page - the server
  // does its own feed discovery, and rejects with a message if there's nothing
  // to find. Uncategorised on purpose: filing it is a separate decision.
  const handleFollowSite = useCallback(async (siteUrl: string) => {
    await addFeed(siteUrl);
  }, [addFeed]);

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

  // Notes console - slides up from the bottom, opened via the launcher button
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

  // Publishing a note: hand the composer a copy and go there. The console owns
  // no routing of its own, so the trip is made from here - and since the
  // composer now lives in this shell, it is an ordinary navigation rather than
  // the document load startRepost still has to make from a standalone page.
  //
  // The console is dismissed on the way out: it slides over the bottom of the
  // page, and it would otherwise be sitting on top of the post it just seeded.
  const handleTurnNoteIntoPost = useCallback((title: string, body: string) => {
    stashSeed({ title, body });
    closeNotes();
    navigate('/blog/new');
  }, [navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  // What a note's /reference command can point at. Archived items stay on the
  // list: having finished an article is a reason to write about it, not a
  // reason to lose the ability to cite it.
  const noteReferences = useMemo(() => readingList.map(articleEmbed), [readingList]);

  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);

  // Only one overlay at a time. Opening the notes console, the command console,
  // or the new-bookmark dialog tears down every other dialog on screen -
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

  // "n" opens notes - the same letter the launcher button shows. Escape closes,
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
        // moved to different folder - remove from current folder cache
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
    // Keep the pinned list in sync - the edited bookmark may be a pinned one
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

  // Unpin: drop it from the pin grid. It remains in its folder - update in place.
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

  async function handleSaveFolder(id: string, updates: { name: string; color: string }) {
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

  // "Mark all read" in the feed clears every site badge in the rail. The server
  // has already recomputed them and hands back only what changed, but that list
  // covers subscribed feeds - a bookmark whose site you don't follow keeps its
  // own badge, so this zeroes what the feed can actually speak for rather than
  // wiping the rail wholesale.
  const handleAllFeedsMarkedRead = useCallback(() => {
    const followed = new Set(subscriptions.map(s => canonicalFeedUrl(s.url)));
    const clear = (b: Bookmark) =>
      b.feedUrl && followed.has(canonicalFeedUrl(b.feedUrl)) ? { ...b, unreadCount: 0 } : b;
    setBookmarks(prev => prev.map(clear));
    setBookmarksByFolder(prev => {
      const next: Record<string, Bookmark[]> = {};
      for (const [fid, list] of Object.entries(prev)) next[fid] = list.map(clear);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [subscriptions, setBookmarks]);

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

  const bookmarkLayout = settings.bookmarkLayout ?? 'panel';

  // Wide enough for two columns, or is the rail riding in the hamburger?
  const railNarrow = useMediaQuery(RAIL_NARROW);

  // The bookmarks rail. Built here - it needs every folder and bookmark handler
  // on this page - but rendered either in the sticky left column or inside the
  // shell bar's menu, never both. `close` is a no-op in the column and dismisses
  // the menu in the hamburger, so anything that puts a dialog on screen (or, in
  // panel layout, swaps the grid behind the menu) gets out of its own way.
  const renderRail = (close: () => void) => (
    <FolderSidebar
      folders={folders}
      activeFolderId={activeFolderId}
      bookmarksByFolder={bookmarksByFolder}
      pinnedBookmarks={pinnedBookmarks}
      layout={bookmarkLayout}
      username={username}
      bookmarkOpenMode={settings.bookmarkOpenMode}
      onSelectFolder={(id, el) => {
        handleSelectFolder(id, el);
        // Inline layout expands the folder in place - that's the result, and
        // closing the menu would hide it. Panel layout renders the result
        // behind the menu, so step aside.
        if (bookmarkLayout === 'panel') close();
      }}
      onNewFolder={() => { close(); setShowNewFolder(true); }}
      onNewBookmark={() => { close(); setShowAddLink(true); }}
      onEditFolder={f => { close(); setEditingFolder(f); }}
      onDeleteFolder={handleDeleteFolder}
      onMarkFolderRead={handleMarkFolderRead}
      onReorderFolders={reorderFolders}
      onEditBookmark={b => { close(); setEditingBookmark(b); }}
      onDeleteBookmark={handleDeleteBookmark}
      onVisitBookmark={id => { close(); markVisited(id); }}
      onPinBookmark={handlePinBookmark}
      onUnpinBookmark={handleUnpinBookmark}
      onReorderPinned={handleReorderPinned}
      onReorderBookmarks={handleReorderBookmarksInFolder}
      folderRefs={folderRefs}
    />
  );

  // The app's one search box, handed to the bar that hosts it.
  const searchEl = (
    <SearchBar
      searchEngine={settings.searchEngine}
      searchNewTab={settings.searchNewTab}
      bookmarks={[...Object.values(bookmarksByFolder).flat(), ...pinnedBookmarks]}
      readingItems={readingList}
      feedArticles={feedArticles.map(a => ({ id: a.id, url: a.link, title: a.title, source: a.source, categories: a.categories }))}
      notes={(settings.noteDocs ?? []).filter(n => !n.deletedAt)}
      onOpenNote={openNoteFromSearch}
    />
  );

  // Background motion - the blobs lean gently toward the cursor. The pointer is
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
      {/* Background - spans the whole page, beneath all content (z-index 0) */}
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
      {/* One chrome for every page the shell hosts - the new tab, a profile, a
          post, the blog manager. The bar carries the only search box in the
          app, so it is never conditional. */}
      <ShellBar
        username={username}
        avatar={profile?.avatar}
        isAdmin={isAdmin}
        notifUnread={notifUnread}
        navigate={navigate}
        onOpenSettings={() => { setSettingsSection(undefined); setShowSettings(true); }}
        onOpenAdmin={() => setShowAdmin(true)}
        onOpenNotifications={() => setShowNotifications(true)}
        onLogout={onLogout}
        search={searchEl}
        // A profile or a post takes the whole body and has no rail, so there is
        // nothing to fold into the menu on those.
        bookmarksRail={renderRail}
      />

      <div className={styles.content}>
        {/* One body shape for every page the shell hosts: the rail on the left,
            whatever you came for on the right. The rail is chrome, not part of
            the new tab - bookmarks are just as worth reaching from a profile or
            a post as from the feed. Only the right-hand column changes. */}
        <div className={styles.bodyGrid}>
          {/* The rail pins itself beside the body so bookmarks stay reachable
              however far the page scrolls. Below RAIL_NARROW it isn't here at
              all - the shell bar's menu has it. */}
          {!railNarrow && (
            <div className={styles.leftCol}>
              {renderRail(() => {})}
            </div>
          )}

        {view ? (
          <div className={styles.viewBody}>
            {view.kind === 'profile' && (
              <ProfilePage
                embedded
                username={view.username}
                accessToken={accessToken}
                currentUsername={username}
                navigate={navigate}
                library={readingListBinding}
                onOpenArticle={setArticleUrl}
                onOpenThread={openThread}
                initialTab={view.tab}
                // Clicking your own avatar lands on Account, where the photo,
                // the cover and the links all live.
                onEditProfile={() => { setSettingsSection('account'); setShowSettings(true); }}
              />
            )}
            {view.kind === 'post' && (
              <BlogPostPage
                embedded
                username={view.username}
                slug={view.slug}
                accessToken={accessToken}
                navigate={navigate}
              />
            )}
            {view.kind === 'site' && (
              // Keyed on the domain: following a byline from one site page to
              // another changes the prop, and every piece of state in there
              // (the loaded pages, a subscribe error) belongs to the old site.
              <SitePage
                key={view.domain}
                domain={view.domain}
                navigate={navigate}
                onOpenThread={openThread}
                onFollowSite={handleFollowSite}
                layout={settings.siteLayout ?? 'list'}
                onLayoutChange={l => updateSetting({ siteLayout: l })}
              />
            )}
            {view.kind === 'myblog' && (
              <MyBlogPage
                embedded
                accessToken={accessToken}
                username={username}
                navigate={navigate}
              />
            )}
            {view.kind === 'editor' && (
              // Keyed on the post so switching between two of them remounts the
              // composer: RichEditor reads its HTML on mount only, and the
              // autosave timers belong to the draft that started them.
              <BlogEditorPage
                key={view.postId ?? 'new'}
                postId={view.postId}
                accessToken={accessToken}
                username={username}
                navigate={navigate}
              />
            )}
          </div>
        ) : (
          <div>
            {bookmarkLayout === 'panel' && (
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
                onOpenSite={goSite}
                bookmarkOpenMode={settings.bookmarkOpenMode}
              />
            )}
            <div className={styles.bottomRow}>
              <ReadingList
                items={readingList}
                onSave={saveItem}
                onUpdate={updateItem}
                onAddToLibrary={setInLibrary}
                onDelete={removeItem}
                onRestore={restoreItem}
                readingFolders={readingFolders}
                onCreateFolder={handleCreateReadingFolder}
                onMoveToFolder={moveToFolder}
                onOpenLibrary={() => navigate(`${profilePathFor(username)}?tab=library`)}
                articleOpenMode={(() => {
                const m = settings.readingListOpenMode ?? settings.articleOpenMode;
                return m === 'reader' ? 'iframe' : m;
              })()}
                onOpenArticle={setArticleUrl}
                layout={settings.readingListLayout ?? 'magazine'}
                onLayoutChange={l => updateSetting({ readingListLayout: l })}
                commentPrefs={commentPrefs}
                onViewProfile={onViewProfile}
                onOpenSite={goSite}
                favoriteTags={settings.favoriteTags ?? []}
                onToggleFavoriteTag={handleToggleFavoriteTag}
                onSetFavoriteTags={handleSetFavoriteTags}
              />
            </div>
            {/* No longer gated on the active folder having feeds: the feed is
                the whole account's, and the panel handles its own empty state
                (which is the one that offers to fix it). */}
            {rssOn && (
              <FeedPanel
                feedFolders={feedFolders}
                subscriptionCount={subscriptions.length}
                onManageFeeds={() => setShowFeedManager(true)}
                onSaveArticle={async (a, card, dest) => {
                  const fields = {
                    url: a.url,
                    title: a.title,
                    source: a.source,
                    readTime: a.readTime != null ? `${a.readTime} min` : '',
                    tag: a.categories.map(c => c.trim().toLowerCase()).filter(Boolean).join(','),
                    imageUrl: a.imageUrl ?? '',
                  };
                  // Both committed paths grey the card first and talk to the
                  // server after. They used to wait for the round trip - two of
                  // them, for a shelf - which left the card looking untouched
                  // for as long as the network took, so the press read as
                  // having missed. Every other write in the reading list
                  // already commits locally and reconciles behind the scenes
                  // (see useReadingList); this is the one that didn't.
                  //
                  // Picking a shelf is already a decision about this article, so
                  // it never stops for the dialog - and it skips the reading
                  // list, since filing it there first would only mean fishing it
                  // back out again.
                  if (dest) {
                    card.markSaved();
                    try {
                      const created = await saveItem(fields);
                      if (dest.folderId) await moveToFolder(created.id, dest.folderId);
                      else await setInLibrary(created.id, true);
                    } catch {
                      card.restore();
                    }
                    return;
                  }
                  if ((settings.saveArticleMode ?? 'dialog') === 'instant') {
                    // Save with the article's own metadata - no dialog
                    card.markSaved();
                    try {
                      await saveItem(fields);
                    } catch {
                      card.restore();
                    }
                  } else {
                    // The dialog is its own feedback: it holds the screen while
                    // it saves and stays open if that fails. So this one waits
                    // for the real answer - by the time the dialog is out of the
                    // way the card behind it is already grey.
                    setSavingArticle({ ...a, markSaved: card.markSaved });
                  }
                }}
                readingFolders={readingFolders}
                onCreateFolder={handleCreateReadingFolder}
                onArticlesLoaded={handleFeedArticlesLoaded}
                refreshKey={feedRefreshKey}
                pageSize={settings.rssFeedPageSize ?? 10}
                layout={settings.rssLayout ?? 'magazine'}
                onLayoutChange={l => updateSetting({ rssLayout: l })}
                markReadOnScroll={settings.markReadOnScroll !== false}
                onUnreadCountsChange={handleUnreadCountsChange}
                commentPrefs={commentPrefs}
                onAllMarkedRead={handleAllFeedsMarkedRead}
                onViewProfile={onViewProfile}
                onOpenSite={goSite}
                favoriteTags={settings.favoriteTags ?? []}
                onToggleFavoriteTag={handleToggleFavoriteTag}
                onSetFavoriteTags={handleSetFavoriteTags}
              />
            )}
          </div>
        )}
        </div>

      </div>

      {/* Outside .content so the footer's hairline spans the page rather than
          stopping at the body column's 32px gutters. */}
      <SiteFooter />
      </div>

      {/* Fixed to the viewport, so it belongs outside .page's flow. Stacks above
          the notes launcher below. */}
      <BackToTop />

      {/* Notes launcher - small round button, bottom-right */}
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
          onSave={handleSaveFolder}
          onDelete={handleDeleteFolder}
          onClose={() => setEditingFolder(null)}
        />
      )}

      {showFeedManager && (
        <FeedManagerModal
          subscriptions={subscriptions}
          folders={feedFolders}
          importable={importable}
          suggested={suggested}
          onAddFeed={addFeed}
          onAddFeeds={addFeeds}
          onUpdateFeed={updateFeed}
          onRemoveFeed={removeFeed}
          onCreateFolder={createFeedFolder}
          onUpdateFolder={updateFeedFolder}
          onRemoveFolder={removeFeedFolder}
          onRefreshImportable={reloadImportable}
          onClose={() => {
            setShowFeedManager(false);
            // Whatever changed, the river changed with it.
            setFeedRefreshKey(k => k + 1);
          }}
        />
      )}

      {/* First run only. Marked seen whichever way it's dismissed, so it can
          never come back and ask twice. */}
      {needsOnboarding && (
        <FeedOnboarding
          suggested={suggested}
          onFollow={feeds => addFeeds(feeds)}
          onDone={() => {
            updateSetting({ feedOnboarded: true });
            setFeedRefreshKey(k => k + 1);
          }}
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
        <AdminModal
          currentUsername={username}
          onClose={() => { setShowAdmin(false); setFocusReportId(null); }}
          // Every @handle in the admin tables routes to that person's profile.
          // The panel has to close first - the profile renders in the shell
          // underneath it.
          onViewProfile={name => { setShowAdmin(false); onViewProfile?.(name); }}
          focusReportId={focusReportId}
          onClearFocusReport={() => setFocusReportId(null)}
        />
      )}

      {showNotifications && (
        <NotificationsModal
          accessToken={accessToken}
          notifications={notifications}
          notifLoading={notifLoading}
          onLoadNotifications={loadNotifications}
          onMarkAllRead={markNotificationsRead}
          onClose={() => setShowNotifications(false)}
          onViewProfile={onViewProfile}
          // Report alerts open the moderation queue. Offered only to admins -
          // nobody else is ever sent one.
          onOpenReport={isAdmin ? (id => { setFocusReportId(id); setShowAdmin(true); }) : undefined}
        />
      )}

      {/* Reader opened from a shared /a/<id> link, or from a comment card on a
          profile - resolves content by URL either way. */}
      {thread && (
        <ArticleDetailModal
          url={thread.url}
          title=""
          prefs={commentPrefs}
          focusCommentId={thread.commentId}
          onClose={() => setThread(null)}
          onViewProfile={onViewProfile}
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
          references={noteReferences}
          onTurnIntoPost={handleTurnNoteIntoPost}
          closing={notesFading}
          onClose={closeNotes}
        />
      )}
    </div>
    </>
  );
}
