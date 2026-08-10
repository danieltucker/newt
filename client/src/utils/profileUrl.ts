// Client-side routing helper for public user profiles. The browser path is
// /u/<username>, so a profile is shareable and the back button leaves it.
// Usernames aren't charset-restricted server-side, so we URL-encode the segment.

const PREFIX = '/u/';

// The query string a profile link may carry. Both are deep links into what the
// page is already able to show, so an unrecognised value is never an error -
// ProfilePage validates the tab against its own list and treats an unknown tag
// as a filter that matches nothing.
export interface ProfileLinkOptions {
  /** ?tab= - which tab to land on. */
  tab?: string;
  /** ?tag= - narrows the Posts tab to one of the author's tags. */
  tag?: string;
}

export function profilePathFor(username: string, opts: ProfileLinkOptions = {}): string {
  const base = PREFIX + encodeURIComponent(username);
  const query = new URLSearchParams();
  if (opts.tab) query.set('tab', opts.tab);
  if (opts.tag) query.set('tag', opts.tag);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
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
