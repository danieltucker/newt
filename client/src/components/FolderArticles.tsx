import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from '../services/api';
import { FeedArticle, CommentPrefs, ReadingFolder } from '../types';
import { faviconUrl } from '../utils/color';
import { blogAuthorOfUrl } from '../utils/blogUrl';
import { profilePathFor } from '../utils/profileUrl';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { CommentBar } from './CommentsPanel';
import ArticleDetailModal from './ArticleDetailModal';
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from './LayoutSwitch';
import FilterDropdown from './FilterDropdown';
import TagChip from './TagChip';
import FavoritesControl from './FavoritesControl';
import SaveButton, { SaveDestination } from './SaveButton';
import { prepareFavorites, favoritesFor, coveringFavorites } from '../utils/favoriteTags';
import styles from './FolderArticles.module.css';

export type RssLayout = 'list' | 'cards' | 'magazine';

const LAYOUT_OPTIONS = [
  { value: 'list' as const,     title: 'List',     icon: <ListIcon /> },
  { value: 'cards' as const,    title: 'Cards',    icon: <CardsIcon /> },
  { value: 'magazine' as const, title: 'Magazine', icon: <MagazineIcon /> },
];

// Above this many topics, the chip row collapses into a searchable dropdown
const MAX_TOPIC_CHIPS = 12;

// How long to sit on newly-read ids before sending them up, so a fast scroll
// through a screenful costs one request instead of a dozen
const READ_FLUSH_MS = 600;

// A card that's been dealt with - dismissed, or saved to the reading list - but
// is still drawn in its slot, greyed out, until the feed reloads. Removing it
// outright pulls every card below it up, and the next click lands on whatever
// slid into place. Only a dismissal is undoable: undoing a save would have to
// decide what to do with the reading-list copy, and "put the card back" isn't
// obviously that. Both are already committed server-side.
type GhostKind = 'dismissed' | 'saved';

interface Ghost {
  kind: GhostKind;
  /** Where a save went - the placeholder names it, since the Save button can
      now put an article somewhere other than the reading list. */
  dest?: string;
}

interface Props {
  folderId: string;
  /** `dest` is set only when the reader picked a Library shelf over the
      reading list; a null folderId inside it means Unsorted. */
  onSaveArticle: (
    a: { id: string; url: string; title: string; source: string; categories: string[]; readTime: number | null; imageUrl: string | null },
    markSaved: () => void,
    dest?: { folderId: string | null },
  ) => void;
  /** Library shelves, offered behind the Save button's caret. */
  readingFolders?: ReadingFolder[];
  /** Make a new shelf and resolve to its id, from that same menu. */
  onCreateFolder?: (name: string) => Promise<string>;
  onArticlesLoaded?: (articles: FeedArticle[]) => void;
  refreshKey?: number;
  pageSize?: number;
  layout?: RssLayout;
  onLayoutChange?: (layout: RssLayout) => void;
  markReadOnScroll?: boolean;
  onUnreadCountsChange?: (updates: { id: string; unreadCount: number }[]) => void;
  commentPrefs: CommentPrefs;
  // Clears the folder's site badges once its articles have been marked read
  onFolderMarkedRead?: (folderId: string) => void;
  onViewProfile?: (username: string) => void;
  /** Tags worth flagging, as the user typed them. See utils/favoriteTags. */
  favoriteTags?: string[];
  /** Star/unstar one tag, from a tag chip. */
  onToggleFavoriteTag?: (tag: string) => void;
  /** Replace the whole list, from the manager behind the Favorites chip. */
  onSetFavoriteTags?: (tags: string[]) => void;
}

function relativeDate(s: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// Not a folder id, so it can't collide with one.
const READING_LIST_DEST = 'reading-list';

// Where Save can put this article. The reading list leads and is what the label
// alone does; a Library shelf below it is for the pieces you already know you're
// keeping rather than queueing. Shared by the card and the reader so the two
// can't drift apart about what Save means.
function destinationsFor(folders: ReadingFolder[]): SaveDestination[] {
  return [
    { id: READING_LIST_DEST, label: 'Reading list', hint: 'Default' },
    { id: '', label: 'Unsorted', group: 'Library' },
    ...folders.map(f => ({ id: f.id, label: f.name, group: 'Library' })),
  ];
}

/** What the "Saved to …" placeholder calls a shelf. '' is Unsorted, a real shelf. */
function shelfLabel(id: string, folders: ReadingFolder[]): string {
  return folders.find(f => f.id === id)?.name ?? 'Unsorted';
}

const BookmarkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const CheckAllIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="1 13 5 17 13 6" />
    <polyline points="10 15 12 17 22 6" />
  </svg>
);

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// The site's front page, for the byline link on an external article: the story
// itself is one click away on the title, so the source name should go where its
// name points - the publication, not the article again.
function siteHomeOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

// ── Magazine layout variants ──────────────────────────────────────────
type MagVariant = 'feature' | 'standard' | 'text' | 'brief';

// Cheap stable hash so a card keeps its look across refreshes
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Editorial mix: long reads with artwork become wide features (spaced out so
// they don't stack), short pieces run as full-text briefs, and the rest
// alternate between image and text-only cards on a stable per-article hash.
function magazineVariants(articles: FeedArticle[]): MagVariant[] {
  let sinceFeature = 4; // lets the first feature lead the page
  return articles.map(a => {
    const readTime = a.readTime ?? 0;
    const snippetLen = a.snippet?.length ?? 0;
    // The snippet is essentially the whole piece - run it in full. The server
    // truncates long content to ~200 chars ending in "…", so a trailing
    // ellipsis means there's more to read and it is NOT a brief.
    const complete = snippetLen > 0 && !/(…|\.\.\.)\s*$/.test(a.snippet!);
    if (complete && snippetLen <= 220 && readTime <= 2) {
      sinceFeature++;
      return 'brief';
    }
    // Long reads and meaty summaries always qualify; the hash fallback keeps
    // features appearing (~every screenful) on feeds of uniformly short items
    const featureWorthy = !!a.imageUrl &&
      (readTime >= 4 || snippetLen >= 240 || hashId(a.id) % 3 === 0);
    if (featureWorthy && sinceFeature >= 4) {
      sinceFeature = 0;
      return 'feature';
    }
    sinceFeature++;
    if (!a.imageUrl) return 'text';
    return hashId(a.id) % 4 === 0 ? 'text' : 'standard';
  });
}

export default function FolderArticles({ folderId, onSaveArticle, readingFolders = [], onCreateFolder, onArticlesLoaded, refreshKey, pageSize = 10, layout = 'cards', onLayoutChange, markReadOnScroll = true, onUnreadCountsChange, commentPrefs, onFolderMarkedRead, onViewProfile, favoriteTags = [], onToggleFavoriteTag, onSetFavoriteTags }: Props) {
  const seededFolders = useRef<Set<string>>(new Set());
  const [readIds, setReadIds]           = useState<Set<string>>(new Set());
  const [articles, setArticles]         = useState<FeedArticle[]>([]);
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(true);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [error, setError]               = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [ghosts, setGhosts] = useState<Map<string, Ghost>>(new Map());
  // Folder-wide, straight from the server, so the chip agrees with the site
  // tiles in the rail rather than counting only what happens to be loaded.
  const [unreadTotal, setUnreadTotal] = useState(0);

  // ── What the unread filter shows ──
  // Not "everything currently unread": read-on-scroll would then delete each
  // card as you passed it and you'd never reach the bottom. Instead an article
  // is judged once, when it first comes under the filter, and keeps its place
  // for as long as the filter stays on.
  //
  // The first cut of this snapshotted the read set instead, and tested new
  // arrivals against that snapshot - so every already-read article on every page
  // fetched afterwards passed the filter, which is why the list filled up with
  // cards carrying no unread outline.
  const [unreadPinned, setUnreadPinned] = useState<Set<string>>(new Set());
  // Ids the filter has already ruled on, so each is judged exactly once.
  const unreadJudged = useRef<Set<string>>(new Set());

  // Tokenize the favorites once per change, not once per card.
  const favorites = useMemo(() => prepareFavorites(favoriteTags), [favoriteTags]);

  // Which favorites each article hits, keyed by id. Runs over the loaded page
  // only - this decorates what's on screen and is not a way to rank the feed;
  // articles on later pages haven't been fetched. See utils/favoriteTags.
  const favHits = useMemo(() => {
    const m = new Map<string, string[]>();
    if (favorites.length === 0) return m;
    for (const a of articles) {
      const hits = favoritesFor(a.categories, favorites);
      if (hits.length > 0) m.set(a.id, hits);
    }
    return m;
  }, [articles, favorites]);

  const allCategories = useMemo(
    () => Array.from(new Set(articles.flatMap(a => a.categories))).sort(),
    [articles]
  );

  const allSources = useMemo(
    () => Array.from(new Set(articles.map(a => a.source).filter(Boolean))).sort(),
    [articles]
  );

  const displayed = articles.filter(a =>
    (!activeCategory || a.categories.includes(activeCategory)) &&
    (!activeSource || a.source === activeSource) &&
    (!favoritesOnly || favHits.has(a.id)) &&
    // A ghost keeps its slot whatever the unread filter says - it was on screen
    // a moment ago and pulling it now would undo the point of leaving it there.
    (!unreadOnly || ghosts.has(a.id) || unreadPinned.has(a.id))
  );

  // The filter has to go when its last match does, or you're left staring at an
  // empty feed with no obvious way out.
  useEffect(() => {
    if (favoritesOnly && favorites.length === 0) setFavoritesOnly(false);
  }, [favoritesOnly, favorites.length]);

  const load = useCallback(async (offset = 0, existing: FeedArticle[] = []) => {
    offset === 0 ? setLoading(true) : setLoadingMore(true);
    setError('');
    try {
      const r = await apiFetch(`/api/v1/folders/${folderId}/articles?offset=${offset}&limit=${pageSize}`);
      if (!r.ok) { setError('Could not load feed'); return; }
      const data: { articles: FeedArticle[]; total: number; unread?: number } = await r.json();
      const merged = offset === 0 ? data.articles : [...existing, ...data.articles];
      setArticles(merged);
      setTotal(data.total);
      if (typeof data.unread === 'number') setUnreadTotal(data.unread);
      // Union rather than replace - ids marked read locally this session may not
      // have reached the server yet
      const serverRead = data.articles.filter(a => a.read).map(a => a.id);
      if (serverRead.length > 0) setReadIds(prev => new Set([...prev, ...serverRead]));
    } catch {
      setError('Could not load feed');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [folderId]);

  useEffect(() => {
    setArticles([]);
    setTotal(0);
    setReadIds(new Set());
    setActiveCategory(null);
    setActiveSource(null);
    // A reload is exactly what clears the placeholders - the dismissed items
    // simply won't come back in the response.
    setGhosts(new Map());
    setUnreadOnly(false);
    setUnreadPinned(new Set());
    unreadJudged.current = new Set();
    // Cleared here rather than in its own effect so it happens before the read
    // sweep seeds it - the other order wiped the seeding on every folder switch.
    seenRef.current = new Set();
    load(0, []);
  }, [folderId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Read-on-scroll ────────────────────────────────────────────────────
  // A card flips to read once it has been on screen and then leaves past the
  // top of the viewport. Requiring it to have been seen first means "load more"
  // and folder switches can't retroactively mark a backlog you never looked at.
  const seenRef    = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const cardEls    = useRef<Map<string, HTMLElement>>(new Map());
  // Mirrors readIds - the observer callback can't see fresh state through its closure
  const readIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { readIdsRef.current = new Set(readIds); }, [readIds]);
  // Same reason as readIdsRef: the scroll sweep runs outside React and can't see
  // fresh state through its closure.
  const ghostsRef = useRef<Map<string, Ghost>>(new Map());
  useEffect(() => { ghostsRef.current = ghosts; }, [ghosts]);

  // Pages fetched while the unread filter is on get judged as they land, on the
  // read state they arrive with. Declared after the mirror above so readIdsRef
  // is already up to date for the same commit that added the articles.
  useEffect(() => {
    if (!unreadOnly) return;
    let added = false;
    const next = new Set(unreadPinned);
    for (const a of articles) {
      if (unreadJudged.current.has(a.id)) continue;
      unreadJudged.current.add(a.id);
      if (!readIdsRef.current.has(a.id)) { next.add(a.id); added = true; }
    }
    if (added) setUnreadPinned(next);
  }, [articles, unreadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushRead = useCallback(async () => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    const itemIds = Array.from(pendingRef.current);
    if (itemIds.length === 0) return;
    pendingRef.current.clear();
    try {
      const r = await apiFetch(`/api/v1/folders/${folderId}/articles/read`, {
        method: 'POST',
        body: JSON.stringify({ itemIds }),
      });
      if (!r.ok) return;
      // Every id in this batch was unread when it went into the queue (see the
      // observer below), so each is one genuine transition - drawing the chip
      // down by the batch size keeps it in step with the rail's badges, which
      // the same response updates.
      setUnreadTotal(n => Math.max(0, n - itemIds.length));
      const data: { bookmarks: { id: string; unreadCount: number }[] } = await r.json();
      if (data.bookmarks?.length) onUnreadCountsChange?.(data.bookmarks);
    } catch {
      // Read state is disposable - a failed flush just means it re-marks later
    }
  }, [folderId, onUnreadCountsChange]);

  // Keeps unmount/visibility handlers off the flushRead identity
  const flushRef = useRef(flushRead);
  useEffect(() => { flushRef.current = flushRead; }, [flushRead]);

  // One pass over where the cards actually are. A card counts as read once it
  // sits entirely above the top of the viewport, having previously been at or
  // below it - the "previously" is what stops a folder switch or a Load more
  // from retroactively marking a backlog nobody looked at.
  //
  // This was an IntersectionObserver watching for exit events, which is why
  // articles were being skipped: the observer coalesces, and a card that goes
  // from below the fold to above it between two callbacks reports neither edge,
  // so it was never marked. Geometry can't miss - the sweep sees where every
  // mounted card is, not just the ones that happened to fire.
  const sweepRead = useCallback(() => {
    const justRead: string[] = [];
    for (const [id, el] of cardEls.current) {
      // A dismissed card is still mounted as a placeholder. Marking it read as
      // it scrolls by would count it twice against the unread total, which the
      // dismissal has already drawn down - and "read" is meaningless for
      // something you threw away.
      if (ghostsRef.current.has(id)) continue;
      const rect = el.getBoundingClientRect();
      // A detached or display:none card measures 0x0 at the origin; treat it as
      // nothing rather than as "scrolled past".
      if (rect.height === 0 && rect.width === 0) continue;
      if (rect.bottom > 0) { seenRef.current.add(id); continue; }
      if (seenRef.current.has(id) && !readIdsRef.current.has(id)) justRead.push(id);
    }
    if (justRead.length === 0) return;
    // Outline clears immediately; the server hears about it on the next flush
    for (const id of justRead) {
      readIdsRef.current.add(id);
      pendingRef.current.add(id);
    }
    setReadIds(new Set(readIdsRef.current));
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => { flushRef.current(); }, READ_FLUSH_MS);
  }, []);

  useEffect(() => {
    if (!markReadOnScroll) return;
    let queued = false;
    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; sweepRead(); });
    }
    // Seeds seenRef for everything already on screen, so the first scroll has
    // something to compare against.
    sweepRead();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [markReadOnScroll, folderId, sweepRead]);

  // Newly appended pages need seeding too, or the first card of a page fetched
  // while you were already scrolled down would be above the fold on its very
  // first sweep and get skipped for never having been "seen".
  useEffect(() => {
    if (!markReadOnScroll) return;
    sweepRead();
  }, [articles, markReadOnScroll, sweepRead]);

  // Don't lose queued ids to a tab close or a folder switch
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushRef.current(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flushRef.current();
    };
  }, [folderId]);


  const observeCard = useCallback((el: HTMLDivElement | null, id: string) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);

  // Infinite scroll - when the sentinel below the list enters the viewport,
  // fetch the next page (the button remains as a manual fallback)
  const hasMore = articles.length < total;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !loadingMore) load(articles.length, articles);
    }, { rootMargin: '300px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, loadingMore, articles, load]);

  // Background load for search seeding - fires at most once per folder per session
  useEffect(() => {
    if (!onArticlesLoaded || seededFolders.current.has(folderId)) return;
    seededFolders.current.add(folderId);
    apiFetch(`/api/v1/folders/${folderId}/articles?includeAll=true&limit=200`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { articles: FeedArticle[] } | null) => {
        if (data?.articles?.length) onArticlesLoaded(data.articles);
      })
      .catch(() => {});
  }, [folderId, onArticlesLoaded]);

  const { counts: commentCounts, setCount: setCommentCount } = useCommentCounts(
    useMemo(() => articles.map(a => a.link), [articles])
  );

  // The article open in the reader modal
  const [reading, setReading] = useState<FeedArticle | null>(null);

  // ── Mark every article in this folder read ────────────────────────────
  // Covers the pages that haven't been scrolled to yet, which is the whole
  // point - the server walks the folder's feeds rather than the loaded list.
  const [markingAll, setMarkingAll] = useState(false);
  const unreadShowing = markReadOnScroll && displayed.some(a => !readIds.has(a.id) && !ghosts.has(a.id));

  async function handleMarkAllRead() {
    if (markingAll) return;
    setMarkingAll(true);
    // Anything already queued would otherwise land after the bulk write
    pendingRef.current.clear();
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    try {
      const r = await apiFetch(`/api/v1/folders/${folderId}/articles/read-all`, { method: 'POST' });
      if (r.ok) {
        const data: { itemIds: string[] } = await r.json();
        for (const id of data.itemIds ?? []) readIdsRef.current.add(id);
        // Whatever is on screen is read now, even if the feed shifted mid-call
        for (const a of articles) readIdsRef.current.add(a.id);
        setReadIds(new Set(readIdsRef.current));
        setUnreadTotal(0);
        onFolderMarkedRead?.(folderId);
      }
    } catch {
      // Read state is disposable - scrolling will re-mark on the next pass
    } finally {
      setMarkingAll(false);
    }
  }

  // `dest` is what the Save button's caret picked: absent means the reading
  // list, which is what pressing the label alone does. A Library shelf skips
  // the reading list entirely - the article is one you're filing, not one
  // you're queueing to read.
  function handleSave(a: FeedArticle, dest?: { folderId: string | null; label: string }) {
    onSaveArticle(
      { id: a.id, url: a.link, title: a.title, source: a.source, categories: a.categories, readTime: a.readTime, imageUrl: a.imageUrl },
      // Once it's saved it leaves the feed (dismissed server-side, so it stays
      // gone across refreshes)
      () => handleDismiss(a.id, 'saved', dest?.label ?? 'reading list'),
      dest ? { folderId: dest.folderId } : undefined
    );
  }

  // Commits straight away. The card stays in the list as a greyed-out
  // placeholder so nothing below it moves; the next load is what clears it,
  // which is also when the feed is expected to re-lay out.
  // Both endpoints hand back the site tiles whose badge changed, because a
  // dismissal takes the article off those counts too - without this the rail
  // went on advertising articles the feed had already dropped.
  async function applyBadges(res: Response) {
    if (!res.ok) return;
    const data: { bookmarks?: { id: string; unreadCount: number }[] } = await res.json();
    if (data.bookmarks?.length) onUnreadCountsChange?.(data.bookmarks);
  }

  function handleDismiss(articleId: string, kind: GhostKind = 'dismissed', dest?: string) {
    setGhosts(prev => new Map(prev).set(articleId, { kind, dest }));
    // Only an unread article was being counted, so only that one moves the chip.
    if (!readIdsRef.current.has(articleId)) setUnreadTotal(n => Math.max(0, n - 1));
    apiFetch(`/api/v1/folders/${folderId}/articles/${articleId}`, { method: 'DELETE' })
      .then(applyBadges).catch(() => {});
  }

  function handleUndoDismiss(articleId: string) {
    setGhosts(prev => { const m = new Map(prev); m.delete(articleId); return m; });
    if (!readIdsRef.current.has(articleId)) setUnreadTotal(n => n + 1);
    apiFetch(`/api/v1/folders/${folderId}/articles/${articleId}/restore`, { method: 'POST' })
      .then(applyBadges).catch(() => {});
  }

  function toggleUnreadOnly() {
    if (unreadOnly) { setUnreadOnly(false); return; }
    const pinned = new Set<string>();
    unreadJudged.current = new Set();
    for (const a of articles) {
      unreadJudged.current.add(a.id);
      if (!readIdsRef.current.has(a.id)) pinned.add(a.id);
    }
    setUnreadPinned(pinned);
    setUnreadOnly(true);
  }

  if (loading) return (
    <div className={styles.wrap}>
      <div className={styles.sectionLabel}>Feed Articles</div>
      <div className={styles.status}><span className={styles.spinner} /> Fetching feeds…</div>
    </div>
  );

  if (error) return (
    <div className={styles.wrap}>
      <div className={styles.sectionLabel}>Feed Articles</div>
      <div className={styles.statusError}>{error}</div>
    </div>
  );

  if (articles.length === 0) return (
    <div className={styles.wrap}>
      <div className={styles.sectionLabel}>Feed Articles</div>
      <div className={styles.status} style={{ opacity: 0.45 }}>No articles yet - feeds refresh every 30 minutes.</div>
    </div>
  );

  const gridClass = layout === 'list' ? styles.gridList
    : layout === 'magazine' ? styles.gridMagazine
    : styles.grid;

  const variants = layout === 'magazine' ? magazineVariants(displayed) : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.headerRow}>
        <div className={styles.sectionLabel}>
          Feed Articles
          {/* `total` still counts the placeholders, because it's also what
              paging measures against - articles.length includes them too, so
              decrementing it here would strand the last page. Only the label
              nets them out. */}
          <span className={styles.count}>{Math.max(0, total - ghosts.size)}</span>
        </div>
        <div className={styles.headerActions}>
          {markReadOnScroll && (
            <button
              className={styles.markAllBtn}
              onClick={handleMarkAllRead}
              disabled={markingAll || !unreadShowing}
              title="Mark every article in this folder as read"
            >
              <CheckAllIcon />
              {markingAll ? 'Marking…' : 'Mark all read'}
            </button>
          )}
          {onLayoutChange && (
            <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Feed layout" />
          )}
        </div>
      </div>

      {(allCategories.length > 1 || allSources.length > 1 || favHits.size > 0 || markReadOnScroll) && (
        <div className={styles.chips}>
          {/* Read state is only tracked when read-on-scroll is on, so without it
              there is no such thing as unread here to filter to. */}
          {markReadOnScroll && (
            <button
              className={`${styles.chip} ${styles.unreadChip} ${unreadOnly ? styles.chipActive : ''}`}
              onClick={toggleUnreadOnly}
              aria-pressed={unreadOnly}
              disabled={!unreadOnly && unreadTotal === 0}
              title={unreadOnly
                ? 'Show every article again'
                : `Show only articles you haven’t read yet (${unreadTotal} in this folder)`}
            >
              Unread
              <span className={styles.chipCount}>{unreadTotal}</span>
            </button>
          )}
          {/* Shown whenever there's a list to manage, not only when something
              matches - otherwise a favorite that has stopped matching becomes
              unreachable from the page it's affecting. The filter button
              disables itself at zero. */}
          {onToggleFavoriteTag && (favoriteTags.length > 0 || favHits.size > 0) && (
            <FavoritesControl
              favorites={favoriteTags}
              onChange={onSetFavoriteTags ?? (() => {})}
              count={favHits.size}
              filterOn={favoritesOnly}
              onToggleFilter={() => setFavoritesOnly(v => !v)}
              chipClassName={`${styles.chip} ${styles.favChip}`}
              chipActiveClassName={styles.favChipActive}
            />
          )}
          {allCategories.length > 1 && (
            <button
              className={`${styles.chip} ${activeCategory === null ? styles.chipActive : ''}`}
              onClick={() => setActiveCategory(null)}
            >
              All
            </button>
          )}
          {allCategories.length > 1 && allCategories.length <= MAX_TOPIC_CHIPS && allCategories.map(c => (
            <button
              key={c}
              className={`${styles.chip} ${activeCategory === c ? styles.chipActive : ''}`}
              onClick={() => setActiveCategory(activeCategory === c ? null : c)}
            >
              {c}
            </button>
          ))}
          {allCategories.length > MAX_TOPIC_CHIPS && (
            <FilterDropdown
              label="Topics"
              options={allCategories}
              value={activeCategory}
              onChange={setActiveCategory}
              searchable
            />
          )}
          {allSources.length > 1 && (
            <div className={styles.sourceFilter}>
              <FilterDropdown
                label="All sites"
                options={allSources}
                value={activeSource}
                onChange={setActiveSource}
                searchable={allSources.length > 8}
                align="right"
              />
            </div>
          )}
        </div>
      )}

      <div className={gridClass}>
        {displayed.length === 0 ? (
          <div className={styles.status} style={{ opacity: 0.45 }}>
            {unreadOnly ? 'Nothing unread here - everything on this page has been read.'
              : 'No articles match these filters.'}
          </div>
        ) : displayed.map((a, i) => (
          <ArticleCard
            key={a.id}
            article={a}
            variant={variants?.[i]}
            isNew={markReadOnScroll && !readIds.has(a.id)}
            ghost={ghosts.get(a.id)}
            cardRef={markReadOnScroll ? observeCard : undefined}
            onSave={dest => handleSave(a, dest)}
            onDismiss={() => handleDismiss(a.id)}
            onUndoDismiss={() => handleUndoDismiss(a.id)}
            readingFolders={readingFolders}
            onCreateFolder={onCreateFolder}
            commentCount={commentCounts[a.link] ?? 0}
            onOpenReader={() => setReading(a)}
            onViewProfile={onViewProfile}
            favHits={favHits.get(a.id)}
            favoriteTags={favoriteTags}
            onToggleFavoriteTag={onToggleFavoriteTag}
          />
        ))}
      </div>
      {hasMore && (
        <>
          <div ref={sentinelRef} aria-hidden />
          <button
            className={styles.moreBtn}
            onClick={() => load(articles.length, articles)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : `Load more  ·  ${total - articles.length} remaining`}
          </button>
        </>
      )}

      {reading && (
        <ArticleDetailModal
          url={reading.link}
          title={reading.title}
          source={reading.source}
          imageUrl={reading.imageUrl}
          categories={reading.categories}
          readTime={reading.readTime != null ? `${reading.readTime} min read` : null}
          pubDate={reading.pubDate}
          prefs={commentPrefs}
          onCountChange={setCommentCount}
          onClose={() => setReading(null)}
          onViewProfile={onViewProfile}
          actions={
            <>
              {/* The card's own control, unchanged: the reading list on the
                  label, a shelf behind the caret. Deciding after reading is
                  the common case, so it should not be a different button. */}
              <SaveButton
                label="Save"
                icon={<BookmarkIcon />}
                menuLabel="Save to…"
                defaultId={READING_LIST_DEST}
                destinations={destinationsFor(readingFolders)}
                onSelect={id => {
                  handleSave(reading, id === READING_LIST_DEST
                    ? undefined
                    : { folderId: id || null, label: shelfLabel(id, readingFolders) });
                  setReading(null);
                }}
                onCreateDestination={onCreateFolder && (async name => {
                  const folderId = await onCreateFolder(name);
                  handleSave(reading, { folderId, label: name });
                  setReading(null);
                })}
              />
              <button onClick={() => { handleDismiss(reading.id); setReading(null); }}>
                Dismiss
              </button>
            </>
          }
        />
      )}
    </div>
  );
}

function ArticleCard({ article, variant, isNew, ghost, cardRef, onSave, onDismiss, onUndoDismiss, readingFolders = [], onCreateFolder, commentCount, onOpenReader, onViewProfile, favHits, favoriteTags = [], onToggleFavoriteTag }: {
  article: FeedArticle; variant?: MagVariant; isNew?: boolean;
  /** Set when this card is a placeholder for something already dealt with. */
  ghost?: Ghost;
  cardRef?: (el: HTMLDivElement | null, id: string) => void;
  onSave: (dest?: { folderId: string | null; label: string }) => void;
  onDismiss: () => void; onUndoDismiss: () => void;
  readingFolders?: ReadingFolder[];
  onCreateFolder?: (name: string) => Promise<string>;
  commentCount: number;
  onOpenReader: () => void;
  onViewProfile?: (username: string) => void;
  /** Favorites this article matched, if any - the parent did the matching. */
  favHits?: string[];
  favoriteTags?: string[];
  onToggleFavoriteTag?: (tag: string) => void;
}) {
  // A post written on this instance is credited to its author, not to the host
  // every author here shares - and it needs no favicon, since that would be this
  // site's own icon on every such card.
  const blogAuthor = blogAuthorOfUrl(article.link);
  const domain = domainOf(article.link);
  const feedDomain = domainOf(article.feedUrl);
  // Always derive from the domain (same as SiteTile) - stored bookmark favicon
  // URLs can go stale when the API path changes.
  const favicon = blogAuthor ? '' : domain ? faviconUrl(domain) : feedDomain ? faviconUrl(feedDomain) : '';

  const destinations = destinationsFor(readingFolders);

  const showImage = variant === 'feature' || variant === 'standard';
  // Magazine text variants always run their snippet; elsewhere keep the
  // original heuristic of only padding out short titles
  const showSnippet = !!article.snippet && (
    variant === 'feature' || variant === 'brief' || variant === 'text' || article.title.length < 60
  );
  const hasHero = showImage && !!article.imageUrl;
  const wrapClass = [
    styles.cardWrap,
    ghost ? styles.ghost : '',
    isNew && !ghost ? styles.unread : '',
    variant === 'feature' ? styles.featureWrap : '',
    variant === 'brief' ? styles.briefWrap : '',
    variant === 'text' ? styles.textWrap : '',
    // No cover art → reserve top space so the floating controls push text down
    !hasHero ? styles.noHero : '',
    favHits && favHits.length > 0 ? styles.favCard : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={wrapClass} ref={cardRef ? el => cardRef(el, article.id) : undefined}>
      {/* Covers the card so nothing under it is clickable, while leaving it
          legible - you can still see what you just got rid of. */}
      {ghost && (
        <div className={styles.ghostOverlay}>
          <div className={styles.ghostPill}>
            {/* Naming the destination is the confirmation - "Saved" on its own
                leaves you wondering which of the places you just chose from it
                actually went to. */}
            <span className={styles.ghostLabel}>
              {ghost.kind === 'saved' ? `Saved to ${ghost.dest ?? 'reading list'}` : 'Dismissed'}
            </span>
            {ghost.kind === 'dismissed' && (
              <button className={styles.undoBtn} onClick={onUndoDismiss}>Undo</button>
            )}
          </div>
        </div>
      )}
      <div className={styles.card}>
        {showImage && article.imageUrl && (
          <img
            src={article.imageUrl}
            alt=""
            className={styles.hero}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        {article.categories.length > 0 && (
          <div className={styles.cats}>
            {article.categories.slice(0, 3).map(c => {
              const covering = onToggleFavoriteTag ? coveringFavorites(favoriteTags, c) : [];
              return onToggleFavoriteTag ? (
                <TagChip
                  key={c}
                  tag={c}
                  starred={covering.length > 0}
                  coveredBy={covering[0]}
                  onToggle={onToggleFavoriteTag}
                  className={styles.cat}
                />
              ) : (
                <span key={c} className={styles.cat}>{c}</span>
              );
            })}
          </div>
        )}
        <a href={article.link} target="_blank" rel="noopener noreferrer" className={styles.title}>
          {article.title}
        </a>
        {showSnippet && (
          <p className={styles.snippet}>{article.snippet}</p>
        )}
        {article.readTime != null && (
          <span className={styles.readTime}>
            {article.readTime === 1 ? '1 minute read' : `${article.readTime} minute read`}
          </span>
        )}
        <div className={styles.cardBottom}>
          <div className={styles.meta}>
            {favicon && <img src={favicon} alt="" className={styles.favicon} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
            {/* The byline is a link either way: an @handle opens that person's
                profile in this app, a hostname opens that site. */}
            {blogAuthor ? (
              <a
                className={styles.handle}
                href={profilePathFor(blogAuthor)}
                title={`View @${blogAuthor}’s profile`}
                onClick={onViewProfile
                  ? e => { e.preventDefault(); onViewProfile(blogAuthor); }
                  : undefined}
              >
                @{blogAuthor}
              </a>
            ) : domain ? (
              <a
                className={styles.domain}
                href={siteHomeOf(article.link) || `https://${domain}`}
                target="_blank"
                rel="noopener noreferrer"
                title={`Visit ${domain}`}
              >
                {domain}
              </a>
            ) : null}
          </div>
          <div className={styles.cardRight}>
            {isNew && <span className={styles.newDot} role="img" aria-label="Unread" title="Unread" />}
            <span className={styles.date}>{relativeDate(article.pubDate)}</span>
          </div>
        </div>

        {/* The card's action strip. Saving used to be an 11px bookmark icon in
            the corner cluster, which was both hard to explain and hard to hit;
            it is a labelled pill down here now, matched to the comment bar
            beside it and to the identical control on a reading list card. */}
        <div className={styles.commentRow}>
          <CommentBar count={commentCount} onClick={onOpenReader} />
          <SaveButton
            className={styles.rowSave}
            label="Save"
            icon={<BookmarkIcon />}
            menuLabel="Save to…"
            defaultId={READING_LIST_DEST}
            destinations={destinations}
            onSelect={id => onSave(
              id === READING_LIST_DEST
                ? undefined
                : { folderId: id || null, label: destinations.find(d => d.id === id)?.label ?? 'Library' }
            )}
            onCreateDestination={onCreateFolder && (async name => {
              const folderId = await onCreateFolder(name);
              onSave({ folderId, label: name });
            })}
          />
        </div>
        {/* Floating window-style controls - top-right, over the cover art.
            Only Dismiss lives up here now; see the action strip above.
            Dropped entirely on a ghost rather than hidden with an attribute:
            .cardActions sets `display: flex`, which would beat [hidden]'s UA
            `display: none` and leave them looking clickable. They're absolute,
            so removing them costs the card no height. */}
        {!ghost && <div className={styles.cardActions}>
          <button className={`${styles.actionBtn} ${styles.dismissBtn}`} onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M1 1l10 10M11 1L1 11"/>
            </svg>
          </button>
        </div>}
      </div>
    </div>
  );
}
