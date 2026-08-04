import prisma from './prisma';
import { canonicalFeedKey } from './feedUtils';

// A site tile's unread badge = how many items in that site's feed the user has
// neither read nor dismissed. It reads from the very same ReadFeedItem /
// DismissedFeedItem state the RSS reader writes, so the badge and the feed's
// "new" outlines are always the same set: marking read in one place shows up in
// the other, and a background feed check can no longer resurrect a count the
// user already cleared. Capped at 100 (the tile renders ∞ past 99).
export const UNREAD_CAP = 100;

export async function feedUnreadCount(userId: string, feedId: string): Promise<number> {
  const n = await prisma.feedItem.count({
    where: {
      feedId,
      reads: { none: { userId } },
      dismissals: { none: { userId } },
    },
  });
  return Math.min(n, UNREAD_CAP);
}

// Recomputes and persists the unread badge for every one of this user's
// bookmarks whose feed is in `feedIds`. Returns only the bookmarks whose count
// actually changed, so callers can hand the client a minimal badge update.
export async function syncBookmarkBadges(
  userId: string,
  feedIds: string[],
): Promise<{ id: string; unreadCount: number }[]> {
  if (feedIds.length === 0) return [];
  const feedIdSet = new Set(feedIds);

  const bookmarks = await prisma.bookmark.findMany({
    where: { userId, NOT: { feedUrl: null } },
    select: { id: true, feedUrl: true, unreadCount: true },
  });
  if (bookmarks.length === 0) return [];

  // Map each bookmark's feed URL onto its shared Feed row via the canonical key
  const keys = [...new Set(bookmarks.map(b => canonicalFeedKey(b.feedUrl!)))];
  const feeds = await prisma.feed.findMany({
    where: { canonicalKey: { in: keys } },
    select: { id: true, canonicalKey: true },
  });
  const feedIdByKey = new Map(feeds.map(f => [f.canonicalKey, f.id]));

  const changed: { id: string; unreadCount: number }[] = [];
  for (const b of bookmarks) {
    const fid = feedIdByKey.get(canonicalFeedKey(b.feedUrl!));
    if (!fid || !feedIdSet.has(fid)) continue;
    const next = await feedUnreadCount(userId, fid);
    if (next !== b.unreadCount) {
      await prisma.bookmark.update({ where: { id: b.id }, data: { unreadCount: next } });
      changed.push({ id: b.id, unreadCount: next });
    }
  }
  return changed;
}
