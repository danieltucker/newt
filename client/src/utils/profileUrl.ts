// Client-side routing helper for public user profiles. The browser path is
// /u/<username>, so a profile is shareable and the back button leaves it.
// Usernames aren't charset-restricted server-side, so we URL-encode the segment.

const PREFIX = '/u/';

export function profilePathFor(username: string): string {
  return PREFIX + encodeURIComponent(username);
}

// The username in a path like /u/<username>, or null if the path isn't one.
//
// Deliberately matches a *single* segment: /u/<username>/<slug> is a blog post,
// which parseBlogPath owns. Without that restriction this would claim every post
// URL and render the author's profile instead of their post.
export function parseProfilePath(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const raw = pathname.slice(PREFIX.length).replace(/\/+$/, '');
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
