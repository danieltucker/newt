// Deep-link helper for the article reader. The browser path becomes /a/<id>
// while a reader is open, so the view is shareable and the back button closes it.
// <id> is the article's URL, base64url-encoded - no server-side mapping needed;
// decoding it recovers the exact URL the reader and comments are keyed on.

const PREFIX = '/a/';

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

export function articlePathFor(url: string): string {
  return PREFIX + encodeArticleId(url);
}

// The same link, aimed at one comment in the thread rather than the top of it.
// The comment id rides in the query string, not the path, so parseArticlePath
// keeps matching on the pathname alone and every existing /a/<id> link is
// unchanged - a missing or stale ?c= just opens the thread normally.
export function threadPathFor(url: string, commentId?: string | null): string {
  const path = articlePathFor(url);
  return commentId ? `${path}?c=${encodeURIComponent(commentId)}` : path;
}

// The article URL encoded in a path like /a/<id>, or null if the path isn't one.
export function parseArticlePath(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const id = pathname.slice(PREFIX.length).replace(/\/+$/, '');
  if (!id) return null;
  return decodeArticleId(id);
}
