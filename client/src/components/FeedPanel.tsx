import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from '../services/api';
import { canonicalArticleKey } from '../utils/articleKey';
import { FeedArticle, CommentPrefs, ReadingFolder, FeedFolder, FeedSubscription } from '../types';
import { faviconUrl } from '../utils/color';
import { blogAuthorOfUrl } from '../utils/blogUrl';
import { profilePathFor } from '../utils/profileUrl';
import { sitePathFor } from '../utils/siteUrl';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { useSaveCounts } from '../hooks/useSaveCounts';
import { articleEmbed } from '../utils/noteEmbed';
import { startRepost } from '../utils/composerSeed';
import { CommentBar } from './CommentsPanel';
import ArticleDetailModal from './ArticleDetailModal';
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from './LayoutSwitch';
import FeedFilterBar, { FilterGroup } from './FeedFilterBar';
import TagChip from './TagChip';
import SaveButton, { SaveDestination } from './SaveButton';
import { prepareFavorites, favoritesFor, coveringFavorites } from '../utils/favoriteTags';
import { hideWithoutMovingThePage } from '../utils/scrollAnchor';
import { saveCountLabel } from '../utils/saveCount';
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

interface Props {
  /** The reader's own categories, offered as one of the filters. */
  feedFolders: FeedFolder[];
  /** Every feed followed, in the reader's own order.
   *
   *  The list, not a count, because the Site filter is built from it: the sites
   *  worth offering are the ones subscribed to, not the ones that happen to have
   *  dealt a card into the page on screen. Its length still decides the empty
   *  state - zero gets "add some feeds" rather than "nothing published yet",
   *  which are different problems and only one of them has a button that helps.
   */
  subscriptions: FeedSubscription[];
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
  /** Canonical keys (see utils/articleKey) of everything already in the reading
      list or the Library, so a card can show its Save button already filled in.
      Comes from the parent's copy of the list, which is what makes the state
      survive a reload - the feed itself has no idea what you have saved. */
  savedKeys?: Set<string>;
  /** Take an article back out of the reading list / Library - what pressing a
      filled Save button does. Absent leaves Save as a one-way action. */
  onUnsaveArticle?: (url: string) => void;
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
  /** Star/unstar one tag - from a tag chip on a card, or from the star beside
      a topic in the filter bar. The feed has no whole-list editor of its own
      any more; the Topic list is where you curate favourites now. */
  onToggleFavoriteTag?: (tag: string) => void;
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

// The same bookmark, filled. A save is a state you should be able to read off
// the card at a glance, without stopping to compare label text.
const BookmarkFilledIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="3 13 9 19 21 5" />
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

// A default that keeps its identity between renders - the effect below is keyed
// on this set, and a fresh empty one every render would re-run it every render.
const NO_SAVED_KEYS: Set<string> = new Set();

export default function FeedPanel({ feedFolders, subscriptions, onManageFeeds, onSaveArticle, savedKeys = NO_SAVED_KEYS, onUnsaveArticle, readingFolders = [], onCreateFolder, refreshKey, pageSize = 10, layout = 'magazine', onLayoutChange, markReadOnScroll = true, onUnreadCountsChange, commentPrefs, onAllMarkedRead, onViewProfile, onExplore, onOpenSite, favoriteTags = [], onToggleFavoriteTag }: Props) {
  const [readIds, setReadIds]           = useState<Set<string>>(new Set());
  const [articles, setArticles]         = useState<FeedArticle[]>([]);
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(true);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [error, setError]               = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // A subscription id, not a source name. Site joined Category on the server
  // in v1.25.0; see the scope note on `load` below for why it had to.
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  // Category and site are the two filters that go to the server; topic still
  // sifts what has already been fetched. The difference is that the first two
  // narrow the query itself, because `total` and `unread` are counted against
  // that query and paging measures against `total`. A topic is a property of an
  // article rather than of a subscription, so there is no subscription set that
  // expresses it and nothing for the scope to be narrowed to.
  const [activeFeedFolder, setActiveFeedFolder] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  /**
   * What a card should show while the reading list catches up with it.
   *
   * Saved state is really the parent's `savedKeys`, which is the reading list
   * itself and therefore the only copy that survives a reload. But that list
   * only changes once the write lands, and a Save button that waits a round trip
   * before filling in reads as a press that missed - so a press records what it
   * committed to here, keyed on the canonical URL, and this wins until the list
   * agrees (or the write fails and puts it back).
   */
  const [savedOverride, setSavedOverride] = useState<Map<string, boolean>>(new Map());
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

  /**
   * The sites offered by the Site filter: every feed followed, in the scope the
   * category filter has set — not the sites the loaded page happens to contain.
   *
   * This is the whole of the fix. The list used to be `articles.map(a => a.source)`,
   * which meant a publisher only appeared in the filter once it had already put
   * an article in front of you: to narrow down to one that had been quiet for a
   * few pages you had to page the river until it turned up, at which point you
   * no longer needed the filter. Reading it off the subscriptions instead means
   * a site is filterable because you follow it, which is the only thing that
   * should ever have decided it.
   *
   * Narrowed by the active category, because that is the scope the request is
   * already made in: offering a site from Local while Tech is selected would be
   * offering a filter that resolves to nothing.
   *
   * The label matches what the cards say, and has to be derived the same way the
   * server derives it (see the `source` field in routes/feeds.ts): the
   * subscription's own name wins, then the publisher's title, then the host.
   */
  const siteOptions = useMemo(() => {
    const inScope = activeFeedFolder
      ? subscriptions.filter(sb => sb.feedFolderId === activeFeedFolder)
      : subscriptions;
    return inScope
      .map(sb => ({
        value: sb.id,
        label: sb.name || sb.title || domainOf(sb.url) || sb.url,
        hint: domainOf(sb.url),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [subscriptions, activeFeedFolder]);

  // Favourites that nothing on screen is tagged with any more.
  //
  // The Topic list is the only place the feed lets you curate favourites now,
  // and it can only offer a star against a topic it is showing - so a favourite
  // that has stopped matching would have no star to switch off, on the very
  // page it is affecting. These get listed at the foot of that list instead.
  // `coveringFavorites([f], c)` asks the question the star asks: does this one
  // favourite cover this one topic, broad matches included.
  const orphanFavorites = useMemo(
    () => favoriteTags.filter(f => !allCategories.some(c => coveringFavorites([f], c).length > 0)),
    [favoriteTags, allCategories]
  );

  // No site test here any more: when one is picked the request was scoped to it,
  // so every article loaded is already from it. Testing `a.source` on top of that
  // would also be wrong rather than merely redundant — two subscriptions are
  // allowed to share a name, and the string cannot tell them apart.
  const displayed = articles.filter(a =>
    (!activeCategory || a.categories.includes(activeCategory)) &&
    (!favoritesOnly || favHits.has(a.id)) &&
    (!unreadOnly || unreadPinned.has(a.id))
  );

  // The filter has to go when its last match does, or you're left staring at an
  // empty feed with no obvious way out.
  useEffect(() => {
    if (favoritesOnly && favorites.length === 0) setFavoritesOnly(false);
  }, [favoritesOnly, favorites.length]);

  /**
   * The category and site the river is being asked for, as query params.
   *
   * Both narrow the query rather than the response. A client-side site filter
   * could only ever hide cards that had already been fetched, which is why the
   * old one could not offer a site until the river had dealt one of its
   * articles — and why filtering to a quiet publisher used to mean paging down
   * until you found the thing you were trying to filter for.
   *
   * It also puts the counts right. `total` and `unread` come back measured
   * against this scope, so the Unread chip counts that site's unread rather than
   * the whole river's, and "Load more · N remaining" counts what is actually
   * left to load rather than what is left before filtering.
   */
  const scope =
    (activeFeedFolder ? `&folder=${encodeURIComponent(activeFeedFolder)}` : '') +
    (activeFeedId ? `&feed=${encodeURIComponent(activeFeedId)}` : '');

  /**
   * How many articles to ask for per page.
   *
   * `pageSize` is the reader's own setting (Settings - 5, 10, 20 or 50), and
   * they picked it looking at cards. A list row is less than half the height of
   * a card, so from v1.27.0 the same number covers about a third of the screen
   * it used to: ten articles is 310px of a 900px column, a page that ends well
   * before the fold and leaves the reader looking at empty space until the
   * infinite scroll has fired three times.
   *
   * Scaled rather than overridden, so the setting still means what it says
   * relative to itself - 5 is still the smallest bite and 50 still the largest,
   * and someone who set it low to keep requests small still gets a small page.
   * Only the list is dense enough to need it; cards and magazine are unchanged.
   */
  const effectivePageSize = layout === 'list' ? pageSize * 3 : pageSize;

  const load = useCallback(async (offset = 0, existing: FeedArticle[] = []) => {
    offset === 0 ? setLoading(true) : setLoadingMore(true);
    setError('');
    try {
      const r = await apiFetch(`/api/v1/feeds/articles?offset=${offset}&limit=${effectivePageSize}${scope}`);
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
  }, [scope, effectivePageSize]);

  /**
   * Switching category. Clears the narrower filters, because they were chosen
   * against a list that no longer exists: a site in Tech usually isn't in Local
   * at all, and a topic that was all over one category can be absent from the
   * next.
   *
   * Done here rather than in the reload effect below, which is where it used to
   * live. That effect now also fires when the *site* changes, and clearing the
   * site from inside an effect the site triggers would either undo the pick or
   * cost a second round trip to settle.
   */
  function changeCategory(v: string | null) {
    setActiveFeedFolder(v);
    setActiveFeedId(null);
    setActiveCategory(null);
  }

  // Switching site. The topic goes for the same reason - it was picked off the
  // topics the whole river was showing, and one publisher rarely carries them
  // all. The category stays: a site is inside a category, not beside it.
  function changeSite(v: string | null) {
    setActiveFeedId(v);
    setActiveCategory(null);
  }

  // A new scope is a different list, so nothing measured against the old one
  // survives it: not the articles, not the read set the sweep compares against,
  // not the unread snapshot, not the arrivals count.
  useEffect(() => {
    setArticles([]);
    setTotal(0);
    setReadIds(new Set());
    setUnreadOnly(false);
    setUnreadPinned(new Set());
    unreadJudged.current = new Set();
    // Cleared here rather than in its own effect so it happens before the read
    // sweep seeds it - the other order wiped the seeding on every reload.
    seenRef.current = new Set();
    setNewCount(0);
    load(0, []);
  }, [activeFeedFolder, activeFeedId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Arrivals: counted here, inserted only when asked for ────────────────

  /**
   * Redraws the feed from the top, keeping the filters you set.
   *
   * Deliberately not the reset effect above: that one also clears the site and
   * topic filters, which is right when you switch category (a site in Tech
   * usually isn't in Local) and wrong here. Asking for new articles is not
   * asking to be put back at the start of your own view.
   *
   * The scroll goes to the top, because the whole point of the press was to see
   * what has arrived above what you were reading.
   */
  const reloadFromTop = useCallback(() => {
    seenRef.current = new Set();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    load(0, []);
  }, [load]);

  // Counts what has landed since `loadedAt`. Never touches the list.
  const checkForNew = useCallback(async () => {
    if (!loadedAt) return;
    try {
      const r = await apiFetch(`/api/v1/feeds/articles/new-count?since=${encodeURIComponent(loadedAt)}${scope}`);
      if (!r.ok) return;
      const data: { count: number } = await r.json();
      setNewCount(data.count);
    } catch {
      // A count that failed to arrive is not worth telling anyone about; the
      // next tick will have another go.
    }
  }, [loadedAt, scope]);

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
        body: JSON.stringify({ folder: activeFeedFolder ?? 'all', feed: activeFeedId ?? 'all' }),
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
   * flush.
   */
  const markRead = useCallback((ids: string[]) => {
    const fresh = ids.filter(id => !readIdsRef.current.has(id));
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
  }, [activeFeedFolder, activeFeedId]);


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

  // One list of links, counted two ways: both hooks batch a screenful into a
  // single request, so they take the same memo rather than each rebuilding it.
  const links = useMemo(() => articles.map(a => a.link), [articles]);

  const { counts: commentCounts, setCount: setCommentCount } = useCommentCounts(links);

  // How many people have saved each article. An aggregate - never who.
  const { counts: saveCounts, adjust: adjustSaveCount } = useSaveCounts(links);

  // The article open in the reader modal
  const [reading, setReading] = useState<FeedArticle | null>(null);

  // ── Mark everything read ──────────────────────────────────────────────
  // Covers the pages that haven't been scrolled to yet, which is the whole
  // point - the server walks the subscriptions rather than the loaded list.
  // Scoped to the active category, so clearing Tech doesn't quietly wipe the
  // news you hadn't got to.
  const [markingAll, setMarkingAll] = useState(false);
  const unreadShowing = markReadOnScroll && displayed.some(a => !readIds.has(a.id));

  async function handleMarkAllRead() {
    if (markingAll) return;
    setMarkingAll(true);
    // Anything already queued would otherwise land after the bulk write
    pendingRef.current.clear();
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    try {
      const r = await apiFetch('/api/v1/feeds/articles/read-all', {
        method: 'POST',
        body: JSON.stringify({ folder: activeFeedFolder ?? 'all', feed: activeFeedId ?? 'all' }),
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

  // An override has done its job the moment the reading list says the same
  // thing, and holding it past that point would freeze the card against a list
  // that has since changed elsewhere - unsaved from the reading list panel, say.
  useEffect(() => {
    setSavedOverride(prev => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const [key, want] of prev) if (savedKeys.has(key) === want) next.delete(key);
      return next.size === prev.size ? prev : next;
    });
  }, [savedKeys]);

  const isSaved = useCallback((url: string) => {
    const key = canonicalArticleKey(url);
    return savedOverride.get(key) ?? savedKeys.has(key);
  }, [savedOverride, savedKeys]);

  function setSavedFlag(url: string, value: boolean) {
    setSavedOverride(prev => new Map(prev).set(canonicalArticleKey(url), value));
  }

  // `dest` is what the Save button's caret picked: absent means the reading
  // list, which is what pressing the label alone does. A Library shelf skips
  // the reading list entirely - the article is one you're filing, not one
  // you're queueing to read.
  //
  // The article stays on the feed either way. Saving used to dismiss it - the
  // card greyed out and the next refresh took it away - which made a save an
  // exit as much as a save, and there was nothing to press if you had filed the
  // wrong thing. It is a toggle now, and the card is just a card that is saved.
  function handleSave(a: FeedArticle, dest?: { folderId: string | null; label: string }) {
    // What the button was showing before this press: a failed save puts that
    // back rather than assuming "not saved", since a copy may already be filed
    // somewhere else and this press only added a second one.
    const was = isSaved(a.link);
    onSaveArticle(
      { id: a.id, url: a.link, title: a.title, source: a.source, categories: a.categories, readTime: a.readTime, imageUrl: a.imageUrl },
      {
        // The save count moves with the button, and only when this press
        // actually adds the viewer to it: filing an article they had already
        // saved onto a second shelf is a second row but the same person, which
        // is what the server counts.
        markSaved: () => { setSavedFlag(a.link, true); if (!was) adjustSaveCount(a.link, 1); },
        restore: () => { setSavedFlag(a.link, was); if (!was) adjustSaveCount(a.link, -1); },
      },
      dest ? { folderId: dest.folderId } : undefined
    );
  }

  // Pressing a filled Save button. The card fills out again on its own if the
  // parent's delete fails, because the override is dropped the moment the
  // reading list disagrees with it.
  function handleUnsave(a: FeedArticle) {
    if (!onUnsaveArticle) return;
    setSavedFlag(a.link, false);
    // Follows the button for the same reason the button doesn't wait: a number
    // that only moves after a round-trip reads as one that ignored you. There
    // is no failure callback on this path, so a delete that fails leaves the
    // count one low until the next load refetches it.
    adjustSaveCount(a.link, -1);
    onUnsaveArticle(a.link);
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
  // Favourites folded into Topic in v1.25.0 and stopped being a chip of its own.
  // It was never a fourth axis - it selects topics, by star instead of by name -
  // and it is the same list you star from, so the filter and the thing it
  // filters on now live in one panel: Favorites at the head, then every topic
  // with its star beside it, then the favourites this feed has stopped
  // publishing. The two compose, so Favorites *and* one topic is still sayable.
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
      onChange: changeCategory,
      searchable: feedFolders.length > SEARCHABLE_AT,
      options: feedFolders.map(f => ({ value: f.id, label: f.name, color: f.color })),
    },
    {
      id: 'site',
      label: 'Site',
      allLabel: 'All sites',
      value: activeFeedId,
      onChange: changeSite,
      searchable: siteOptions.length > SEARCHABLE_AT,
      options: siteOptions,
    },
    {
      id: 'topic',
      label: 'Topic',
      allLabel: 'All topics',
      value: activeCategory,
      onChange: setActiveCategory,
      // Searchable at any length once it's starrable: the box is also how you
      // favourite a tag this feed hasn't published yet, which is what the
      // Favorites chip's own text field used to be for.
      searchable: allCategories.length > SEARCHABLE_AT || !!onToggleFavoriteTag,
      onToggleStar: onToggleFavoriteTag,
      orphanStars: onToggleFavoriteTag ? orphanFavorites : undefined,
      // Offered whenever there is a list to manage, not only when something
      // matches - otherwise a favourite that has stopped matching takes its own
      // way out with it. The control disables its filter at zero hits.
      toggle: onToggleFavoriteTag && (favoriteTags.length > 0 || favHits.size > 0)
        ? {
            label: 'Favorites',
            count: favHits.size,
            active: favoritesOnly,
            onToggle: () => setFavoritesOnly(v => !v),
          }
        : undefined,
      options: allCategories.map(c => {
        const covering = onToggleFavoriteTag ? coveringFavorites(favoriteTags, c) : [];
        const starred = covering.length > 0;
        return {
          value: c,
          label: c,
          starred,
          starTitle: starred
            ? (covering[0].toLowerCase() !== c.toLowerCase()
                ? `Matched by your favorite “${covering[0]}” - click to remove it`
                : `Remove “${c}” from favorites`)
            : `Favorite “${c}” - articles tagged this way get flagged`,
        };
      }),
    },
  ];

  // ── One bar, and it comes with you ──
  // Everything that operates on the feed, in a single strip that sticks under
  // the shell bar for as long as the feed is on screen.
  //
  // It was two bands before - actions above, filters in a box below - and both
  // of them scrolled away the moment you started reading. Which is the moment
  // they start being wanted: you notice a category is flooding the list, or that
  // you've read everything worth reading, some way down the page, and the only
  // route back to any of it was scrolling to the top.
  //
  // "Mark all read" is not one of the actions at the far end. It writes to every
  // article you have, and it was sitting between "Manage feeds" and the layout
  // switch - two controls that set the feed up and change how it is drawn, and
  // neither of which touches a single article. It belongs to the Unread chip
  // instead, on the same axis: one shows you what is unread, the other makes
  // none of it unread. So it hangs off that chip's caret, the way the shell's
  // avatar menu hangs off the avatar.
  //
  // That also took the widest control out of the row, which is most of what the
  // row was short of - see the overlap note in FeedFilterBar's stylesheet.
  //
  // `menu` is undefined rather than an empty fragment when there is nothing to
  // offer: FeedFilterBar draws no caret at all then, instead of one that opens
  // on nothing.
  const markAllRead = markReadOnScroll && articles.length > 0 ? (
    <button
      className={styles.actionBtnMain}
      onClick={handleMarkAllRead}
      disabled={markingAll || !unreadShowing}
      title={activeFeedId
        ? 'Mark every article from this site as read'
        : activeFeedFolder
          ? 'Mark every article in this category as read'
          : 'Mark every article in your feed as read'}
    >
      <CheckAllIcon />
      {markingAll ? 'Marking…' : 'Mark all read'}
    </button>
  ) : undefined;

  // ── One bar, and it comes with you ──
  // Everything that operates on the feed, in a single strip that sticks under
  // the shell bar for as long as the feed is on screen.
  //
  // It was two bands before - actions above, filters in a box below - and both
  // of them scrolled away the moment you started reading. Which is the moment
  // they start being wanted: you notice a category is flooding the list, or that
  // you've read everything worth reading, some way down the page, and the only
  // route back to any of it was scrolling to the top.
  //
  // Drawn in every state, including the ones that render nothing else: "Manage
  // feeds" has to be reachable precisely when the feed is empty, which is when
  // it is hardest to find. FeedFilterBar returns null on an empty bar unless it
  // has actions, which is what keeps that true.
  const controlBar = (
    <div className={styles.controls}>
      <FeedFilterBar
        className={styles.filterBox}
        groups={filterGroups}
        // Read state is only tracked when read-on-scroll is on, so without it
        // there is no such thing as unread here to filter to - and nothing to
        // mark as read either, which is why both halves of the chip are gated
        // on the same setting.
        unread={markReadOnScroll
          ? { count: unreadTotal, active: unreadOnly, onToggle: toggleUnreadOnly, menu: markAllRead }
          : undefined}
        actions={
          <>
            {/* Icon and a tooltip, at every width. This is the rarest control
                in the bar - you set your feeds up once - and the sliders glyph
                is the same one the feed manager itself wears, so the button
                looks like the thing it opens. The words are still in the
                accessibility tree, and they come back as a label inside the ⋯
                menu, where there is room for them: see `--action-label`. */}
            <button
              className={styles.manageBtn}
              onClick={onManageFeeds}
              title="Manage feeds"
              aria-label="Manage feeds"
            >
              <SlidersIcon />
              <span className={styles.actionLabel}>Manage feeds</span>
            </button>

            {onLayoutChange && articles.length > 0 && (
              <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Feed layout" />
            )}
          </>
        }
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
  if (subscriptions.length === 0) return (
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
      {activeFeedId ? (
        <div className={styles.status} style={{ opacity: 0.45 }}>
          Nothing from {siteOptions.find(o => o.value === activeFeedId)?.label ?? 'this site'} yet.{' '}
          <button className={styles.inlineBtn} onClick={() => changeSite(null)}>Show all sites</button>
        </div>
      ) : activeFeedFolder ? (
        <div className={styles.status} style={{ opacity: 0.45 }}>
          Nothing in this category yet.{' '}
          <button className={styles.inlineBtn} onClick={() => changeCategory(null)}>Show all feeds</button>
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
            read={readIds.has(a.id)}
            saved={isSaved(a.link)}
            cardRef={markReadOnScroll ? observeCard : undefined}
            onSave={dest => handleSave(a, dest)}
            onUnsave={onUnsaveArticle && (() => handleUnsave(a))}
            readingFolders={readingFolders}
            onCreateFolder={onCreateFolder}
            commentCount={commentCounts[a.link] ?? 0}
            saveCount={saveCounts[a.link] ?? 0}
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
          saveCount={saveCounts[reading.link] ?? 0}
          prefs={commentPrefs}
          onCountChange={setCommentCount}
          onClose={() => setReading(null)}
          onViewProfile={onViewProfile}
          onExplore={onExplore}
          actions={
            // The card's own control, unchanged: the reading list on the label,
            // a shelf behind the caret. Deciding after reading is the common
            // case, so it should not be a different button. It stays put once
            // pressed - the reader no longer closes on a save, because saving
            // something is not the same as being finished with it.
            <SaveButton
              label="Save"
              icon={<BookmarkIcon />}
              savedIcon={<BookmarkFilledIcon />}
              saved={isSaved(reading.link)}
              onUnsave={onUnsaveArticle && (() => handleUnsave(reading))}
              menuLabel="Save to…"
              defaultId={READING_LIST_DEST}
              destinations={destinationsFor(readingFolders)}
              onSelect={id => handleSave(reading, id === READING_LIST_DEST
                ? undefined
                : { folderId: id || null, label: shelfLabel(id, readingFolders) })}
              onCreateDestination={onCreateFolder && (async name => {
                const folderId = await onCreateFolder(name);
                handleSave(reading, { folderId, label: name });
              })}
            />
          }
        />
      )}
    </div>
  );
}

function ArticleCard({ article, variant, isNew, read, saved, cardRef, onSave, onUnsave, readingFolders = [], onCreateFolder, commentCount, saveCount, onOpenReader, onOpenLink, onViewProfile, onOpenSite, onExplore, favHits, favoriteTags = [], onToggleFavoriteTag }: {
  article: FeedArticle; variant?: MagVariant; isNew?: boolean;
  /**
   * You have read this one - scrolled past it, opened the reader on it, or
   * followed it out to the site. Independent of `isNew`, which is only ever set
   * when the mark-on-scroll setting is on: with that setting off nothing is
   * drawn as unread, but an article you actually opened is still read and still
   * says so.
   */
  read?: boolean;
  /** This article is in the reading list or the Library already. */
  saved?: boolean;
  cardRef?: (el: HTMLDivElement | null, id: string) => void;
  onSave: (dest?: { folderId: string | null; label: string }) => void;
  /** Takes it back out. Absent leaves Save one-way. */
  onUnsave?: () => void;
  readingFolders?: ReadingFolder[];
  onCreateFolder?: (name: string) => Promise<string>;
  commentCount: number;
  /** How many people have saved this article. 0 draws no badge. */
  saveCount: number;
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

  // One line for both, dot-joined only where there are two things to join.
  const readLine = [
    article.readTime != null
      ? (article.readTime === 1 ? '1 minute read' : `${article.readTime} minute read`)
      : null,
    saveCountLabel(saveCount),
  ].filter(Boolean).join(' · ');

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
  const wrapClass = [
    styles.cardWrap,
    isNew ? styles.unread : '',
    variant === 'feature' ? styles.featureWrap : '',
    variant === 'brief' ? styles.briefWrap : '',
    variant === 'text' ? styles.textWrap : '',
    favHits && favHits.length > 0 ? styles.favCard : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={wrapClass} ref={cardRef ? el => cardRef(el, article.id) : undefined}>
      <div className={styles.card}>
        {/* The art is the biggest target on a magazine card and it is the thing
            people aim at, so it goes where the headline goes. Out of the tab
            order and hidden from assistive tech on purpose: it leads to exactly
            the same place as the title two lines below, and a second link with
            no text of its own is noise to anyone not using a mouse.
            A broken image hides the link, not just the <img> - hiding only the
            picture would leave the link's negative margins pulling the card's
            text up into its own padding.

            It hides it without moving the page, which is a different job: the
            art is lazy, so it can fail seconds after its card was laid out and
            long after the reader has scrolled past. Taking 170px out of a card
            above the viewport slides the article being read up by 170px, and
            Safari - alone among the engines - will not correct for it. That is
            the feed "skipping content" on a phone. See utils/scrollAnchor. */}
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
              onError={e => { const img = e.currentTarget; hideWithoutMovingThePage(img.parentElement ?? img); }}
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
        {/* How long it takes, and what everyone else did with it. Both are
            facts about the article rather than things the card can do, which is
            why the save count reads here and not as a badge on the Save pill -
            see saveCountLabel for why the small numbers stay unprinted. */}
        {readLine && <span className={styles.readTime}>{readLine}</span>}
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
            {/* The two are exclusive by definition, and the dot is the louder of
                them on purpose: unread is a call to look, read is a receipt. */}
            {isNew ? (
              <span className={styles.newDot} role="img" aria-label="Unread" title="Unread" />
            ) : read ? (
              <span className={styles.readChip} title="You've read this">
                <CheckIcon />
                Read
              </span>
            ) : null}
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
          {/* The one thing on the card that reports a state rather than doing
              something new: once the article is saved the pill says so and
              pressing it takes the save back. The caret keeps its whole menu
              either way, so a saved article can still be filed onto a shelf. */}
          <SaveButton
            className={styles.rowSave}
            label="Save"
            icon={<BookmarkIcon />}
            savedIcon={<BookmarkFilledIcon />}
            saved={saved}
            onUnsave={onUnsave}
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
      </div>
    </div>
  );
}
