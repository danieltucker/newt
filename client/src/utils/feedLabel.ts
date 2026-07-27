export interface FeedNameSource {
  name: string;
  feedUrl: string;
}

// The hostname a feed URL lives on, minus the "www." - the last-resort label.
export function feedHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// What to call a feed, in order of how much it knows about the user's intent:
// the name they typed, then the bookmark the feed was discovered from, then the
// bare hostname. Feeds added by raw URL have only the last of these until
// they're named, which is why naming was worth storing.
export function feedLabel(
  feed: { name?: string; url: string },
  bookmarks: FeedNameSource[] = [],
): string {
  const own = feed.name?.trim();
  if (own) return own;
  const match = bookmarks.find(b => b.feedUrl === feed.url);
  if (match?.name.trim()) return match.name.trim();
  return feedHost(feed.url);
}
