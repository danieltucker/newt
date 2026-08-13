import prisma from './prisma';
import { canonicalFeedKey } from './feedUtils';

// A ceiling on how much outbound polling one account can create. Per user now
// rather than per folder — the feed is one river, so the folder it was filed
// under was never the thing worth bounding.
export const MAX_FEEDS_PER_USER = 200;
export const MAX_FEED_FOLDERS = 50;
export const MAX_FEED_URL = 2048;
export const MAX_FEED_NAME = 100;

export type FeedSubscriptionRow = {
  id: string;
  url: string;
  name: string;
  position: number;
  feedFolderId: string | null;
};

export const SUBSCRIPTION_SELECT = {
  id: true, url: true, name: true, position: true, feedFolderId: true,
} as const;

export const FEED_FOLDER_SELECT = {
  id: true, name: true, color: true, position: true,
} as const;

/**
 * Subscribes a user to a feed unless they already have it or are at their cap.
 * Returns whether a row was created.
 *
 * Deduping is canonical, not literal: the unique index is on the exact URL (so
 * a subscription can be re-pointed at a moved address), which would happily let
 * http://x.com/feed and https://www.x.com/feed/ both in — two rows dealing the
 * same articles into the river twice. Callers here are subscribing on the
 * user's behalf, so the check belongs in one place.
 */
export async function addFeedSubscription(
  userId: string,
  url: string,
  name = '',
  feedFolderId: string | null = null,
): Promise<boolean> {
  const existing = await prisma.feedSubscription.findMany({
    where: { userId },
    select: { url: true },
  });
  if (existing.length >= MAX_FEEDS_PER_USER) return false;

  const key = canonicalFeedKey(url);
  if (existing.some(f => canonicalFeedKey(f.url) === key)) return false;

  try {
    await prisma.feedSubscription.create({
      data: {
        userId,
        url,
        name: name.slice(0, MAX_FEED_NAME),
        position: existing.length,
        feedFolderId,
      },
    });
    return true;
  } catch (err) {
    // P2002 — they already had this exact URL. Callers subscribe on the user's
    // behalf and only care that the feed ends up there, so an existing row is
    // success, not an error worth propagating.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') return false;
    throw err;
  }
}
