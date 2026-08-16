import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from '../services/api';
import { FeedArticle, CommentPrefs, ReadingFolder, FeedFolder } from '../types';
import { faviconUrl } from '../utils/color';
import { blogAuthorOfUrl } from '../utils/blogUrl';
import { profilePathFor } from '../utils/profileUrl';
import { sitePathFor } from '../utils/siteUrl';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { articleEmbed } from '../utils/noteEmbed';
import { startRepost } from '../utils/composerSeed';
import { CommentBar } from './CommentsPanel';
import ArticleDetailModal from './ArticleDetailModal';
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from './LayoutSwitch';
import FeedFilterBar, { FilterGroup } from './FeedFilterBar';
import TagChip from './TagChip';
import FavoritesControl from './FavoritesControl';
import SaveButton, { SaveDestination } from './SaveButton';
import { prepareFavorites, favoritesFor, coveringFavorites } from '../utils/favoriteTags';
import styles from './FeedPanel.module.css';

export type RssLayout = 'list' | 'cards' | 'magazine';

const LAYOUT_OPTIONS = [
  { value: 'list' as const,     title: 'List',     icon: <ListIcon /> },
  { value: 'cards' as const,    title: 'Cards',    icon: <CardsIcon /> },
  { value: 'magazine' as const, title: 'Magazine', icon: <MagazineIcon /> },
];

// Past this many options a filter list grows a search box.
const SEARCHABLE_AT = 8;

// How long to sit on newly-read ids before sending them up, so a fast scroll
// through a screenful costs one request instead of a dozen
const READ_FLUSH_MS = 600;

// How long the "Saved to …" receipt stays up before the card goes back to
// being a card. Long enough to read the shelf name, short enough that it isn't
// still sitting there when you reach for the comments.
const SAVED_PILL_MS = 2400;

// How often an open feed asks whether anything has arrived. This only counts —
// it never inserts — so it can afford to be quiet. Paused while the tab is
// hidden, and run once immediately on coming back, which is the case that
// actually matters: the feed you left open yesterday.
const NEW_CHECK_MS = 3 * 60 * 1000;

// How long a page has to have been sitting there before it offers to go and
// refetch the feeds. A refresh control on a page drawn thirty seconds ago is
// answering a question nobody has; on one left open over lunch it is the only
// question there is. So it isn't in the toolbar at all - it arrives when it
// starts being the thing you want.
const PAGE_STALE_MS = 15 * 60 * 1000;

// A card that's been dealt with - dismissed, or saved to the reading list - but
// is still drawn in its slot, greyed out, until the feed reloads. Removing it
// outright pulls every card below it up, and the next click lands on whatever
// slid into place. Only a dismissal is undoable: undoing a save would have to
// decide what to do with the reading-list copy, and "put the card back" isn't
// obviously that. Both are already committed server-side.
//
// The two states differ in how final they are. A dismissal is a closed door:
// the card is blocked, and the only thing left to do with it is take it back.
// A save is not - the article is filed, but you may still want to read it,
// comment on it, or file it somewhere else, so that card stays live and only
// looks spent. See ArticleCard.
type GhostKind = 'dismissed' | 'saved';

interface Ghost {
  kind: GhostKind;
  /** Where a save went - the placeholder names it, since the Save button can
      now put an article somewhere other than the reading list. */
  dest?: string;
  /** When this ghost was (re)set. Only there to restart the "Saved to …"
      receipt when the same card is saved twice - without it, filing an
      article to the shelf it is already on would flash nothing. */
  at: number;
}

interface Props {
  /** The reader's own categories, offered as one of the filters. */
  feedFolders: FeedFolder[];
  /** How many feeds are followed. Zero gets the "add some feeds" empty state
      rather than the "nothing published yet" one - they are different problems
      and only one of them has a button that helps. */
  subscriptionCount: number;
  /** Opens the feed manager. The feed is the only place that knows you're
      looking at feeds, so it's where managing them belongs. */
  onManageFeeds: () => void;
  /** `dest` is set only when the reader picked a Library shelf over the
      reading list; a null folderId inside it means Unsorted.
      `card` is how the save reports back to the tile it came from. Call
      `markSaved` as soon as the save is committed to - not when it lands - and
      `restore` if it turns out not to have. See handleSave. */
  onSaveArticle: (
    a: { id: string; url: string; title: string; source: string; categories: string[]; readTime: number | null; imageUrl: string | null },
    card: { markSaved: () => void; restore: () => void },
    dest?: { folderId: string | null },
  ) => void;
  /** Library shelves, offered behind the Save button's caret. */
  readingFolders?: ReadingFolder[];
  /** Make a new shelf and resolve to its id, from that same menu. */
  onCreateFolder?: (name: string) => Promise<string>;
  refreshKey?: number;
  pageSize?: number;
  layout?: RssLayout;
  onLayoutChange?: (layout: RssLayout) => void;
  markReadOnScroll?: boolean;
  onUnreadCountsChange?: (updates: { id: string; unreadCount: number }[]) => void;
  commentPrefs: CommentPrefs;
  /** Marking everything read clears the rail's site badges too. */
  onAllMarkedRead?: () => void;
  onViewProfile?: (username: string) => void;
  /** Start an Explore thread about an article. Absent when no model is connected. */
  onExplore?: (url: string, title: string) => void;
  /** Open a publisher's page (/s/<domain>) from a card's byline. Absent means
   *  the byline stays a plain link out to the site, which is what it was. */
  onOpenSite?: (domain: string) => void;
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
    { id: '', label: 'Unsorted', group: 'Saved articles' },
    ...folders.map(f => ({ id: f.id, label: f.name, group: 'Saved articles' })),
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

const RefreshIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <polyline points="21 3 21 9 15 9" />
  </svg>
);

const ArrowUpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

const SlidersIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
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

export default function FeedPanel({ feedFolders, subscriptionCount, onManageFeeds, onSaveArticle, readingFolders = [], onCreateFolder, refreshKey, pageSize = 10, layout = 'magazine', onLayoutChange, markReadOnScroll = true, onUnreadCountsChange, commentPrefs, onAllMarkedRead, onViewProfile, onExplore, onOpenSite, favoriteTags = [], onToggleFavoriteTag, onSetFavoriteTags }: Props) {
  const [readIds, setReadIds]           = useState<Set<string>>(new Set());
  const [articles, setArticles]         = useState<FeedArticle[]>([]);
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(true);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [error, setError]               = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  // The category filter is the one that goes to the server. Site and topic sift
  // what has already been fetched, the way they always have; a category has to
  // narrow the query itself, because `total` and `unread` are counted against
  // it and paging measures against `total`.
  const [activeFeedFolder, setActiveFeedFolder] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [ghosts, setGhosts] = useState<Map<string, Ghost>>(new Map());
  // Folder-wide, straight from the server, so the chip agrees with the site
  // tiles in the rail rather than counting only what happens to be loaded.
  const [unreadTotal, setUnreadTotal] = useState(0);

  // ── Arrivals ──
  // The feed does not restock itself while you're reading it. Anything that
  // lands after the page was drawn would push whatever you were looking at down
  // the screen and change where your next click goes, so new articles are
  // counted and announced, and only inserted when you say so.
  //
  // `loadedAt` is the server's own clock, taken before it read the page, and is
  // what the count is measured against - the client's clock is not the same
  // clock and may be minutes out.
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Whether this page has been up long enough to be worth refetching. Measured
  // from the last load rather than from mount, so refreshing genuinely resets
  // it instead of leaving the button hanging around after it has been used.
  const [stale, setStale] = useState(false);

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
      const scope = activeFeedFolder ? `&folder=${encodeURIComponent(activeFeedFolder)}` : '';
      const r = await apiFetch(`/api/v1/feeds/articles?offset=${offset}&limit=${pageSize}${scope}`);
      if (!r.ok) { setError('Could not load feed'); return; }
      const data: { articles: FeedArticle[]; total: number; unread?: number; loadedAt?: string } = await r.json();
      const merged = offset === 0 ? data.articles : [...existing, ...data.articles];
      setArticles(merged);
      setTotal(data.total);
      if (typeof data.unread === 'number') setUnreadTotal(data.unread);
      // Only a fresh first page is a new watermark. A "load more" is this same
      // view reaching further down it, and taking its timestamp would forgive
      // everything that had arrived in the meantime - the count would go back to
      // zero for no reason the reader could see.
      if (offset === 0 && data.loadedAt) {
        setLoadedAt(data.loadedAt);
        setNewCount(0);
      }
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
  }, [activeFeedFolder, pageSize]);

  useEffect(() => {
    setArticles([]);
    setTotal(0);
    setReadIds(new Set());
    // The client-side filters are cleared with the list they were filtering: a
    // site or topic chosen in Tech usually isn't even present in Local.
    setActiveCategory(null);
    setActiveSource(null);
    // A reload is exactly what clears the placeholders - the dismissed items
    // simply won't come back in the response.
    setGhosts(new Map());
    setUnreadOnly(false);
    setUnreadPinned(new Set());
    unreadJudged.current = new Set();
    // Cleared here rather than in its own effect so it happens before the read
    // sweep seeds it - the other order wiped the seeding on every reload.
    seenRef.current = new Set();
    setNewCount(0);
    load(0, []);
  }, [activeFeedFolder, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Arrivals: counted here, inserted only when asked for ────────────────

  /**
   * Redraws the feed from the top, keeping the filters you set.
   *
   * Deliberately not the reset effect above: that one also clears the site and
   * topic filters, which is right when you switch category (a site in Tech
   * usually isn't in Local) and wrong here. Asking for new articles is not
   * asking to be put back at the start of your own view.
   *
   * The placeholders do go - a reload is exactly what they were waiting for -
   * and the scroll goes to the top, because the whole point of the press was to
   * see what has arrived above what you were reading.
   */
  const reloadFromTop = useCallback(() => {
    setGhosts(new Map());
    seenRef.current = new Set();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    load(0, []);
  }, [load]);

  // Counts what has landed since `loadedAt`. Never touches the list.
  const checkForNew = useCallback(async () => {
    if (!loadedAt) return;
    const scope = activeFeedFolder ? `&folder=${encodeURIComponent(activeFeedFolder)}` : '';
    try {
      const r = await apiFetch(`/api/v1/feeds/articles/new-count?since=${encodeURIComponent(loadedAt)}${scope}`);
      if (!r.ok) return;
      const data: { count: number } = await r.json();
      setNewCount(data.count);
    } catch {
      // A count that failed to arrive is not worth telling anyone about; the
      // next tick will have another go.
    }
  }, [loadedAt, activeFeedFolder]);

  // ── The age of what's on screen ──
  //
  // Read off a timestamp, not counted down by a timer. A phone that goes to
  // sleep suspends the page: timers stop, and depending on how long it was out
  // and how much memory the browser wanted back, a pending setTimeout may fire
  // late, fire immediately on resume, or never fire at all because the page was
  // discarded and restored from the back/forward cache with its JS heap intact
  // and its timers gone. That was the report - picking the phone up after a
  // couple of hours and finding a feed with no refresh button on it, which is
  // exactly the page that most needs one.
  //
  // A stored millisecond survives all of that: whatever happened while nobody
  // was looking, the answer to "how old is this page" is the same subtraction.
  // The timer is kept for the ordinary case - a page someone is looking at,
  // which goes stale on the stroke of fifteen minutes rather than at the next
  // three-minute tick. It is no longer the only thing that can raise the flag.
  const drawnAtRef = useRef(0);
  useEffect(() => {
    if (!loadedAt) return;
    // The client's own clock. `loadedAt` is the server's and is not comparable
    // to Date.now(); this only ever measures an elapsed time against itself.
    drawnAtRef.current = Date.now();
    setStale(false);
    const timer = setTimeout(() => setStale(true), PAGE_STALE_MS);
    return () => clearTimeout(timer);
  }, [loadedAt]);

  // Kept off the effect's dependencies so a changing callback identity can't
  // restart the interval on every render.
  const checkRef = useRef(checkForNew);
  useEffect(() => { checkRef.current = checkForNew; }, [checkForNew]);

  useEffect(() => {
    if (!loadedAt) return;
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      // Only ever raised here, never lowered: a fresh load is what clears it,
      // and that goes through the effect above.
      if (Date.now() - drawnAtRef.current >= PAGE_STALE_MS) setStale(true);
      checkRef.current();
    };
    const timer = setInterval(poll, NEW_CHECK_MS);
    // Every way a page can come back after being away. Coming back to a tab
    // that has been sitting open is the case this whole mechanism exists for -
    // "I have to refresh to get updates when I've been gone for a bit" - so it
    // asks straight away rather than waiting out the rest of an interval that
    // was running while nobody was looking, or never ran at all.
    //
    // All three are needed and none of them is redundant: switching tabs fires
    // only `visibilitychange`, a bfcache restore fires only `pageshow`, and
    // returning to a phone that merely locked the screen can fire only `focus`.
    // They also overlap - one return can fire two of them - so a wake is only
    // acted on once. Coming back is one event however many the browser sends.
    let lastWake = 0;
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastWake < 2000) return;
      lastWake = Date.now();
      poll();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('focus', wake);
    };
  }, [loadedAt]);

  /**
   * Go and look now, then show what came back.
   *
   * The count above only reports what the background refresher has already
   * collected, so on its own it can't answer "is there anything new right now" -
   * it would report zero for a feed nobody had polled in twenty-nine minutes.
   * This is the button that goes and asks the publishers, then redraws.
   */
  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await apiFetch('/api/v1/feeds/refresh', {
        method: 'POST',
        body: JSON.stringify({ folder: activeFeedFolder ?? 'all' }),
      });
    } catch {
      // Even a failed fetch is worth reloading after: the background refresher
      // may well have collected something since this page was drawn.
    } finally {
      setRefreshing(false);
      reloadFromTop();
    }
  }

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
      const r = await apiFetch(`/api/v1/feeds/articles/read`, {
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
  }, [onUnreadCountsChange]);

  // Keeps unmount/visibility handlers off the flushRead identity
  const flushRef = useRef(flushRead);
  useEffect(() => { flushRef.current = flushRead; }, [flushRead]);

  /**
   * The one place an article becomes read, whatever decided it: scrolled past,
   * opened in the reader, or clicked through to the site.
   *
   * Scrolling used to be the only route, which is why articles you had plainly
   * looked at stayed unread - open the last card on screen, read the whole
   * thing, come back, and nothing had scrolled past the top so nothing counted.
   * Viewing is the stronger signal of the two; it just wasn't wired up.
   *
   * The outline clears immediately and the server hears about it on the next
   * flush. Dismissed cards are skipped: the dismissal has already spent their
   * place in the unread total, and "read" means nothing for something you threw
   * away.
   */
  const markRead = useCallback((ids: string[]) => {
    const fresh = ids.filter(id => !readIdsRef.current.has(id) && !ghostsRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) {
      readIdsRef.current.add(id);
      pendingRef.current.add(id);
    }
    setReadIds(new Set(readIdsRef.current));
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => { flushRef.current(); }, READ_FLUSH_MS);
  }, []);

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
      // A dismissed card is still mounted as a placeholder; it isn't something
      // you're scrolling past, so it doesn't get "seen" either (markRead drops
      // it in any case).
      if (ghostsRef.current.has(id)) continue;
      const rect = el.getBoundingClientRect();
      // A detached or display:none card measures 0x0 at the origin; treat it as
      // nothing rather than as "scrolled past".
      if (rect.height === 0 && rect.width === 0) continue;
      if (rect.bottom > 0) { seenRef.current.add(id); continue; }
      if (seenRef.current.has(id) && !readIdsRef.current.has(id)) justRead.push(id);
    }
    markRead(justRead);
  }, [markRead]);

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
  }, [markReadOnScroll, sweepRead]);

  // Newly appended pages need seeding too, or the first card of a page fetched
  // while you were already scrolled down would be above the fold on its very
  // first sweep and get skipped for never having been "seen".
  useEffect(() => {
    if (!markReadOnScroll) return;
    sweepRead();
  }, [articles, markReadOnScroll, sweepRead]);

  // Don't lose queued ids to a tab close or a category switch
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushRef.current(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flushRef.current();
    };
  }, [activeFeedFolder]);


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

  const { counts: commentCounts, setCount: setCommentCount } = useCommentCounts(
    useMemo(() => articles.map(a => a.link), [articles])
  );

  // The article open in the reader modal
  const [reading, setReading] = useState<FeedArticle | null>(null);

  // ── Mark everything read ──────────────────────────────────────────────
  // Covers the pages that haven't been scrolled to yet, which is the whole
  // point - the server walks the subscriptions rather than the loaded list.
  // Scoped to the active category, so clearing Tech doesn't quietly wipe the
  // news you hadn't got to.
  const [markingAll, setMarkingAll] = useState(false);
  const unreadShowing = markReadOnScroll && displayed.some(a => !readIds.has(a.id) && !ghosts.has(a.id));

  async function handleMarkAllRead() {
    if (markingAll) return;
    setMarkingAll(true);
    // Anything already queued would otherwise land after the bulk write
    pendingRef.current.clear();
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    try {
      const r = await apiFetch('/api/v1/feeds/articles/read-all', {
        method: 'POST',
        body: JSON.stringify({ folder: activeFeedFolder ?? 'all' }),
      });
      if (r.ok) {
        const data: { itemIds: string[]; bookmarks?: { id: string; unreadCount: number }[] } = await r.json();
        for (const id of data.itemIds ?? []) readIdsRef.current.add(id);
        // Whatever is on screen is read now, even if the feed shifted mid-call
        for (const a of articles) readIdsRef.current.add(a.id);
        setReadIds(new Set(readIdsRef.current));
        setUnreadTotal(0);
        if (data.bookmarks?.length) onUnreadCountsChange?.(data.bookmarks);
        onAllMarkedRead?.();
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
    // Whether this card was already spent before this save. If it was, a
    // failure has nothing to put back: the earlier state is still the true one,
    // and restoring would pull an article that did save back into the feed.
    const wasGhosted = ghosts.has(a.id);
    onSaveArticle(
      { id: a.id, url: a.link, title: a.title, source: a.source, categories: a.categories, readTime: a.readTime, imageUrl: a.imageUrl },
      {
        // Once it's saved it leaves the feed (dismissed server-side, so it
        // stays gone across refreshes).
        markSaved: () => handleDismiss(a.id, 'saved', dest?.label ?? 'reading list'),
        restore: () => { if (!wasGhosted) handleUndoDismiss(a.id); },
      },
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
    // A saved card stays live, so it can arrive here more than once - saved
    // again to a different shelf, or dismissed afterwards. Only the first pass
    // actually takes the article out of the feed; the rest just relabel the
    // placeholder, and must not spend the unread count or the DELETE twice.
    const alreadyGone = ghosts.has(articleId);
    setGhosts(prev => new Map(prev).set(articleId, { kind, dest, at: Date.now() }));
    if (alreadyGone) return;
    // Only an unread article was being counted, so only that one moves the chip.
    if (!readIdsRef.current.has(articleId)) setUnreadTotal(n => Math.max(0, n - 1));
    apiFetch(`/api/v1/feeds/articles/${articleId}`, { method: 'DELETE' })
      .then(applyBadges).catch(() => {});
  }

  function handleUndoDismiss(articleId: string) {
    setGhosts(prev => { const m = new Map(prev); m.delete(articleId); return m; });
    if (!readIdsRef.current.has(articleId)) setUnreadTotal(n => n + 1);
    apiFetch(`/api/v1/feeds/articles/${articleId}/restore`, { method: 'POST' })
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

  // Category, site and topic are one control. They used to be two chips sitting
  // beside a row of every topic in the feed, which made the tags the loudest
  // thing on the page and left the controls scattered across it.
  //
  // Built here, above the early returns, because the control bar below is drawn
  // in every state - including the ones with no articles, where these groups
  // come out empty and FeedFilterBar folds them away on its own.
  const filterGroups: FilterGroup[] = [
    {
      id: 'category',
      label: 'Category',
      allLabel: 'All feeds',
      value: activeFeedFolder,
      onChange: setActiveFeedFolder,
      searchable: feedFolders.length > SEARCHABLE_AT,
      options: feedFolders.map(f => ({ value: f.id, label: f.name, color: f.color })),
    },
    {
      id: 'site',
      label: 'Site',
      allLabel: 'All sites',
      value: activeSource,
      onChange: setActiveSource,
      searchable: allSources.length > SEARCHABLE_AT,
      options: allSources.map(s => ({ value: s, label: s })),
    },
    {
      id: 'topic',
      label: 'Topic',
      allLabel: 'All topics',
      value: activeCategory,
      onChange: setActiveCategory,
      searchable: allCategories.length > SEARCHABLE_AT,
      options: allCategories.map(c => ({ value: c, label: c })),
    },
  ];

  // ── Two bands, not one row ──
  // Things that *do* something on top, right-aligned; things that change what
  // you're looking at underneath, gathered into a box of their own.
  //
  // They were all one row, which put "Mark all read" - which writes to every
  // article you have - immediately beside a filter chip that only changes the
  // view, dressed identically and reading as another chip. That is the wrong
  // pairing to make, and it is why the double-tick had to be guessed at: on a
  // narrow screen its label dropped and an unlabelled glyph was all that was
  // left of an irreversible action.
  //
  // So: two bands with different jobs and different looks, and the actions keep
  // their words. The box is what makes the filters read as a set rather than as
  // four unrelated buttons that happen to be adjacent.
  //
  // Drawn in every state, including the ones that render nothing else: "Manage
  // feeds" has to be reachable precisely when the feed is empty, which is when
  // it is hardest to find.
  const controlBar = (
    <div className={styles.controls}>
      <div className={styles.actionRow}>
        {markReadOnScroll && articles.length > 0 && (
          <button
            className={styles.actionBtnMain}
            onClick={handleMarkAllRead}
            disabled={markingAll || !unreadShowing}
            title={activeFeedFolder
              ? 'Mark every article in this category as read'
              : 'Mark every article in your feed as read'}
          >
            <CheckAllIcon />
            {markingAll ? 'Marking…' : 'Mark all read'}
          </button>
        )}

        {/* The label goes on a narrow screen and the icon carries it - see
            .actionLabel. This is the rarest of the three (you set your feeds
            up once), so it is the one that can afford to be a glyph when the
            row is short of room. The other two keep their words whatever
            happens: both of them act on things, and one of them cannot be
            undone. */}
        <button
          className={styles.manageBtn}
          onClick={onManageFeeds}
          title="Add, rename or remove feeds"
          aria-label="Manage feeds"
        >
          <SlidersIcon />
          <span className={styles.actionLabel}>Manage feeds</span>
        </button>

        {onLayoutChange && articles.length > 0 && (
          <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Feed layout" />
        )}
      </div>

      <FeedFilterBar
        className={styles.filterBox}
        groups={filterGroups}
        // Read state is only tracked when read-on-scroll is on, so without it
        // there is no such thing as unread here to filter to.
        unread={markReadOnScroll
          ? { count: unreadTotal, active: unreadOnly, onToggle: toggleUnreadOnly }
          : undefined}
        // Shown whenever there's a list to manage, not only when something
        // matches - otherwise a favorite that has stopped matching becomes
        // unreachable from the page it's affecting. The control disables its
        // own filter at zero.
        favorites={onToggleFavoriteTag && (favoriteTags.length > 0 || favHits.size > 0) ? (
          <FavoritesControl
            favorites={favoriteTags}
            onChange={onSetFavoriteTags ?? (() => {})}
            count={favHits.size}
            filterOn={favoritesOnly}
            onToggleFilter={() => setFavoritesOnly(v => !v)}
            chipClassName={`${styles.chip} ${styles.favChip}`}
            chipActiveClassName={styles.favChipActive}
          />
        ) : undefined}
      />
    </div>
  );

  // What has landed since this page was drawn, and the only thing that puts it
  // on screen. Nothing arrives unasked - see the arrivals block above.
  const newBanner = newCount > 0 ? (
    <button className={styles.newBanner} onClick={reloadFromTop}>
      <ArrowUpIcon />
      {newCount === 1 ? '1 new article' : `${newCount} new articles`}
    </button>
  ) : null;

  // ── The refresh that turns up when it's wanted ──
  // Not a toolbar button. A page drawn a minute ago has nothing to refresh, and
  // a permanent control implies otherwise - it invites pressing, and every press
  // is a fan-out of outbound requests to answer a question with no answer in it.
  // After a quarter of an hour the question is real, so the button appears.
  //
  // Held back while the pill is up, because at that point they are two buttons
  // competing to be pressed and the pill is the better one: it already knows
  // there is something to show, whereas this would go and look again first. The
  // two are complementary rather than alternatives - the pill can only report
  // what the background refresher has already collected, and this is what goes
  // and asks the publishers when it has collected nothing.
  const floatingRefresh = stale && newCount === 0 ? (
    <button
      className={styles.floatingRefresh}
      onClick={handleRefresh}
      disabled={refreshing}
      title="Check your feeds for new articles now"
    >
      <span className={refreshing ? styles.spinning : undefined}><RefreshIcon /></span>
      {refreshing ? 'Refreshing…' : 'Refresh feed'}
    </button>
  ) : null;

  if (loading) return (
    <div className={styles.wrap}>
      {controlBar}
      <div className={styles.status}><span className={styles.spinner} /> Fetching feeds…</div>
    </div>
  );

  if (error) return (
    <div className={styles.wrap}>
      {controlBar}
      <div className={styles.statusError}>{error}</div>
    </div>
  );

  // Following nothing and following feeds that haven't published are different
  // problems: only the first one has an answer the user can act on.
  if (subscriptionCount === 0) return (
    <div className={styles.wrap}>
      {controlBar}
      <div className={styles.emptyPitch}>
        <div className={styles.emptyTitle}>Your feed is empty</div>
        <div className={styles.emptyText}>
          Follow a few sites and their new articles land here — no need to go
          looking for them.
        </div>
        <button className={styles.emptyBtn} onClick={onManageFeeds}>Add feeds</button>
      </div>
    </div>
  );

  if (articles.length === 0) return (
    <div className={styles.wrap}>
      {controlBar}
      {/* Worth showing here above all: "nothing yet" plus a count of what has
          since arrived is the one empty state with an answer in it. */}
      {newBanner}
      {floatingRefresh}
      {activeFeedFolder ? (
        <div className={styles.status} style={{ opacity: 0.45 }}>
          Nothing in this category yet.{' '}
          <button className={styles.inlineBtn} onClick={() => setActiveFeedFolder(null)}>Show all feeds</button>
        </div>
      ) : (
        <div className={styles.status} style={{ opacity: 0.45 }}>No articles yet - feeds refresh every 30 minutes.</div>
      )}
    </div>
  );

  const gridClass = layout === 'list' ? styles.gridList
    : layout === 'magazine' ? styles.gridMagazine
    : styles.grid;

  const variants = layout === 'magazine' ? magazineVariants(displayed) : null;

  return (
    <div className={styles.wrap}>
      {controlBar}
      {newBanner}
      {floatingRefresh}

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
            onOpenReader={() => { markRead([a.id]); setReading(a); }}
            onOpenLink={() => markRead([a.id])}
            onViewProfile={onViewProfile}
            onOpenSite={onOpenSite}
            onExplore={onExplore}
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
          onExplore={onExplore}
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

function ArticleCard({ article, variant, isNew, ghost, cardRef, onSave, onDismiss, onUndoDismiss, readingFolders = [], onCreateFolder, commentCount, onOpenReader, onOpenLink, onViewProfile, onOpenSite, onExplore, favHits, favoriteTags = [], onToggleFavoriteTag }: {
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
  /** Followed the article out to its own site - counts as having viewed it. */
  onOpenLink?: () => void;
  onViewProfile?: (username: string) => void;
  onOpenSite?: (domain: string) => void;
  /** Opens an Explore thread. Undefined when the account has no model. */
  onExplore?: (url: string, title: string) => void;
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

  // A saved card is spent, not gone: it greys out so you can see you've dealt
  // with it, but everything on it keeps working. The receipt over the top is
  // the only part that's temporary.
  const saved = ghost?.kind === 'saved';
  const [receipt, setReceipt] = useState(true);
  useEffect(() => {
    if (!saved) { setReceipt(true); return; }   // a dismissal keeps its pill and its Undo
    setReceipt(true);
    const t = setTimeout(() => setReceipt(false), SAVED_PILL_MS);
    return () => clearTimeout(t);
  }, [saved, ghost?.at]);

  // Following the article out is a view, so the card reports it. Middle click
  // opens a background tab without firing onClick, which is exactly the habit a
  // feed encourages - onAuxClick catches that half.
  const openLink = onOpenLink
    ? {
      onClick: () => onOpenLink(),
      onAuxClick: (e: React.MouseEvent) => { if (e.button === 1) onOpenLink(); },
    }
    : {};

  const showImage = variant === 'feature' || variant === 'standard';
  // Magazine text variants always run their snippet; elsewhere keep the
  // original heuristic of only padding out short titles
  const showSnippet = !!article.snippet && (
    variant === 'feature' || variant === 'brief' || variant === 'text' || article.title.length < 60
  );
  const hasHero = showImage && !!article.imageUrl;
  const wrapClass = [
    styles.cardWrap,
    ghost ? (saved ? styles.spent : styles.ghost) : '',
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
      {/* Dismissed: covers the card so nothing under it is clickable, while
          leaving it legible - you can still see what you just got rid of, and
          the Undo needs somewhere to live.
          Saved: the same pill, but it takes no clicks and it leaves after a
          couple of seconds. It is a receipt for something that already
          happened, and it was standing between people and the card. */}
      {ghost && (
        <div className={`${styles.ghostOverlay} ${saved ? styles.receiptOverlay : ''}`}>
          <div className={`${styles.ghostPill} ${saved && !receipt ? styles.pillOut : ''}`}>
            {/* Naming the destination is the confirmation - "Saved" on its own
                leaves you wondering which of the places you just chose from it
                actually went to. */}
            <span className={styles.ghostLabel}>
              {saved ? `Saved to ${ghost.dest ?? 'reading list'}` : 'Dismissed'}
            </span>
            {!saved && (
              <button className={styles.undoBtn} onClick={onUndoDismiss}>Undo</button>
            )}
          </div>
        </div>
      )}
      <div className={styles.card}>
        {/* The art is the biggest target on a magazine card and it is the thing
            people aim at, so it goes where the headline goes. Out of the tab
            order and hidden from assistive tech on purpose: it leads to exactly
            the same place as the title two lines below, and a second link with
            no text of its own is noise to anyone not using a mouse.
            A broken image hides the link, not just the <img> - hiding only the
            picture would leave the link's negative margins pulling the card's
            text up into its own padding. */}
        {showImage && article.imageUrl && (
          <a
            href={article.link}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.heroLink}
            tabIndex={-1}
            aria-hidden="true"
            {...openLink}
          >
            <img
              src={article.imageUrl}
              alt=""
              className={styles.hero}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={e => { const img = e.currentTarget; (img.parentElement ?? img).style.display = 'none'; }}
            />
          </a>
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
        <a href={article.link} target="_blank" rel="noopener noreferrer" className={styles.title} {...openLink}>
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
            {/* The byline is a link either way, and both now lead *into* the
                app: an @handle opens that person's profile, a hostname opens
                that publisher's page. It used to send you straight out to the
                site's front page, which was the one destination the card
                already offered - the title is the article, and the article is
                on the site. What the byline can answer instead is "what else
                has this lot published, and what have I kept from them". The
                site's own home is one button away there. */}
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
              onOpenSite ? (
                <a
                  className={styles.domain}
                  href={sitePathFor(domain)}
                  title={`Everything from ${domain}`}
                  onClick={e => { e.preventDefault(); onOpenSite(domain); }}
                >
                  {domain}
                </a>
              ) : (
                <a
                  className={styles.domain}
                  href={siteHomeOf(article.link) || `https://${domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Visit ${domain}`}
                >
                  {domain}
                </a>
              )
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
          {/* Explore and Repost hang off the comment pill's caret. Neither
              needs the article open - you can tell from the card whether it is
              one to quote or one to dig into - and the reader still carries
              both at the foot of the text for the times you decide after
              reading. Repost quotes what the card is showing, which is the same
              metadata the reader would embed. */}
          <CommentBar
            count={commentCount}
            onClick={onOpenReader}
            onExplore={onExplore && (() => onExplore(article.link, article.title))}
            onRepost={() => startRepost({
              title: article.title,
              embed: articleEmbed({
                url: article.link,
                title: article.title,
                source: article.source || domain,
                imageUrl: article.imageUrl,
                readTime: article.readTime != null ? `${article.readTime} min read` : null,
              }),
            })}
            shareUrl={article.link}
          />
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
                : { folderId: id || null, label: destinations.find(d => d.id === id)?.label ?? 'Unsorted' }
            )}
            onCreateDestination={onCreateFolder && (async name => {
              const folderId = await onCreateFolder(name);
              onSave({ folderId, label: name });
            })}
          />
        </div>
        {/* Floating window-style controls - top-right, over the cover art.
            Only Dismiss lives up here now; see the action strip above.
            Dropped on a dismissed card rather than hidden with an attribute:
            .cardActions sets `display: flex`, which would beat [hidden]'s UA
            `display: none` and leave them looking clickable. They're absolute,
            so removing them costs the card no height. A saved card keeps them -
            "I've filed that, now get it off my feed" is one of the more common
            things to want next. */}
        {(!ghost || saved) && <div className={styles.cardActions}>
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
