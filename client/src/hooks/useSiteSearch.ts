import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';
import { SearchFilter, isServerKind } from '../utils/searchUrl';

/** An author, the shape every surface that shows one already expects. */
export interface SearchAuthor {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  avatar: string;
}

export interface ArticleResult {
  id: string;
  title: string;
  url: string;
  source: string;
  categories: string[];
  pubDate: string | null;
  /** For the card layouts. Null is ordinary — plenty of feeds carry no art. */
  snippet: string | null;
  imageUrl: string | null;
}

export interface PostResult {
  kind: 'post';
  id: string;
  title: string;
  href: string;
  snippet: string;
  tags: string[];
  visibility: string;
  author: SearchAuthor | null;
  own: boolean;
  at: string | null;
  /** The post's cover, as a site-relative path. "" means none. */
  imageUrl: string;
}

export interface ExploreResult {
  kind: 'explore';
  id: string;
  title: string;
  href: string;
  snippet: string;
  sourceTitle: string;
  visibility: string;
  author: SearchAuthor | null;
  origin: 'user' | 'auto';
  own: boolean;
  turns: number;
  at: string | null;
}

export interface SiteSearchResults {
  articles: ArticleResult[];
  posts: PostResult[];
  explores: ExploreResult[];
}

/** Whether each corpus has another page behind it. */
export type SiteSearchMore = Record<keyof SiteSearchResults, boolean>;

const EMPTY: SiteSearchResults = { articles: [], posts: [], explores: [] };
const NO_MORE: SiteSearchMore = { articles: false, posts: false, explores: false };

/**
 * A page of results.
 *
 * Twenty is the server's own default, restated here because the client is what
 * decides when to ask for the next one and the two numbers have to agree for
 * `offset` to land on a page boundary.
 */
const PAGE = 20;

/** Matches the server's floor — below it there is nothing worth asking about. */
const MIN_LEN = 2;

/**
 * The three corpora the server owns, for one query.
 *
 * Unlike useFeedSearch this does not debounce, and the difference is the whole
 * point of the two hooks being separate: that one runs on every keystroke in a
 * dropdown, this one runs when a reader has finished typing and pressed Enter.
 * Debouncing a submitted query only delays the answer.
 *
 * It still aborts. Not for out-of-order keystrokes — for the reader who lands on
 * results, immediately narrows to Posts, and would otherwise have the wider
 * response arrive afterwards and overwrite what they asked for.
 */
export function useSiteSearch(query: string, filter: SearchFilter, tagged = false): {
  results: SiteSearchResults;
  more: SiteSearchMore;
  loading: boolean;
  /** A later page is on its way. Distinct from `loading`, which blanks the page. */
  loadingMore: boolean;
  error: boolean;
  /** Fetch the next page and append it. Ignored while one is already in flight. */
  loadMore: () => void;
} {
  const [results, setResults] = useState<SiteSearchResults>(EMPTY);
  const [more, setMore] = useState<SiteSearchMore>(NO_MORE);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  // How many rows have been asked for so far. Not derived from what came back:
  // the three corpora run out at different depths, so after two pages one of
  // them may hold 40 rows and another 23, and the next page still starts at 40.
  const [offset, setOffset] = useState(0);
  const abort = useRef<AbortController | null>(null);

  // Which corpora this tab needs. A tab the shell answers locally — Bookmarks,
  // Notes, Saved — asks the server for nothing at all, which is why it is a
  // parameter here rather than something the page filters after the fact.
  const kinds = filter === 'all' ? '' : isServerKind(filter) ? filter : 'none';

  /**
   * One page.
   *
   * `at === 0` is a new search and replaces what is on screen; anything else is
   * a later page and appends to it. That is the only difference between the two
   * paths, which is why they are one function: a "load more" that took its own
   * route to the server would be a second answer to what a result looks like.
   */
  const fetchPage = useCallback((term: string, at: number) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    if (at === 0) { setLoading(true); setResults(EMPTY); setMore(NO_MORE); }
    else setLoadingMore(true);
    setError(false);

    const params = new URLSearchParams({ q: term, limit: String(PAGE) });
    if (kinds) params.set('kinds', kinds);
    // The box's #tag prefix. Sent as a mode rather than left on the front of
    // the term, because a '#' means "match a label" to us and nothing at all to
    // a tsquery, which would simply drop it and run a text search instead.
    if (tagged) params.set('mode', 'tag');
    if (at > 0) params.set('offset', String(at));

    apiFetch(`/api/v1/search?${params}`, { signal: controller.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: SiteSearchResults & { more?: SiteSearchMore }) => {
        if (controller.signal.aborted) return;
        const page: SiteSearchResults = {
          articles: data.articles ?? [],
          posts: data.posts ?? [],
          explores: data.explores ?? [],
        };
        setResults(prev => (at === 0 ? page : {
          articles: [...prev.articles, ...page.articles],
          posts: [...prev.posts, ...page.posts],
          explores: [...prev.explores, ...page.explores],
        }));
        setMore(data.more ?? NO_MORE);
        setOffset(at);
        setLoading(false);
        setLoadingMore(false);
      })
      .catch(() => {
        // An abort means the query moved on — not a failure, and specifically
        // not a reason to show an error over results the reader can see.
        if (controller.signal.aborted) return;
        setError(true);
        setLoading(false);
        setLoadingMore(false);
      });
  }, [kinds, tagged]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < MIN_LEN || kinds === 'none') {
      abort.current?.abort();
      setResults(EMPTY);
      setMore(NO_MORE);
      setOffset(0);
      setLoading(false);
      setLoadingMore(false);
      setError(false);
      return;
    }
    fetchPage(term, 0);
    return () => abort.current?.abort();
  }, [query, kinds, tagged, fetchPage]);

  const loadMore = useCallback(() => {
    const term = query.trim();
    if (loading || loadingMore || term.length < MIN_LEN) return;
    // `kinds` is already narrowed to whichever corpus the reader is looking at
    // (the All view offers no next page - every section there is a preview), so
    // this asks for one more page of that one thing rather than of everything.
    fetchPage(term, offset + PAGE);
  }, [query, loading, loadingMore, offset, fetchPage]);

  // Tear down on unmount only; the effect above owns the in-flight request
  // while the component is alive.
  useEffect(() => () => abort.current?.abort(), []);

  return { results, more, loading, loadingMore, error, loadMore };
}
