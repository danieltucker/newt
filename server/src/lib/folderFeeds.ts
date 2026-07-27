import prisma from './prisma';

export const MAX_FEEDS_PER_FOLDER = 20;
export const MAX_FEED_URL = 2048;
export const MAX_FEED_NAME = 100;

export type FolderFeedRow = {
  id: string;
  url: string;
  name: string;
  position: number;
};

export const FEED_SELECT = { id: true, url: true, name: true, position: true } as const;

// Clients still receive `feedUrls` alongside the feed rows. It is derived, never
// stored: the RSS widget, the console and the article routes all only ever want
// the URLs, and keeping the shape means they didn't have to change when feeds
// grew identities.
export function withFeedUrls<T extends { feeds: FolderFeedRow[] }>(folder: T) {
  return { ...folder, feedUrls: folder.feeds.map(f => f.url) };
}

// The URLs a folder subscribes to, in display order.
export async function folderFeedUrls(folderId: string): Promise<string[]> {
  const rows = await prisma.folderFeed.findMany({
    where: { folderId },
    orderBy: { position: 'asc' },
    select: { url: true },
  });
  return rows.map(r => r.url);
}

// Adds a feed to a folder unless the folder already has that URL or is full.
// Returns whether a row was created. Used by bookmark feed auto-discovery and
// by following a blog, both of which subscribe on the user's behalf.
export async function addFolderFeed(
  userId: string,
  folderId: string,
  url: string,
  name = '',
): Promise<boolean> {
  const count = await prisma.folderFeed.count({ where: { folderId } });
  if (count >= MAX_FEEDS_PER_FOLDER) return false;
  try {
    await prisma.folderFeed.create({
      data: { userId, folderId, url, name: name.slice(0, MAX_FEED_NAME), position: count },
    });
    return true;
  } catch (err) {
    // P2002 — the folder already had this URL. Both callers subscribe on the
    // user's behalf and only care that the feed ends up there, so an existing
    // row is success, not an error worth propagating.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') return false;
    throw err;
  }
}
