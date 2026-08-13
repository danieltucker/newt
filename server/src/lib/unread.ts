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

/**
 * The same count, for many feeds at once.
 *
 * One grouped query rather than one COUNT per feed. syncBookmarkBadges below
 * used to loop, and it is called on every read flush, dismiss and restore - so
 * a reader with forty feed-bearing bookmarks spent forty sequential round trips
 * on a badge refresh, every time they scrolled past a few articles.
 *
 * A feed with nothing unread produces no row (that is what GROUP BY does), so
 * callers must read a missing entry as zero rather than as "unknown".
 */
export async function feedUnreadCounts(
  userId: string,
  feedIds: string[],
): Promise<Map<string, number>> {
  if (feedIds.length === 0) return new Map();
  const rows = await prisma.feedItem.groupBy({
    by: ['feedId'],
    where: {
      feedId: { in: feedIds },
      reads: { none: { userId } },
      dismissals: { none: { userId } },
    },
    _count: { _all: true },
  });
  return new Map(rows.map(r => [r.feedId, Math.min(r._count._all, UNREAD_CAP)]));
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

  // Which bookmarks this call is actually about, paired with the shared Feed
  // row behind each. Worked out before any counting, so the counts can be asked
  // for in one go rather than one per bookmark.
  const targets: { id: string; feedId: string; unreadCount: number }[] = [];
  for (const b of bookmarks) {
    const fid = feedIdByKey.get(canonicalFeedKey(b.feedUrl!));
    if (fid && feedIdSet.has(fid)) targets.push({ id: b.id, feedId: fid, unreadCount: b.unreadCount });
  }
  if (targets.length === 0) return [];

  const counts = await feedUnreadCounts(userId, [...new Set(targets.map(t => t.feedId))]);

  const changed: { id: string; unreadCount: number }[] = [];
  // Grouped by the value being written, so a flush that clears twenty badges to
  // zero is one statement rather than twenty. Two bookmarks can point at the
  // same feed, so this is keyed on the count, not on the feed.
  const byCount = new Map<number, string[]>();
  for (const t of targets) {
    const next = counts.get(t.feedId) ?? 0;   // no row means nothing unread
    if (next === t.unreadCount) continue;
    changed.push({ id: t.id, unreadCount: next });
    const ids = byCount.get(next);
    if (ids) ids.push(t.id); else byCount.set(next, [t.id]);
  }

  await Promise.all([...byCount].map(([unreadCount, ids]) =>
    prisma.bookmark.updateMany({ where: { id: { in: ids } }, data: { unreadCount } })));

  return changed;
}
