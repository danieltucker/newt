/**
 * /explore and /explore/<id>.
 *
 * The same shape as the other parse*Path helpers: pathname only, no query
 * string, so App can match on it whole.
 *
 * The feature was called Research until v1.17.0 and the internals still are —
 * the API routes, the tables and this file's name. Only what a reader sees
 * changed. `isLegacyResearchPath` is the one place the old name survives in
 * behaviour: links to /research were shared and bookmarked, so they redirect
 * rather than 404.
 */

export const EXPLORE_PATH = '/explore';

export function isExplorePath(path: string): boolean {
  return path === EXPLORE_PATH || path.startsWith(`${EXPLORE_PATH}/`);
}

/** The thread id in /explore/<id>, or null for the bare /explore index. */
export function parseExplorePath(path: string): string | null {
  const match = path.match(/^\/explore\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function explorePathFor(threadId?: string): string {
  return threadId ? `${EXPLORE_PATH}/${encodeURIComponent(threadId)}` : EXPLORE_PATH;
}

/**
 * The /research address this page used to live at.
 *
 * Recognised so those links keep working: a thread URL is the kind of thing
 * that gets pasted into a note or a message, and renaming the feature is not a
 * reason to break one. App redirects rather than rendering, so the old address
 * doesn't linger in the bar afterwards.
 */
export function isLegacyResearchPath(path: string): boolean {
  return path === '/research' || path.startsWith('/research/');
}

/** The /explore address a /research one should become, query string and all. */
export function explorePathFromLegacy(path: string, search = ''): string {
  return `${path.replace(/^\/research/, EXPLORE_PATH).replace(/\/$/, '') || EXPLORE_PATH}${search}`;
}

/**
 * The link an article's Explore button points at.
 *
 * The article travels in the query string rather than in a POST, so the button
 * is an ordinary link: it can be opened in a new tab, copied, and comes back to
 * the same place on reload. ExplorePage consumes it once on mount.
 */
export function exploreArticlePath(url: string, title?: string): string {
  const params = new URLSearchParams({ url });
  if (title) params.set('title', title);
  return `${EXPLORE_PATH}?${params.toString()}`;
}

/**
 * Carrying a question the reader has already typed into a new thread — what
 * the search bar's /ask does.
 *
 * The question rides in the URL for the same reason the article does: it makes
 * the destination a real page rather than a state handoff that a reload would
 * lose. `url` is optional, since a question asked away from an article is still
 * a question worth keeping.
 *
 * `refs` are the articles a /reference attached to the question before it was
 * sent - what the newt button's Ask field collects. They ride on the same `ref=`
 * as exploreReferencePath below, and mean the same thing; the difference is only
 * that here there is already a question to hang them on, so Explore sends rather
 * than waits.
 */
export function exploreAskPath(question: string, url?: string, refs: string[] = []): string {
  const params = new URLSearchParams({ q: question });
  if (url) params.set('url', url);
  for (const ref of refs) params.append('ref', ref);
  return `${EXPLORE_PATH}?${params.toString()}`;
}

/**
 * Arriving at Explore with an article already attached and nothing asked yet —
 * what the search bar's /reference does.
 *
 * Deliberately not `?url=`, which is the *thread's* source and starts a
 * conversation about that one article on its own. A reference is material for a
 * question the reader has not typed yet, and several of them can ride together:
 * "/reference" three times over is a way of saying "compare these", which is
 * exactly the question `?url=` cannot express.
 */
export function exploreReferencePath(urls: string | string[]): string {
  const params = new URLSearchParams();
  for (const url of Array.isArray(urls) ? urls : [urls]) params.append('ref', url);
  return `${EXPLORE_PATH}?${params.toString()}`;
}

/** The attached articles in an Explore link, in the order they were added. */
export function parseExploreRefs(search: string): string[] {
  return new URLSearchParams(search).getAll('ref').filter(Boolean);
}
