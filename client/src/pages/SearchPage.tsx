import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './SearchPage.module.css';
import { Bookmark, ReadingListItem, ReadingFolder, CommentVisibility } from '../types';
import { NoteDoc } from '../hooks/useSettings';
import { useSiteSearch } from '../hooks/useSiteSearch';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { useSaveCounts } from '../hooks/useSaveCounts';
import { SearchFilter, SEARCH_KINDS, SearchKind, searchPathFor } from '../utils/searchUrl';
import { searchNotes } from '../utils/noteText';
import { bookmarkHref, faviconUrl } from '../utils/color';
import { relTime } from '../utils/notifications';
import { blogAuthorOfUrl } from '../utils/blogUrl';
import { siteDomainOf } from '../utils/siteUrl';
import { canonicalArticleKey } from '../utils/articleKey';
import { articleEmbed } from '../utils/noteEmbed';
import { startRepost } from '../utils/composerSeed';
import { coveringFavorites } from '../utils/favoriteTags';
import { destinationsFor, READING_LIST_DEST } from '../utils/saveDestinations';
import { POST_VIS_META, VIS_META } from '../components/VisibilityMeta';
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from '../components/LayoutSwitch';
import FeedFilterBar, { FilterGroup } from '../components/FeedFilterBar';
import { CommentBar } from '../components/CommentsPanel';
import SaveButton from '../components/SaveButton';

// ── The search page ───────────────────────────────────────────────────────
//
// What a plain query in the search box now opens, instead of a search engine.
//
// The box has always searched *some* of this — bookmarks, notes, the reading
// list, the feed archive — in a dropdown of eight rows, as a way of getting to
// one thing you half-remembered. That is a different job from the one this page
// does: everything on the instance about a subject, including the two corpora
// the dropdown never reached, posts and explores. Six or seven rows can't hold
// that, and a dropdown is the wrong shape for reading results anyway.
//
// The split of who searches what is deliberate and is documented in
// utils/searchUrl: the server answers the three corpora that are too large or
// too visibility-dependent to hold in the page, and the three that are the
// reader's own and already in memory are filtered here.
//
// ── Nothing here is this page's own ──
// The controls are the feed's control bar, the cards are the feed's cards, and
// the two buttons on them are the feed's two buttons. That is the point rather
// than a shortcut: a result *is* a feed card — the same article, found a
// different way — and a search page that invented its own filters, its own card
// and its own way to save would make the reader learn the app twice.
//
// The one shape that had to change is the anchor. A result has four targets —
// the headline, the publisher, Save and Discuss — and an anchor may contain
// none of them, so the row is a container and each target is its own control,
// exactly as an ArticleCard is built.

export type SearchLayout = 'list' | 'cards' | 'magazine';

const LAYOUT_OPTIONS = [
  { value: 'list' as const,     title: 'List',     icon: <ListIcon /> },
  { value: 'cards' as const,    title: 'Cards',    icon: <CardsIcon /> },
  { value: 'magazine' as const, title: 'Magazine', icon: <MagazineIcon /> },
];

/** The article fields a save is made from — the same shape the feed sends. */
export interface SaveFields {
  url: string;
  title: string;
  source: string;
  categories: string[];
  readTime: number | null;
  imageUrl: string | null;
}

interface Props {
  query: string;
  filter: SearchFilter;
  navigate: (to: string) => void;
  /** The reader's own corpora, already loaded by the shell. */
  bookmarks: Bookmark[];
  readingItems: ReadingListItem[];
  notes: NoteDoc[];
  /** Opens an article's reader (and its comment thread) over the shell. */
  onOpenArticle: (url: string) => void;
  /** Opens a note in the notes console, highlighting the query inside it. */
  onOpenNote: (id: string, query: string) => void;
  /** Opens a publisher's page. What the byline under a headline links to. */
  onOpenSite?: (domain: string) => void;
  /** How the results draw themselves. Its own setting - see useSettings. */
  layout?: SearchLayout;
  onLayoutChange?: (layout: SearchLayout) => void;
  /** Starred topics, so the Topic filter stars the same words the feed does. */
  favoriteTags?: string[];
  onToggleFavoriteTag?: (tag: string) => void;

  // ── The Save and Discuss controls ──
  // The same handlers the feed is given, so an article saved from a result and
  // one saved from the river are the same write with the same optimism. Absent
  // together: a page with no save handler draws no Save button rather than a
  // dead one.
  /** canonicalArticleKey of everything already in the reading list. */
  savedKeys?: Set<string>;
  readingFolders?: ReadingFolder[];
  onSaveArticle?: (
    a: SaveFields,
    card: { markSaved: () => void; restore: () => void },
    dest?: { folderId: string | null },
  ) => void;
  onUnsaveArticle?: (url: string) => void;
  onCreateFolder?: (name: string) => Promise<string>;
  /** Opens an Explore thread. Undefined when the account has no model. */
  onExplore?: (url: string, title: string) => void;
}

const KIND_LABELS: Record<SearchFilter, string> = {
  all: 'All',
  articles: 'Articles',
  posts: 'Posts',
  explores: 'Explores',
  saved: 'Saved',
  bookmarks: 'Bookmarks',
  notes: 'Notes',
};

/**
 * How many of each kind the All view shows before deferring to that kind's own.
 *
 * Four, because the point of All is to tell the reader *which* corpus holds
 * what they're after. A section long enough to scroll past buries the next
 * heading, and the next heading is the answer.
 */
const PREVIEW = 4;

/** Matches the server's floor, and the dropdown's. */
const MIN_LEN = 2;

/** Where a filter list gets long enough to want a search box in it. */
const SEARCHABLE_AT = 8;

/** The corpora the shell answers itself, whose counts are never pending. */
const LOCAL_KINDS: SearchKind[] = ['saved', 'bookmarks', 'notes'];

const BookmarkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

const BookmarkFilledIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

function tagsOf(item: ReadingListItem): string[] {
  return item.tag ? item.tag.split(',').map(t => t.trim()).filter(Boolean) : [];
}

/**
 * The badge for a visibility tier, or null for the one not worth saying.
 *
 * Public is deliberately silent. Badging every public post "Public" would put a
 * label on almost every card and so say nothing; a Draft badge on your own
 * unpublished one is the whole reason the badge exists.
 */
function visBadge(visibility: string, post: boolean): string | null {
  if (visibility === 'public') return null;
  const meta = (post ? POST_VIS_META : VIS_META)[visibility as CommentVisibility];
  if (!meta) return null;
  // An explore's private tier is a private *thread*, not the "Personal Note"
  // the comment vocabulary calls it.
  return !post && visibility === 'private' ? 'Private' : meta.tag;
}

// One result, flattened — and flattened to the shape an ArticleCard already
// draws, because that is what the layouts below expect to be handed. Every
// corpus on this page is the same handful of fields once you stop caring which
// one it came from; keeping six shapes apart would have meant writing every
// layout six times.
interface Entry {
  key: string;
  title: string;
  /** Where the headline points: what a middle-click or a copied link gets. */
  href: string;
  /**
   * What an ordinary click on the headline does instead. Null for the one kind
   * of result that genuinely leaves — a bookmark is a site, and there is
   * nothing of it to show in here.
   */
  open: (() => void) | null;
  snippet: string | null;
  imageUrl: string | null;
  /**
   * The byline. A publisher links to its page here; a person is printed as the
   * handle the rest of the app prints, and links nowhere from a card that is
   * already about their writing.
   */
  byline: { label: string; domain?: string } | null;
  /** Which site this belongs to, for the Site filter. */
  site: string | null;
  favicon: string | null;
  /** The right-hand column: a relative date, or '' where there is no date. */
  date: string;
  /** Anything else worth saying in the byline row — turns, what it was about. */
  meta: string[];
  tags: string[];
  badge: string | null;
  /**
   * The article this result is, for Save and Discuss. Null for the results that
   * are not articles: a bookmark is a site, and a note is your own writing with
   * nothing to save it to and nobody to discuss it with.
   */
  article: SaveFields | null;
}

// Magazine variants, the same three the feed has: the first entry with art
// leads its section, the rest fall back to whether they have a picture at all.
// Per section rather than per page, because each heading starts a new run of
// results and a lead piece halfway down one reads as a mistake.
type MagVariant = 'feature' | 'standard' | 'text';

function magazineVariants(entries: Entry[]): MagVariant[] {
  let led = false;
  return entries.map(e => {
    if (!e.imageUrl) return 'text';
    if (!led) { led = true; return 'feature'; }
    return 'standard';
  });
}

export default function SearchPage({
  query, filter, navigate, bookmarks, readingItems, notes,
  onOpenArticle, onOpenNote, onOpenSite, layout = 'list', onLayoutChange,
  favoriteTags = [], onToggleFavoriteTag,
  savedKeys, readingFolders = [], onSaveArticle, onUnsaveArticle, onCreateFolder, onExplore,
}: Props) {
  // A leading '#' searches labels rather than text, the same as it does in the
  // box's dropdown. The term below is the query with that marker taken off:
  // everything downstream searches for the word, and `tagged` is what says
  // where to look for it.
  const raw = query.trim();
  const tagged = raw.startsWith('#');
  const q = tagged ? raw.slice(1).trim() : raw;
  const lower = q.toLowerCase();
  const short = q.length < MIN_LEN;

  // Which site and which topic to narrow to, both of which sift the results
  // already on the page rather than changing what was asked for. That is the
  // same division the feed draws between its own three filters — see the note
  // on the groups below.
  const [siteFilter, setSiteFilter] = useState<string | null>(null);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);

  const { results, more, loading, loadingMore, error, loadMore } = useSiteSearch(q, filter, tagged);

  // Infinite scroll, the same shape the feed uses: when the sentinel below the
  // results comes into view, fetch the next page. The button under it stays as
  // the manual fallback - and as the thing that says there *is* a next page,
  // which a sentinel on its own never tells anybody.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef(loadMore);
  moreRef.current = loadMore;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) moreRef.current();
    }, { rootMargin: '300px' });
    obs.observe(el);
    return () => obs.disconnect();
    // Re-observed whenever the sentinel appears or disappears, which is what
    // changes when a page lands: loadMore itself is read through a ref, so a
    // new identity for it does not tear the observer down mid-scroll.
  }, [filter, q, loading]);

  // ── The six corpora, each flattened to Entry ────────────────────────────
  const articleEntries = useMemo<Entry[]>(() => results.articles.map(a => {
    // A post written here is credited to its author rather than to the host
    // every author on the instance shares.
    const author = blogAuthorOfUrl(a.url);
    const domain = author ? '' : siteDomainOf(a.url);
    return {
      key: a.id,
      title: a.title,
      href: a.url,
      open: () => onOpenArticle(a.url),
      snippet: a.snippet,
      imageUrl: a.imageUrl,
      byline: author ? { label: `@${author}` } : { label: a.source || domain, domain },
      site: domain || null,
      favicon: domain ? faviconUrl(domain) : null,
      date: a.pubDate ? relTime(a.pubDate) : '',
      meta: [],
      tags: a.categories.slice(0, 3),
      badge: author ? 'Post' : 'Article',
      article: {
        url: a.url, title: a.title, source: a.source,
        categories: a.categories, readTime: null, imageUrl: a.imageUrl,
      },
    };
  }), [results.articles, onOpenArticle]);

  const postEntries = useMemo<Entry[]>(() => results.posts.map(p => ({
    key: p.id,
    title: p.title,
    href: p.href,
    open: () => navigate(p.href),
    snippet: p.snippet || null,
    imageUrl: p.imageUrl || null,
    byline: { label: p.own ? 'You' : p.author ? `@${p.author.username}` : 'Unknown' },
    site: null,
    favicon: null,
    date: p.at ? relTime(p.at) : '',
    meta: [],
    tags: p.tags.slice(0, 3),
    badge: visBadge(p.visibility, true),
    // A post is an article here: it has an address, a comment thread and a save
    // count like any other, and its own page is what the headline opens.
    article: {
      url: p.href, title: p.title,
      source: p.author ? `@${p.author.username}` : '',
      categories: p.tags, readTime: null, imageUrl: p.imageUrl || null,
    },
  })), [results.posts, navigate]);

  const exploreEntries = useMemo<Entry[]>(() => results.explores.map(x => ({
    key: x.id,
    title: x.title,
    href: x.href,
    open: () => navigate(x.href),
    snippet: x.snippet || null,
    // A conversation has no cover, and inventing one would be a picture of
    // nothing. In the card layouts these take the text variant.
    imageUrl: null,
    byline: {
      // "no author" and "the instance wrote it" are different facts, and
      // rendering the first as an anonymous byline is how an AI-written thread
      // ends up looking like a person's.
      label: x.origin === 'auto' ? 'Generated' : x.own ? 'You' : x.author ? `@${x.author.username}` : 'Unknown',
    },
    site: null,
    favicon: null,
    date: x.at ? relTime(x.at) : '',
    meta: [
      x.turns === 1 ? '1 turn' : `${x.turns} turns`,
      x.sourceTitle ? `on “${x.sourceTitle}”` : '',
    ].filter(Boolean),
    tags: [],
    badge: visBadge(x.visibility, false),
    // A thread is a conversation, not an article: there is nothing to save, and
    // its own messages are the discussion.
    article: null,
  })), [results.explores, navigate]);

  // The reader's own three, filtered here. Cheap enough to do on every render
  // of a page that only re-renders when the query or a filter changes, but
  // memoised because notes have to be parsed out of editor HTML to be searched.
  const savedEntries = useMemo<Entry[]>(() => {
    if (short) return [];
    const byTag = (a: ReadingListItem) => tagsOf(a).some(t => t.toLowerCase().includes(lower));
    const hits = tagged
      ? readingItems.filter(byTag)
      : readingItems.filter(a =>
          a.title.toLowerCase().includes(lower)
          || a.source.toLowerCase().includes(lower)
          || a.notes.toLowerCase().includes(lower)
          || byTag(a));
    return hits.map(a => {
      const author = blogAuthorOfUrl(a.url);
      const domain = author ? '' : siteDomainOf(a.url);
      return {
        key: a.id,
        title: a.title,
        href: a.url,
        open: () => onOpenArticle(a.url),
        snippet: a.notes || null,
        imageUrl: a.imageUrl || null,
        byline: author ? { label: `@${author}` } : { label: a.source || domain, domain },
        site: domain || null,
        favicon: domain ? faviconUrl(domain) : null,
        date: relTime(a.savedAt),
        meta: a.readTime ? [a.readTime] : [],
        tags: tagsOf(a).slice(0, 3),
        // A reading-list item and one filed on a shelf are different states,
        // and flattening them would leave you unable to tell what you had
        // already dealt with.
        badge: a.inLibrary ? 'Library' : 'Reading',
        article: {
          url: a.url, title: a.title, source: a.source,
          categories: tagsOf(a), readTime: null, imageUrl: a.imageUrl || null,
        },
      };
    });
  }, [readingItems, lower, short, tagged, onOpenArticle]);

  // Neither of the next two carries a label, so a tag search matches none
  // rather than falling back to matching their text — which would put rows
  // under a heading that says something different from what produced them.
  const bookmarkEntries = useMemo<Entry[]>(() => {
    if (short || tagged) return [];
    return bookmarks
      .filter(b => b.name.toLowerCase().includes(lower) || b.domain.toLowerCase().includes(lower))
      .map(b => ({
        key: b.id,
        title: b.name,
        href: bookmarkHref(b.domain),
        open: null,
        snippet: null,
        imageUrl: null,
        // A bookmark *is* a site, so its page here is the useful second
        // destination: what this publisher has been running and what you have
        // kept from them, without going to their homepage to find out.
        byline: { label: b.domain, domain: siteDomainOf(b.domain) },
        site: siteDomainOf(b.domain),
        favicon: faviconUrl(b.domain),
        date: '',
        meta: [],
        tags: [],
        badge: 'Bookmark',
        article: null,
      }));
  }, [bookmarks, lower, short, tagged]);

  const noteEntries = useMemo<Entry[]>(() => {
    if (short || tagged) return [];
    return searchNotes(notes, lower).map(({ doc, snippet }) => ({
      key: doc.id,
      title: doc.title.trim() || 'Untitled',
      // A note has no address of its own — it opens in the console over
      // whatever page you are on — so there is nothing to middle-click to.
      href: '',
      open: () => onOpenNote(doc.id, q),
      snippet: snippet ?? null,
      imageUrl: null,
      byline: null,
      site: null,
      favicon: null,
      date: doc.updatedAt ? relTime(new Date(doc.updatedAt).toISOString()) : '',
      meta: [],
      tags: [],
      badge: 'Note',
      article: null,
    }));
  }, [notes, lower, short, tagged, onOpenNote, q]);

  const found: Record<SearchKind, Entry[]> = {
    articles: articleEntries,
    posts: postEntries,
    explores: exploreEntries,
    saved: savedEntries,
    bookmarks: bookmarkEntries,
    notes: noteEntries,
  };
  /** How many each corpus found, before the two sifting filters. */
  const foundCounts = SEARCH_KINDS.reduce((acc, k) => {
    acc[k] = found[k].length;
    return acc;
  }, {} as Record<SearchKind, number>);
  const foundTotal = SEARCH_KINDS.reduce((n, k) => n + foundCounts[k], 0);

  const inScope = (kind: SearchKind) => filter === 'all' || filter === kind;

  /**
   * Whether a corpus has more behind what has been fetched.
   *
   * Always false for the three the shell answers itself: those are the reader's
   * own and are searched whole, so what is on screen is all there is.
   */
  const hasMore = (kind: SearchKind) =>
    !LOCAL_KINDS.includes(kind) && (more[kind as keyof typeof more] ?? false);

  /**
   * A count the page is allowed to print.
   *
   * "20+" rather than "20" wherever there is another page, because 20 is how
   * many were fetched and not how many exist. The server could only turn that
   * into a real total by re-running the match with the visibility rules applied
   * to every row rather than one page of them, which is a second full query to
   * decorate a heading with - so the page says what it knows.
   */
  const countLabel = (n: number, more: boolean) => (more ? `${n}+` : String(n));

  // Everything the two sifting filters can see: the corpora on screen, before
  // they are applied. Their options are built from this and their counts are
  // counts of it, so a dropdown never offers a site with nothing behind it.
  const scoped = useMemo(
    () => SEARCH_KINDS.filter(inScope).flatMap(k => found[k]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [articleEntries, postEntries, exploreEntries, savedEntries, bookmarkEntries, noteEntries, filter],
  );

  const siteOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of scoped) if (e.site) counts.set(e.site, (counts.get(e.site) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, n]) => ({ value, label: value, hint: String(n) }));
  }, [scoped]);

  const topicOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of scoped) {
      for (const t of e.tags) {
        const key = t.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, n]) => {
        const covering = onToggleFavoriteTag ? coveringFavorites(favoriteTags, value) : [];
        const starred = covering.length > 0;
        return {
          value,
          label: value,
          hint: String(n),
          starred,
          starTitle: starred
            ? (covering[0].toLowerCase() !== value
                ? `Matched by your favorite “${covering[0]}” - click to remove it`
                : `Remove “${value}” from favorites`)
            : `Favorite “${value}” - articles tagged this way get flagged`,
        };
      });
  }, [scoped, favoriteTags, onToggleFavoriteTag]);

  /** One corpus, sifted by the site and topic filters. */
  const shown = useCallback((kind: SearchKind) => found[kind].filter(e => {
    if (siteFilter && e.site !== siteFilter) return false;
    if (topicFilter && !e.tags.some(t => t.toLowerCase() === topicFilter)) return false;
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [found, siteFilter, topicFilter]);

  const shownCounts = SEARCH_KINDS.reduce((acc, k) => {
    acc[k] = inScope(k) ? shown(k).length : 0;
    return acc;
  }, {} as Record<SearchKind, number>);
  const shownTotal = SEARCH_KINDS.reduce((n, k) => n + shownCounts[k], 0);

  // All previews each corpus; a single-corpus view shows everything it found.
  const cap = filter === 'all' ? PREVIEW : Infinity;

  // Which results are on screen, for the two count endpoints. Both take the
  // whole visible list in one request rather than a fetch per card, so this is
  // deliberately the drawn set and not everything found.
  const shownLinks = useMemo(() => {
    const urls: string[] = [];
    for (const kind of SEARCH_KINDS) {
      if (!inScope(kind)) continue;
      for (const e of shown(kind).slice(0, cap)) if (e.article) urls.push(e.article.url);
    }
    return [...new Set(urls)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, filter, cap]);

  const { counts: commentCounts } = useCommentCounts(shownLinks);
  const { counts: saveCounts, adjust: adjustSaveCount } = useSaveCounts(shownLinks);

  // ── Saving, optimistically ─────────────────────────────────────────────
  // The same two-step the feed's cards make: fill the button in first and talk
  // to the server after, because a press that only lands once the round trip
  // returns reads as a press that missed. The override is keyed on the
  // canonical article key, so a copy saved with a tracking parameter on it
  // still shows as saved here.
  const [savedOverride, setSavedOverride] = useState<Map<string, boolean>>(new Map());

  const isSaved = useCallback((url: string) => {
    const key = canonicalArticleKey(url);
    return savedOverride.get(key) ?? savedKeys?.has(key) ?? false;
  }, [savedOverride, savedKeys]);

  const setSavedFlag = useCallback((url: string, value: boolean) => {
    setSavedOverride(prev => new Map(prev).set(canonicalArticleKey(url), value));
  }, []);

  const handleSave = useCallback((a: SaveFields, dest?: { folderId: string | null }) => {
    if (!onSaveArticle) return;
    // What the button was showing before this press: a failed save puts that
    // back rather than assuming "not saved", since a copy may already be filed
    // somewhere else and this press only added a second one.
    const was = isSaved(a.url);
    onSaveArticle(a, {
      markSaved: () => { setSavedFlag(a.url, true); if (!was) adjustSaveCount(a.url, 1); },
      restore: () => { setSavedFlag(a.url, was); if (!was) adjustSaveCount(a.url, -1); },
    }, dest);
  }, [onSaveArticle, isSaved, setSavedFlag, adjustSaveCount]);

  const handleUnsave = useCallback((url: string) => {
    if (!onUnsaveArticle) return;
    setSavedFlag(url, false);
    adjustSaveCount(url, -1);
    onUnsaveArticle(url);
  }, [onUnsaveArticle, setSavedFlag, adjustSaveCount]);

  const actions: Actions | null = onSaveArticle ? {
    isSaved,
    commentCounts,
    saveCounts,
    destinations: destinationsFor(readingFolders),
    onSave: handleSave,
    onUnsave: onUnsaveArticle ? handleUnsave : undefined,
    onCreateFolder,
    onOpenArticle,
    onExplore,
  } : null;

  // ── The bar ────────────────────────────────────────────────────────────
  // The feed's control bar, with the groups this page has an answer for.
  //
  // Which corpus is a `scope` group and the other two are ordinary filters, and
  // that distinction is the same one the reading list draws with its shelves:
  // picking Posts does not hide part of a list, it swaps which list you are
  // looking at. The flag is what keeps it out of the active-filter count and
  // out of "clear all filters", both of which would be wrong for it — clearing
  // your filters means show me everything in here, never walk me out of here.
  //
  // Site and Topic both sift the page rather than changing the query, which is
  // worth being explicit about because the feed's three do not all agree: there
  // Category and Site narrow the request and only Topic sifts. Here the request
  // is the search term, and there is no version of it narrowed by hostname — so
  // both are page filters, and both count what is on the page.
  const groups: FilterGroup[] = [
    {
      id: 'kind',
      label: 'Show',
      scope: true,
      allLabel: 'All results',
      allColor: 'var(--accent)',
      // "+" if any corpus has more behind it, since this number is their sum.
      allHint: loading ? '' : countLabel(foundTotal, SEARCH_KINDS.some(hasMore)),
      value: filter === 'all' ? null : filter,
      onChange: v => navigate(searchPathFor(raw, (v as SearchKind) ?? 'all')),
      options: SEARCH_KINDS.map(kind => ({
        value: kind,
        label: KIND_LABELS[kind],
        // No number while the server's half is in flight: a "0" that becomes a
        // "7" a moment later reads as a bug. The three the shell answers itself
        // are right already, so they keep theirs.
        hint: loading && !LOCAL_KINDS.includes(kind)
          ? ''
          : countLabel(foundCounts[kind], hasMore(kind)),
      })),
    },
  ];
  if (siteOptions.length > 1) {
    groups.push({
      id: 'site',
      label: 'Site',
      allLabel: 'All sites',
      value: siteFilter,
      onChange: setSiteFilter,
      searchable: siteOptions.length > SEARCHABLE_AT,
      options: siteOptions,
    });
  }
  if (topicOptions.length > 1) {
    groups.push({
      id: 'topic',
      label: 'Topic',
      allLabel: 'All topics',
      value: topicFilter,
      onChange: setTopicFilter,
      searchable: topicOptions.length > SEARCHABLE_AT,
      // Starring here does the same thing it does in the feed and the reading
      // list: these are the same words and the same favourites list.
      onToggleStar: onToggleFavoriteTag,
      options: topicOptions,
    });
  }

  const body = () => {
    if (!raw) {
      return (
        <p className={styles.note}>
          Type a search in the box above. Everything here — your feeds, the posts
          and explores you can see, your saves, bookmarks and notes — is searched
          at once.
        </p>
      );
    }
    if (short) {
      return <p className={styles.note}>Searching needs at least two characters.</p>;
    }

    return (
      <>
        {SEARCH_KINDS.map(kind => {
          if (!inScope(kind) || shownCounts[kind] === 0) return null;
          const entries = shown(kind).slice(0, cap);
          // On All every section is a preview, so the way to the rest is that
          // kind's own view rather than another page - which is also why the
          // loader below is only on a single-corpus view. Paging in six places
          // at once would fetch five screens nobody is looking at.
          const previewed = filter === 'all' && (shownCounts[kind] > PREVIEW || hasMore(kind));
          return (
            <section className={styles.section} key={kind}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>
                  {KIND_LABELS[kind]}
                  <span className={styles.sectionCount}>
                    {countLabel(shownCounts[kind], hasMore(kind))}
                  </span>
                </h2>
                {previewed && (
                  <button
                    type="button"
                    className={styles.seeAll}
                    onClick={() => navigate(searchPathFor(raw, kind))}
                  >
                    See all {countLabel(shownCounts[kind], hasMore(kind))}
                  </button>
                )}
              </div>
              <EntryList
                entries={entries}
                layout={layout}
                actions={actions}
                onOpenSite={onOpenSite}
              />
            </section>
          );
        })}
        {/* One loader for the view, not one per section. On a single-corpus
            view there is only one section anyway; on All every section is a
            preview and the way to the rest is that kind's own view. */}
        {filter !== 'all' && hasMore(filter as SearchKind) && (
          <>
            <div ref={sentinelRef} aria-hidden />
            <button
              type="button"
              className={styles.moreBtn}
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </>
        )}

        {shownTotal === 0 && !loading && (
          <p className={styles.note}>
            {error
              ? 'Something went wrong searching. Try that again in a moment.'
              : foundTotal > 0
                ? <>Nothing matched <strong>{raw}</strong> with those filters on.</>
                : <>Nothing here matched <strong>{raw}</strong>.</>}
          </p>
        )}
      </>
    );
  };

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          {raw ? <>Results for <span className={styles.query}>{raw}</span></> : 'Search'}
        </h1>
      </header>

      {raw && !short && (
        <FeedFilterBar
          // The bar's own surface and stickiness, not a copy of them: it is
          // wanted at exactly the moment it would scroll away, which is some way
          // down a long list of results.
          sticky
          groups={groups}
          actions={onLayoutChange && shownTotal > 0
            ? (
              <LayoutSwitch
                value={layout}
                options={LAYOUT_OPTIONS}
                onChange={onLayoutChange}
                label="Result layout"
              />
            )
            : undefined}
        />
      )}

      {loading && <p className={styles.note}>Searching…</p>}
      {body()}
    </div>
  );
}

/** What the action strip needs, gathered once rather than threaded per card. */
interface Actions {
  isSaved: (url: string) => boolean;
  commentCounts: Record<string, number>;
  saveCounts: Record<string, number>;
  destinations: ReturnType<typeof destinationsFor>;
  onSave: (a: SaveFields, dest?: { folderId: string | null }) => void;
  onUnsave?: (url: string) => void;
  onCreateFolder?: (name: string) => Promise<string>;
  onOpenArticle: (url: string) => void;
  onExplore?: (url: string, title: string) => void;
}

interface ListProps {
  entries: Entry[];
  layout: SearchLayout;
  actions: Actions | null;
  onOpenSite?: (domain: string) => void;
}

// The three shapes, and the same three the feed has: a table, a column of text
// cards, or an editorial grid where the lead result gets the width. They differ
// in what they draw around a headline, not in what they know — which is why one
// card component serves all three, exactly as ArticleCard does.
function EntryList({ entries, layout, actions, onOpenSite }: ListProps) {
  const variants = useMemo(
    () => (layout === 'magazine' ? magazineVariants(entries) : null),
    [layout, entries],
  );

  const cls = layout === 'list' ? styles.gridList
    : layout === 'magazine' ? styles.gridMagazine
    : styles.grid;

  return (
    <div className={cls}>
      {entries.map((e, i) => (
        <ResultCard
          key={e.key}
          entry={e}
          layout={layout}
          variant={variants?.[i]}
          actions={actions}
          onOpenSite={onOpenSite}
        />
      ))}
    </div>
  );
}

/**
 * The headline, as whatever kind of control it needs to be.
 *
 * An anchor wherever there is an address, so middle-click and "copy link
 * address" both work and a screen reader is told what it is; the click handler
 * is what keeps an ordinary click inside Newt. A note has neither an address
 * nor a target outside the console, so it is the one case that renders as a
 * button — `href="#"` for uniformity would put a link in the page that goes
 * nowhere.
 */
function Headline({ entry, className, children, ...rest }: {
  entry: Entry;
  className: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  if (!entry.href) {
    return (
      <button type="button" className={className} onClick={() => entry.open?.()} {...rest}>
        {children}
      </button>
    );
  }
  return (
    <a
      className={className}
      href={entry.href}
      {...(entry.open
        ? { onClick: (e: React.MouseEvent) => { e.preventDefault(); entry.open!(); } }
        : {})}
      {...rest}
    >
      {children}
    </a>
  );
}

function ResultCard({ entry, layout, variant, actions, onOpenSite }: {
  entry: Entry;
  layout: SearchLayout;
  variant?: MagVariant;
  actions: Actions | null;
  onOpenSite?: (domain: string) => void;
}) {
  // Artwork wherever there is artwork, in either card layout - the same rule
  // the feed's cards now follow. Only the magazine text variant opts out, and
  // that variant exists precisely for the results with no picture.
  const showImage = layout !== 'list' && !!entry.imageUrl && variant !== 'text';
  const wrapCls = [
    styles.cardWrap,
    variant === 'feature' ? styles.featureWrap : '',
    variant === 'text' ? styles.textWrap : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={wrapCls}>
      <div className={styles.card}>
        {showImage && (
          // Out of the tab order on purpose: it leads exactly where the
          // headline below does, and a second link with no text of its own is
          // noise to anyone not using a mouse.
          <Headline entry={entry} className={styles.heroLink} tabIndex={-1} aria-hidden="true">
            <img
              className={styles.hero}
              src={entry.imageUrl!}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              // A dead image URL is ordinary in a years-deep archive. Hiding the
              // frame leaves a text card, a shape this grid already has.
              onError={ev => {
                const img = ev.currentTarget;
                (img.parentElement ?? img).style.display = 'none';
              }}
            />
          </Headline>
        )}

        <Headline entry={entry} className={styles.title}>{entry.title}</Headline>

        {entry.snippet && <p className={styles.snippet}>{entry.snippet}</p>}

        <div className={styles.cardBottom}>
          <div className={styles.meta}>
            {entry.favicon && <img src={entry.favicon} alt="" className={styles.favicon} />}
            {entry.byline && (
              entry.byline.domain
                // A real link rather than a button, so it behaves like every
                // other journey to a site page: middle-click opens it in a tab,
                // and the address is the one that would be copied.
                ? (
                  <a
                    className={styles.domain}
                    href={`/s/${entry.byline.domain}`}
                    onClick={onOpenSite
                      ? e => { e.preventDefault(); onOpenSite(entry.byline!.domain!); }
                      : undefined}
                    title={`Everything from ${entry.byline.domain}`}
                  >
                    {entry.byline.label}
                  </a>
                )
                : <span className={styles.handle}>{entry.byline.label}</span>
            )}
            {entry.meta.map(m => <span key={m} className={styles.date}>{m}</span>)}
          </div>
          <div className={styles.cardRight}>
            {entry.badge && <span className={styles.badge}>{entry.badge}</span>}
            {entry.date && <span className={styles.date}>{entry.date}</span>}
          </div>
        </div>

        {actions && entry.article && <ResultActions article={entry.article} actions={actions} />}
      </div>
    </div>
  );
}

/**
 * Save and Discuss — the same two controls the feed's cards carry, in the same
 * order and the same dress.
 *
 * Not a lighter version of them, deliberately. A result is the same article the
 * river dealt; if keeping it or reading what people made of it took a different
 * gesture here, the search page would be somewhere you go to find things and
 * then leave in order to act on them.
 */
function ResultActions({ article, actions }: { article: SaveFields; actions: Actions }) {
  return (
    <div className={styles.actionRow}>
      <CommentBar
        count={actions.commentCounts[article.url] ?? 0}
        onClick={() => actions.onOpenArticle(article.url)}
        onExplore={actions.onExplore && (() => actions.onExplore!(article.url, article.title))}
        onRepost={() => startRepost({
          title: article.title,
          embed: articleEmbed({
            url: article.url,
            title: article.title,
            source: article.source,
            imageUrl: article.imageUrl ?? undefined,
            readTime: article.readTime != null ? `${article.readTime} min read` : null,
          }),
        })}
        shareUrl={article.url}
      />
      <SaveButton
        label="Save"
        icon={<BookmarkIcon />}
        savedIcon={<BookmarkFilledIcon />}
        saved={actions.isSaved(article.url)}
        onUnsave={actions.onUnsave && (() => actions.onUnsave!(article.url))}
        menuLabel="Save to…"
        defaultId={READING_LIST_DEST}
        destinations={actions.destinations}
        onSelect={id => actions.onSave(
          article,
          id === READING_LIST_DEST ? undefined : { folderId: id || null },
        )}
        onCreateDestination={actions.onCreateFolder && (async name => {
          const folderId = await actions.onCreateFolder!(name);
          actions.onSave(article, { folderId });
        })}
      />
    </div>
  );
}
