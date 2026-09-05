// Deep-link helper for the article reader. The browser path becomes the Newt
// page for an article while a reader is open, so the view is shareable and the
// back button closes it.
//
// There are two forms, and only one of them is minted:
//
//   /s/<host>/<path>      the readable form, and what Share now produces
//   /a/<base64url>        the original, still parsed, never written
//
// The old form put the whole article URL through base64, which needed no
// server-side mapping - and produced 220-character links whose only readable
// part was the domain of *this* site. The readable form needs no mapping either:
// the host and path are the URL, so `https://` + the two segments recovers it.
//
// The `/a/` form is kept because those links are already in the world - pasted
// into chats, and stored verbatim as the href of every note embed written before
// this change (see noteEmbed). Parsing must keep accepting them forever;
// minting them is now only a fallback, for the URLs the readable form cannot
// represent losslessly.

const PREFIX = '/s/';
const LEGACY_PREFIX = '/a/';

// The same shape siteUrl.ts requires of a /s/<domain> page, and for the same
// reason: the first segment of a readable path has to be recognisable as a host
// on sight, or the route cannot tell an article from anything else. An IP
// literal, a host with a port, or anything else that fails this simply takes the
// legacy form instead - it is a longer link, not a broken one.
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

// Dropped before the path is built. These are the params that make a shared link
// enormous while meaning nothing to the page it points at - the whole tail of a
// syndication URL is usually this and nothing else. Mirrors the list in
// articleKey.ts, which already treats them as noise for the purpose of deciding
// whether two links are the same article.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_(cid|eid)$|ref$|ref_src$|igshid$|cmpid$|smid$)/i;

export function encodeArticleId(url: string): string {
  // btoa needs Latin-1; encode UTF-8 first so non-ASCII URLs survive the round trip
  const utf8 = encodeURIComponent(url).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeArticleId(id: string): string | null {
  try {
    const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const utf8 = bin.replace(/./g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    const url = decodeURIComponent(utf8);
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * The readable path for an article URL, or null if this URL is not one of the
 * ones it can carry.
 *
 * The conditions are all about being able to read the path back as the same
 * article, because a link that has to be interpreted is worse than a long one:
 *
 *  - **https only.** The scheme is not in the path, so parsing has to assume
 *    one. Assuming https for a URL that was already https assumes nothing; doing
 *    it for an http-only publisher would hand the reader an address that does
 *    not answer.
 *  - **No query.** Not because a query cannot be encoded, but because the reader
 *    already owns the query string of its own page - `?c=<id>` aims a link at
 *    one comment - and an article whose URL carries its own `c` would collide
 *    with it. Tracking params are stripped first, so the common case of a URL
 *    that is *only* utm noise still gets the short form.
 *  - **No fragment**, which never reaches a server and is not part of the
 *    article's identity anyway.
 *  - **A plain hostname and a real path.** `/s/<host>` on its own is already the
 *    publisher's page (siteUrl.ts), so an article needs at least one segment
 *    below it to be told apart from one.
 *
 * The host keeps its `www.` where it has one, which is the one place this
 * deliberately does *not* follow canonicalArticleKey. The key strips `www.`
 * because it only has to decide whether two links are the same article, and both
 * spellings resolve to the same key either way. This path has to be *fetched*,
 * and there are still publishers whose apex serves no certificate - so four
 * characters buy an exact host rather than a guess about the redirect.
 */
function readablePathFor(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hash || u.port || u.username) return null;

  const kept = [...u.searchParams.keys()].filter(k => !TRACKING_PARAMS.test(k));
  if (kept.length) return null;

  const host = u.hostname.toLowerCase();
  if (!HOSTNAME.test(host)) return null;

  // u.pathname is already percent-encoded by URL, which is what the path needs
  // to be - re-encoding it here would double up on every non-ASCII slug.
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) return null;

  return `${PREFIX}${host}${path}`;
}

export function articlePathFor(url: string): string {
  return readablePathFor(url) ?? LEGACY_PREFIX + encodeArticleId(url);
}

// The same link, aimed at one comment in the thread rather than the top of it.
// The comment id rides in the query string, not the path, so parseArticlePath
// keeps matching on the pathname alone and every existing link is unchanged - a
// missing or stale ?c= just opens the thread normally.
export function threadPathFor(url: string, commentId?: string | null): string {
  const path = articlePathFor(url);
  return commentId ? `${path}?c=${encodeURIComponent(commentId)}` : path;
}

/**
 * The article URL a Newt path names, or null if the path doesn't name one.
 *
 * Both forms, since the legacy one is still out there. The readable branch has
 * to re-validate through `URL` rather than trusting the two halves it was
 * handed: the pathname comes off the address bar, so anything at all can be in
 * it, and this value goes on to be fetched.
 */
export function parseArticlePath(pathname: string): string | null {
  if (pathname.startsWith(LEGACY_PREFIX)) {
    const id = pathname.slice(LEGACY_PREFIX.length).replace(/\/+$/, '');
    return id ? decodeArticleId(id) : null;
  }
  if (!pathname.startsWith(PREFIX)) return null;

  const rest = pathname.slice(PREFIX.length).replace(/\/+$/, '');
  const cut = rest.indexOf('/');
  // One segment is the publisher's page, not an article on it.
  if (cut <= 0) return null;

  const host = decodeURIComponent(rest.slice(0, cut)).toLowerCase();
  if (!HOSTNAME.test(host)) return null;

  try {
    const u = new URL(`https://${host}${rest.slice(cut)}`);
    return u.hostname === host ? u.toString() : null;
  } catch {
    return null;
  }
}
