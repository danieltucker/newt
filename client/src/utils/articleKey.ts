/**
 * Normalises an article URL so the same piece, arriving from a feed card, a
 * saved reading list row or a shared link, resolves to one key.
 *
 * Mirrors `canonicalArticleKey` in server/src/lib/comments.ts, and for the same
 * reason canonicalFeedUrl mirrors its half (see utils/feedKey): the two halves
 * of this app don't share a module graph. Keep them in step - the client uses
 * this only to line its own lists up with each other, so a drift shows as a
 * Save button that won't fill in rather than as bad data.
 */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_(cid|eid)$|ref$|ref_src$|igshid$|cmpid$|smid$)/i;

export function canonicalArticleKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const search = params.length
      ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}`
      : '';
    return `${host}${path}${search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}
