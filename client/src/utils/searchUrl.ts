/**
 * /search?q=<query>, and the tab within it.
 *
 * The same shape as the other parse*Path helpers: `isSearchPath` matches the
 * pathname whole, and everything that varies rides in the query string.
 *
 * The query is a query parameter rather than a path segment on purpose, unlike
 * /t/<tag>. A tag is a name — a stable thing with a page of its own that is
 * worth linking to. A search is a *question*, typed once and rarely the same
 * twice, and putting an arbitrary sentence of someone's punctuation into a path
 * buys nothing except the escaping problems that come with it.
 */

export const SEARCH_PATH = '/search';

/**
 * The corpora the page can narrow to. 'all' is not one of them — it is the
 * absence of a filter, which is why it has no entry here and no place in a URL.
 */
export const SEARCH_KINDS = ['articles', 'posts', 'explores', 'saved', 'bookmarks', 'notes'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export type SearchFilter = SearchKind | 'all';

/**
 * Which of these the server answers, and which the client already holds.
 *
 * Bookmarks, saved articles and notes are the reader's own and bounded, and the
 * shell has all three in memory — the search box's dropdown has always filtered
 * them locally. Sending them to the server would mean uploading a query to
 * search data that is already on this machine. The other three are too large or
 * too visibility-dependent to hold, so they are searched where they live.
 */
export const SERVER_KINDS = ['articles', 'posts', 'explores'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export function isServerKind(kind: SearchFilter): kind is ServerKind {
  return (SERVER_KINDS as readonly string[]).includes(kind);
}

export function isSearchPath(path: string): boolean {
  return path === SEARCH_PATH || path === `${SEARCH_PATH}/`;
}

/** The address for a query, and optionally for one tab of it. */
export function searchPathFor(query: string, filter: SearchFilter = 'all'): string {
  const params = new URLSearchParams({ q: query });
  // 'all' is the default, so it is left out rather than written down: a shared
  // link should carry what the reader chose, not what they didn't.
  if (filter !== 'all') params.set('kind', filter);
  return `${SEARCH_PATH}?${params}`;
}

/** The query in ?q=, trimmed. Empty for a bare /search, which is a real state. */
export function parseSearchQuery(search: string): string {
  return (new URLSearchParams(search).get('q') ?? '').trim();
}

/**
 * The tab in ?kind=, defaulting to 'all'.
 *
 * An unrecognised name falls back to 'all' rather than to an empty tab. A
 * hand-edited or stale address should show the reader their results, not a page
 * that looks like the search found nothing.
 */
export function parseSearchFilter(search: string): SearchFilter {
  const raw = new URLSearchParams(search).get('kind');
  return SEARCH_KINDS.includes(raw as SearchKind) ? (raw as SearchKind) : 'all';
}
