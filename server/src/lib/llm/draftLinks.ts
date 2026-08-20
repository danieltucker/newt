import { canonicalArticleKey, isHttpUrl } from '../comments';

/**
 * The links an unfinished post is already pointing at.
 *
 * A draft's links are the closest thing there is to a statement of what the
 * author has been reading about it, which is why the planning pass reads them:
 * "what could I say about this" is a much better question when the material the
 * author already gathered is in front of the model.
 *
 * Two places a link hides in a post body, and both count:
 *
 *  - an ordinary `<a href>`, which is what the link dialog writes;
 *  - `data-url` on a reference card, which is where /reference puts the source
 *    it points at. The card's `href` is often Newt's own page for the article
 *    (`/a/<id>`), so reading only hrefs would have found the reader rather than
 *    the piece.
 *
 * Deliberately a regex over the stored HTML rather than a parse. The body has
 * already been through the server's sanitizer by the time anything here runs,
 * so what is left is a known, small subset of markup; standing a DOM
 * implementation up on the server to re-read it would be a dependency bought
 * for one attribute. Over-matching is harmless — everything found is filtered
 * to absolute http(s) below, and every one of those goes through the SSRF gate
 * before it is fetched.
 */

const ATTR = /(?:href|data-url)\s*=\s*"([^"]*)"|(?:href|data-url)\s*=\s*'([^']*)'/gi;

/**
 * Attribute values are stored escaped, and the query separator is the one that
 * matters: a two-parameter link comes back as `?a=1&amp;b=2`, which would be
 * fetched with a parameter literally called "amp;b". Only the handful of
 * entities a sanitizer actually writes are decoded — this is undoing our own
 * escaping, not implementing HTML.
 */
function unescapeAttr(value: string): string {
  return value
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Last: an escaped ampersand is what every other entity here starts with.
    .replace(/&(?:amp|#38);/g, '&');
}

/**
 * Absolute http(s) links in `html`, deduplicated, first occurrence first.
 *
 * Deduplication is on the canonical article key rather than the raw string, for
 * the same reason the river dedupes on it: a reference card and a hand-written
 * link to the same piece routinely differ by a `?utm_source=`, and reading that
 * page twice would cost twice and say the same thing.
 *
 * Order is the draft's own, so a cap applied by the caller keeps the links the
 * author put in first — which in a draft is where the piece is anchored.
 */
export function draftLinks(html: string, limit: number): string[] {
  if (!html) return [];

  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of html.matchAll(ATTR)) {
    const raw = unescapeAttr((match[1] ?? match[2] ?? '').trim());
    if (!raw || !isHttpUrl(raw)) continue;
    const key = canonicalArticleKey(raw) || raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(raw);
    if (urls.length >= limit) break;
  }

  return urls;
}
