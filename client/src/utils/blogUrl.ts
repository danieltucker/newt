// Client-side routing helpers for blog posts, which live at
// /u/<username>/<slug> - a sub-path of the profile route, so parseProfilePath
// deliberately matches only a single segment and leaves these to us.
//
// Usernames aren't charset-restricted server-side, so that segment is
// URL-encoded; the slug is generated ASCII and needs no encoding.

const PREFIX = '/u/';

export interface BlogRef {
  username: string;
  slug: string;
}

export function blogPathFor(username: string, slug: string): string {
  return `${PREFIX}${encodeURIComponent(username)}/${slug}`;
}

// The username + slug in a path like /u/<username>/<slug>, or null when the path
// isn't a post (a bare profile, or anything else).
export function parseBlogPath(pathname: string): BlogRef | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const rest = pathname.slice(PREFIX.length).replace(/\/+$/, '');
  const parts = rest.split('/');
  if (parts.length !== 2) return null;          // one segment is a profile, three+ is nothing
  const [rawUser, slug] = parts;
  if (!rawUser || !slug) return null;
  let username: string;
  try {
    username = decodeURIComponent(rawUser);
  } catch {
    username = rawUser;
  }
  return { username, slug };
}

// The author's username when `raw` is a post hosted by *this* deployment, else
// null. Feed items get labelled with their source, and for one of our own posts
// a hostname is the least useful thing we could show - every author on the
// instance shares it - so callers swap in "@username" when this returns one.
//
// The origin check is what makes that safe: a feed can carry any link at all,
// and a lookalike /u/<name>/<slug> path on somebody else's host must never be
// presented as one of our authors. A deployment whose browser origin differs
// from the one post URLs were built with simply falls back to the hostname.
export function blogAuthorOfUrl(raw: string): string | null {
  return blogRefOfUrl(raw)?.username ?? null;
}

// The same check, keeping the slug as well: what a caller needs to *route* to a
// post rather than merely credit it. blogAuthorOfUrl is written in terms of this
// so the origin check above — the part that matters — exists once.
export function blogRefOfUrl(raw: string): BlogRef | null {
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  return parseBlogPath(url.pathname);
}

// The author's own editor route for a post. Kept here so every blog URL the
// client builds lives in one place.
export function blogEditPathFor(id: string): string {
  return `/blog/${encodeURIComponent(id)}`;
}

// The id in /blog/<id>, or null. '/blog' itself (the manage list) and
// '/blog/new' are handled by the caller before this is consulted.
export function parseBlogEditPath(pathname: string): string | null {
  if (!pathname.startsWith('/blog/')) return null;
  const raw = pathname.slice('/blog/'.length).replace(/\/+$/, '');
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
