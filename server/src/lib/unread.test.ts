import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { syncBookmarkBadges, UNREAD_CAP } from './unread';

const ME = 'me-id';

beforeEach(resetPrismaMock);

/**
 * These pin the shape of the queries, not just the answer. The badge sync runs
 * on every read flush, dismiss and restore, and it used to issue one COUNT and
 * one UPDATE per bookmark in a sequential loop - which is invisible in a unit
 * test that only checks the numbers.
 */
describe('syncBookmarkBadges', () => {
  function setup(bookmarks: { id: string; feedUrl: string; unreadCount: number }[]) {
    prismaMock.bookmark.findMany.mockResolvedValue(bookmarks);
    prismaMock.feed.findMany.mockResolvedValue([
      { id: 'feed-a', canonicalKey: 'a.example/feed' },
      { id: 'feed-b', canonicalKey: 'b.example/feed' },
    ]);
    prismaMock.bookmark.updateMany.mockResolvedValue({ count: 1 });
  }

  it('counts every feed in one grouped query, not one per bookmark', async () => {
    setup([
      { id: 'bm-1', feedUrl: 'https://a.example/feed', unreadCount: 0 },
      { id: 'bm-2', feedUrl: 'https://b.example/feed', unreadCount: 0 },
    ]);
    prismaMock.feedItem.groupBy.mockResolvedValue([
      { feedId: 'feed-a', _count: { _all: 3 } },
      { feedId: 'feed-b', _count: { _all: 7 } },
    ]);

    const changed = await syncBookmarkBadges(ME, ['feed-a', 'feed-b']);

    expect(prismaMock.feedItem.groupBy).toHaveBeenCalledTimes(1);
    expect(prismaMock.feedItem.count).not.toHaveBeenCalled();
    expect(changed).toEqual([
      { id: 'bm-1', unreadCount: 3 },
      { id: 'bm-2', unreadCount: 7 },
    ]);
  });

  it('scopes the count to the caller, both for reads and dismissals', async () => {
    setup([{ id: 'bm-1', feedUrl: 'https://a.example/feed', unreadCount: 0 }]);
    prismaMock.feedItem.groupBy.mockResolvedValue([{ feedId: 'feed-a', _count: { _all: 1 } }]);

    await syncBookmarkBadges(ME, ['feed-a']);

    const where = prismaMock.feedItem.groupBy.mock.calls[0][0].where;
    expect(where.reads).toEqual({ none: { userId: ME } });
    expect(where.dismissals).toEqual({ none: { userId: ME } });
  });

  // GROUP BY returns no row for a feed with nothing unread, which is the exact
  // case a badge sync exists to handle: the reader just cleared the last one.
  it('reads a missing group as zero, so the last article clears the badge', async () => {
    setup([{ id: 'bm-1', feedUrl: 'https://a.example/feed', unreadCount: 4 }]);
    prismaMock.feedItem.groupBy.mockResolvedValue([]);

    expect(await syncBookmarkBadges(ME, ['feed-a'])).toEqual([{ id: 'bm-1', unreadCount: 0 }]);
  });

  it('writes one statement per distinct count, not one per bookmark', async () => {
    setup([
      { id: 'bm-1', feedUrl: 'https://a.example/feed', unreadCount: 9 },
      { id: 'bm-2', feedUrl: 'https://b.example/feed', unreadCount: 9 },
    ]);
    // Both land on zero, so both belong in the same UPDATE.
    prismaMock.feedItem.groupBy.mockResolvedValue([]);

    await syncBookmarkBadges(ME, ['feed-a', 'feed-b']);

    expect(prismaMock.bookmark.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.bookmark.updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ['bm-1', 'bm-2'] } },
      data: { unreadCount: 0 },
    });
  });

  it('writes nothing when no badge moved', async () => {
    setup([{ id: 'bm-1', feedUrl: 'https://a.example/feed', unreadCount: 2 }]);
    prismaMock.feedItem.groupBy.mockResolvedValue([{ feedId: 'feed-a', _count: { _all: 2 } }]);

    expect(await syncBookmarkBadges(ME, ['feed-a'])).toEqual([]);
    expect(prismaMock.bookmark.updateMany).not.toHaveBeenCalled();
  });

  it('caps the badge, since the tile renders anything past 99 as infinity', async () => {
    setup([{ id: 'bm-1', feedUrl: 'https://a.example/feed', unreadCount: 0 }]);
    prismaMock.feedItem.groupBy.mockResolvedValue([{ feedId: 'feed-a', _count: { _all: 5000 } }]);

    expect(await syncBookmarkBadges(ME, ['feed-a'])).toEqual([{ id: 'bm-1', unreadCount: UNREAD_CAP }]);
  });

  it('ignores bookmarks whose feed is not in the changed set', async () => {
    setup([{ id: 'bm-2', feedUrl: 'https://b.example/feed', unreadCount: 0 }]);
    prismaMock.feedItem.groupBy.mockResolvedValue([]);

    expect(await syncBookmarkBadges(ME, ['feed-a'])).toEqual([]);
    expect(prismaMock.feedItem.groupBy).not.toHaveBeenCalled();
  });
});
