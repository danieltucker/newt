// Client-side routing helpers for blog posts, which live at
// /u/<username>/<slug> — a sub-path of the profile route, so parseProfilePath
// deliberately matches only a single segment and leaves these to us.
//
// The slug already carries the date ("hello-world-2026-07-24"), so a post URL is
// readable and shareable on its own. Usernames aren't charset-restricted
// server-side, so that segment is URL-encoded; the slug is generated ASCII and
// needs no encoding.

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
