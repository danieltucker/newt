// Client-side routing for the two hub pages: a tag, and the global recent list.
//
// Both are public and both are server-rendered for crawlers (see
// server/src/routes/html.ts), so the paths here have to match what that file
// emits exactly - a link in the crawlable copy that the app cannot route would
// send a visitor arriving from a search result to the landing page.

const TAG_PREFIX = '/t/';

export const RECENT_PATH = '/recent';

export function tagPathFor(tag: string): string {
  return `${TAG_PREFIX}${encodeURIComponent(tag)}`;
}

/**
 * The tag in /t/<tag>, or null.
 *
 * Single segment only, so /t/<tag>/feed.xml is left alone - that address is the
 * server's RSS, not a page, and the SPA must never claim it.
 */
export function parseTagPath(pathname: string): string | null {
  if (!pathname.startsWith(TAG_PREFIX)) return null;
  const raw = pathname.slice(TAG_PREFIX.length).replace(/\/+$/, '');
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function isRecentPath(pathname: string): boolean {
  return pathname === RECENT_PATH || pathname === `${RECENT_PATH}/`;
}
