/**
 * Normalises a feed URL so permutations (http/https, www., trailing slash,
 * hash fragments) map to the same key.
 *
 * Mirrors `canonicalFeedKey` in server/src/lib/feedUtils.ts. Duplicated rather
 * than shared for the same reason the colour palette is (see utils/color): the
 * two halves of this app don't share a module graph. Keep them in step - the
 * client uses this only to line its own lists up with each other, so a drift
 * shows as a badge that won't clear rather than as bad data.
 */
export function canonicalFeedUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}
