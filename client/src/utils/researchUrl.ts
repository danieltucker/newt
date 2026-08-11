/**
 * /research and /research/<id>.
 *
 * The same shape as the other parse*Path helpers: pathname only, no query
 * string, so App can match on it whole.
 */

export function isResearchPath(path: string): boolean {
  return path === '/research' || path === '/research/' || path.startsWith('/research/');
}

/** The thread id in /research/<id>, or null for the bare /research index. */
export function parseResearchPath(path: string): string | null {
  const match = path.match(/^\/research\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function researchPathFor(threadId?: string): string {
  return threadId ? `/research/${encodeURIComponent(threadId)}` : '/research';
}

/**
 * The link an article's Research button points at.
 *
 * The article travels in the query string rather than in a POST, so the button
 * is an ordinary link: it can be opened in a new tab, copied, and comes back to
 * the same place on reload. ResearchPage consumes it once on mount.
 */
export function researchArticlePath(url: string, title?: string): string {
  const params = new URLSearchParams({ url });
  if (title) params.set('title', title);
  return `/research?${params.toString()}`;
}

/**
 * Carrying a question the reader has already typed into a new thread — what
 * "Continue in Research" does after a quick /ask.
 *
 * The question rides in the URL for the same reason the article does: it makes
 * the destination a real page rather than a state handoff that a reload would
 * lose. `url` is optional, since a question asked away from an article is still
 * a question worth keeping.
 */
export function researchAskPath(question: string, url?: string): string {
  const params = new URLSearchParams({ q: question });
  if (url) params.set('url', url);
  return `/research?${params.toString()}`;
}
