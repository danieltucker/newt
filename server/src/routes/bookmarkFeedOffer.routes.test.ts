import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

// Discovery fetches the bookmarked site. Stubbed so these tests exercise the
// decision — offer, stay quiet, or refuse — rather than the fetcher.
vi.mock('../lib/feedDiscovery', () => ({ discoverFeed: vi.fn() }));

vi.mock('../lib/feedRefresh', () => ({
  ensureFeeds: vi.fn().mockResolvedValue([]),
  refreshStaleFeeds: vi.fn().mockResolvedValue(undefined),
}));

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';
import { clearTrustCache } from '../lib/trust';
import { invalidateBlockCache } from '../lib/feedBlocklist';
import { discoverFeed as discoverFeedImport } from '../lib/feedDiscovery';

const discoverFeed = vi.mocked(discoverFeedImport);

const ME = 'me-id';
const auth = { Authorization: `Bearer ${signAccess(ME)}` };

const BOOKMARK = { id: 'bm1', userId: ME, domain: 'example.com', name: 'Example', feedUrl: null };

function withRules(rules: { id: string; pattern: string; kind: string }[]) {
  prismaMock.blockedDomain.findMany.mockResolvedValue(rules.map(r => ({ note: '', ...r })));
  invalidateBlockCache();
}

// The auth middleware and the route both read the user row; only the route cares
// about `settings`, so it is the one thing worth varying.
function withSettings(settings: unknown) {
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false, settings,
  });
}

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  invalidateBlockCache();
  discoverFeed.mockReset();
  withSettings(null);
  prismaMock.bookmark.findFirst.mockResolvedValue(BOOKMARK);
});

describe('POST /bookmarks/:id/discover-feed', () => {
  it('offers the feed it finds, and remembers the address for the tile badge', async () => {
    discoverFeed.mockResolvedValue('https://example.com/feed.xml');

    const res = await request(app).post('/api/v1/bookmarks/bm1/discover-feed').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.offer).toMatchObject({ url: 'https://example.com/feed.xml' });
    expect(prismaMock.bookmark.updateMany.mock.calls[0][0].data)
      .toMatchObject({ feedUrl: 'https://example.com/feed.xml' });
  });

  it('does not subscribe on its own — that is what the prompt is for', async () => {
    discoverFeed.mockResolvedValue('https://example.com/feed.xml');

    await request(app).post('/api/v1/bookmarks/bm1/discover-feed').set(auth);

    expect(prismaMock.feedSubscription.create).not.toHaveBeenCalled();
  });

  it('stays quiet when the site has no feed, and records the miss', async () => {
    discoverFeed.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/bookmarks/bm1/discover-feed').set(auth);

    expect(res.body).toEqual({ offer: null });
    // feedCheckedAt is what stops the periodic sweep re-probing a feedless site.
    expect(prismaMock.bookmark.updateMany.mock.calls[0][0].data.feedCheckedAt).toBeDefined();
  });

  it('stays quiet when the user has turned RSS off, without fetching anything', async () => {
    withSettings({ rssEnabled: false });

    const res = await request(app).post('/api/v1/bookmarks/bm1/discover-feed').set(auth);

    expect(res.body).toEqual({ offer: null });
    expect(discoverFeed).not.toHaveBeenCalled();
  });

  it('stays quiet when the discovered address is blocklisted', async () => {
    withRules([{ id: 'r1', pattern: 'example.com', kind: 'domain' }]);
    discoverFeed.mockResolvedValue('https://example.com/feed.xml');

    const res = await request(app).post('/api/v1/bookmarks/bm1/discover-feed').set(auth);

    expect(res.body).toEqual({ offer: null });
  });

  it('stays quiet when the same feed is already followed under another spelling', async () => {
    discoverFeed.mockResolvedValue('https://example.com/feed.xml');
    prismaMock.feedSubscription.findMany.mockResolvedValue([{ url: 'http://www.example.com/feed.xml/' }]);

    const res = await request(app).post('/api/v1/bookmarks/bm1/discover-feed').set(auth);

    expect(res.body).toEqual({ offer: null });
  });

  it('skips discovery when the bookmark already knows its feed', async () => {
    prismaMock.bookmark.findFirst.mockResolvedValue({ ...BOOKMARK, feedUrl: 'https://example.com/rss' });

    const res = await request(app).post('/api/v1/bookmarks/bm1/discover-feed').set(auth);

    expect(discoverFeed).not.toHaveBeenCalled();
    expect(res.body.offer).toMatchObject({ url: 'https://example.com/rss' });
  });

  it('scopes the lookup to the caller, so another account\'s bookmark 404s', async () => {
    prismaMock.bookmark.findFirst.mockResolvedValue(null);

    await request(app).post('/api/v1/bookmarks/not-mine/discover-feed').set(auth).expect(404);
    expect(prismaMock.bookmark.findFirst.mock.calls[0][0].where).toMatchObject({ userId: ME });
  });
});

describe('POST /bookmarks/:id/follow-feed', () => {
  it('subscribes to the address stored on the bookmark', async () => {
    prismaMock.bookmark.findFirst.mockResolvedValue({ ...BOOKMARK, feedUrl: 'https://example.com/feed.xml' });

    const res = await request(app).post('/api/v1/bookmarks/bm1/follow-feed').set(auth);

    expect(res.status).toBe(200);
    expect(prismaMock.feedSubscription.create.mock.calls[0][0].data).toMatchObject({
      userId: ME, url: 'https://example.com/feed.xml', name: 'Example',
    });
  });

  it('ignores any feed URL in the request body', async () => {
    prismaMock.bookmark.findFirst.mockResolvedValue({ ...BOOKMARK, feedUrl: 'https://example.com/feed.xml' });

    await request(app).post('/api/v1/bookmarks/bm1/follow-feed')
      .set(auth).send({ url: 'https://attacker.example/feed' });

    expect(prismaMock.feedSubscription.create.mock.calls[0][0].data.url)
      .toBe('https://example.com/feed.xml');
  });

  it('re-checks the blocklist, since a rule can land between the two calls', async () => {
    withRules([{ id: 'r1', pattern: 'example.com', kind: 'domain' }]);
    prismaMock.bookmark.findFirst.mockResolvedValue({ ...BOOKMARK, feedUrl: 'https://example.com/feed.xml' });

    const res = await request(app).post('/api/v1/bookmarks/bm1/follow-feed').set(auth);

    expect(res.status).toBe(403);
    expect(prismaMock.feedSubscription.create).not.toHaveBeenCalled();
  });

  it('refuses once the account is at its feed cap', async () => {
    prismaMock.bookmark.findFirst.mockResolvedValue({ ...BOOKMARK, feedUrl: 'https://example.com/feed.xml' });
    prismaMock.feedSubscription.count.mockResolvedValue(200);

    const res = await request(app).post('/api/v1/bookmarks/bm1/follow-feed').set(auth);

    expect(res.status).toBe(400);
    expect(prismaMock.feedSubscription.create).not.toHaveBeenCalled();
  });

  it('404s a bookmark with no feed rather than guessing one', async () => {
    await request(app).post('/api/v1/bookmarks/bm1/follow-feed').set(auth).expect(404);
  });
});
