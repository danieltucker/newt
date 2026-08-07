import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Must be registered before app.ts is imported, so every route module resolves
// './lib/prisma' to the mock.
vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';
import { clearTrustCache } from '../lib/trust';
import { invalidateBlockCache } from '../lib/feedBlocklist';

const ADMIN = 'admin-id';
const auth = { Authorization: `Bearer ${signAccess(ADMIN)}` };

function signedInAdmin(isAdmin = true) {
  prismaMock.user.findUnique.mockResolvedValue({
    id: ADMIN, bannedAt: null, isAdmin,
    createdAt: new Date('2020-01-01'), totpEnabled: false, username: 'root',
  });
}

/** Stub the blocklist table and drop the in-process rule cache. */
function withRules(rules: { id: string; pattern: string; kind: string; note?: string }[]) {
  prismaMock.blockedDomain.findMany.mockResolvedValue(
    rules.map(r => ({ note: '', ...r })),
  );
  invalidateBlockCache();
}

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  invalidateBlockCache();
  signedInAdmin();
});

describe('feed list sorting and filtering', () => {
  beforeEach(() => {
    prismaMock.feed.findMany.mockResolvedValue([]);
    prismaMock.feed.count.mockResolvedValue(0);
    prismaMock.feedSubscription.groupBy.mockResolvedValue([]);
    prismaMock.feedItem.groupBy.mockResolvedValue([]);
  });

  it('defaults to most recently checked first', async () => {
    const res = await request(app).get('/api/v1/admin/feeds').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe('checked');
    expect(res.body.dir).toBe('desc');

    const args = prismaMock.feed.findMany.mock.calls[0][0];
    expect(args.orderBy[0]).toEqual({ lastCheckedAt: { sort: 'desc', nulls: 'last' } });
  });

  it('orders by the requested column and direction', async () => {
    await request(app).get('/api/v1/admin/feeds?sort=failures&dir=asc').set(auth);
    const args = prismaMock.feed.findMany.mock.calls[0][0];
    expect(args.orderBy[0]).toEqual({ consecutiveFailures: { sort: 'asc', nulls: 'last' } });
  });

  it('always breaks ties on id, so paging cannot repeat or skip a row', async () => {
    await request(app).get('/api/v1/admin/feeds?sort=title').set(auth);
    const args = prismaMock.feed.findMany.mock.calls[0][0];
    expect(args.orderBy[1]).toEqual({ id: 'asc' });
  });

  it('sorts nulls last in both directions', async () => {
    // A feed that has never succeeded has no date. Floating those to the top of
    // an ascending sort buries the oldest real value, which is what was asked for.
    await request(app).get('/api/v1/admin/feeds?sort=success&dir=asc').set(auth);
    const args = prismaMock.feed.findMany.mock.calls[0][0];
    expect(args.orderBy[0]).toEqual({ lastSuccessAt: { sort: 'asc', nulls: 'last' } });
  });

  it('falls back to the default for an unknown sort key rather than erroring', async () => {
    // A sort key is a UI detail; an older client asking for one this build
    // dropped should still get its list.
    const res = await request(app).get('/api/v1/admin/feeds?sort=nonsense').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe('checked');
  });

  it('separates "failing" from "switched off"', async () => {
    // They were the same thing before disabling existed. Conflating them now
    // would bury the feeds needing a decision among ones having a bad hour.
    await request(app).get('/api/v1/admin/feeds?status=failing').set(auth);
    const where = prismaMock.feed.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ consecutiveFailures: { gt: 0 }, disabledAt: null });
  });

  it('filters to switched-off feeds', async () => {
    await request(app).get('/api/v1/admin/feeds?status=disabled').set(auth);
    const where = prismaMock.feed.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ disabledAt: { not: null } });
  });

  it('filters to feeds switched off by a block rule', async () => {
    await request(app).get('/api/v1/admin/feeds?status=blocked').set(auth);
    const where = prismaMock.feed.findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ disabledReason: 'blocked' });
  });

  it('combines a search with a filter instead of replacing it', async () => {
    const res = await request(app).get('/api/v1/admin/feeds?q=npr&status=disabled').set(auth);
    expect(res.status).toBe(200);
    const where = prismaMock.feed.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
  });

  it('sorts by subscriber count in memory, since it is not a column', async () => {
    prismaMock.feed.findMany.mockResolvedValue([
      { id: 'a', fetchUrl: 'https://a.com/f', canonicalKey: 'a.com/f', title: 'A', lastCheckedAt: null, lastSuccessAt: null, lastRequestedAt: null, consecutiveFailures: 0, lastError: null, lastErrorAt: null, disabledAt: null, disabledReason: null },
      { id: 'b', fetchUrl: 'https://b.com/f', canonicalKey: 'b.com/f', title: 'B', lastCheckedAt: null, lastSuccessAt: null, lastRequestedAt: null, consecutiveFailures: 0, lastError: null, lastErrorAt: null, disabledAt: null, disabledReason: null },
    ]);
    prismaMock.feedSubscription.groupBy.mockResolvedValue([
      { url: 'https://a.com/f', _count: { _all: 1 } },
      { url: 'https://b.com/f', _count: { _all: 9 } },
    ]);

    const res = await request(app).get('/api/v1/admin/feeds?sort=subscribers&dir=desc').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.feeds.map((f: { id: string }) => f.id)).toEqual(['b', 'a']);
    // The count path must not also ask the database to order by a column that
    // does not exist.
    expect(prismaMock.feed.findMany.mock.calls[0][0].orderBy).toBeUndefined();
  });

  it('reports the automatic disable threshold so the panel need not hardcode it', async () => {
    const res = await request(app).get('/api/v1/admin/feeds').set(auth);
    expect(res.body.disableAfterFailures).toBeGreaterThan(0);
  });

  it('refuses a non-admin', async () => {
    signedInAdmin(false);
    const res = await request(app).get('/api/v1/admin/feeds').set(auth);
    expect(res.status).toBe(403);
  });
});

describe('feed actions', () => {
  const FEED = {
    id: 'f1', fetchUrl: 'https://example.com/feed', title: 'Example',
    disabledAt: null, disabledReason: null,
  };

  it('disables a feed without deleting anything', async () => {
    prismaMock.feed.findUnique.mockResolvedValue(FEED);
    const res = await request(app).post('/api/v1/admin/feeds/f1/disable').set(auth);

    expect(res.status).toBe(200);
    expect(prismaMock.feed.delete).not.toHaveBeenCalled();
    expect(prismaMock.feed.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ disabledReason: 'manual' }),
    }));
  });

  it('clears the failure run when switching a feed back on', async () => {
    // Leaving it at the threshold would put the feed one bad fetch from
    // switching itself straight back off, making the retry look like it never
    // happened.
    prismaMock.feed.findUnique.mockResolvedValue({
      ...FEED, disabledAt: new Date(), disabledReason: 'failing',
    });
    await request(app).post('/api/v1/admin/feeds/f1/enable').set(auth);

    expect(prismaMock.feed.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { disabledAt: null, disabledReason: null, consecutiveFailures: 0, failureAlertedAt: null },
    }));
  });

  it('refuses to re-enable a feed whose host is still blocked', async () => {
    // Re-enabling it would be undone by the next refresh, which reads as the
    // button not working.
    withRules([{ id: 'r1', pattern: 'example.com', kind: 'domain' }]);
    prismaMock.feed.findUnique.mockResolvedValue({
      ...FEED, disabledAt: new Date(), disabledReason: 'blocked',
    });

    const res = await request(app).post('/api/v1/admin/feeds/f1/enable').set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('example.com');
    expect(prismaMock.feed.update).not.toHaveBeenCalled();
  });

  it('allows re-enabling once the rule covering it is gone', async () => {
    withRules([]);
    prismaMock.feed.findUnique.mockResolvedValue({
      ...FEED, disabledAt: new Date(), disabledReason: 'blocked',
    });
    const res = await request(app).post('/api/v1/admin/feeds/f1/enable').set(auth);
    expect(res.status).toBe(200);
  });

  it('writes an audit row for every action', async () => {
    prismaMock.feed.findUnique.mockResolvedValue(FEED);
    await request(app).post('/api/v1/admin/feeds/f1/disable').set(auth);
    expect(prismaMock.adminAction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'feed.disable', targetType: 'feed' }),
    }));
  });

  it('404s on a feed that is gone', async () => {
    prismaMock.feed.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/v1/admin/feeds/nope/disable').set(auth);
    expect(res.status).toBe(404);
  });

  it('leaves subscriptions alone when deleting a feed', async () => {
    // Subscriptions belong to users. Removing somebody's without telling them is
    // not an action this offers.
    prismaMock.feed.findUnique.mockResolvedValue(FEED);
    const res = await request(app).delete('/api/v1/admin/feeds/f1').set(auth);
    expect(res.status).toBe(200);
    expect(prismaMock.feed.delete).toHaveBeenCalled();
    expect(prismaMock.feedSubscription.deleteMany).not.toHaveBeenCalled();
  });
});

describe('blocked domains', () => {
  it('normalises a pasted URL down to the host', async () => {
    prismaMock.blockedDomain.findUnique.mockResolvedValue(null);
    prismaMock.blockedDomain.create.mockResolvedValue({
      id: 'r1', pattern: 'example.com', kind: 'domain', note: '',
      createdByUsername: 'root', createdAt: new Date(),
    });

    const res = await request(app).post('/api/v1/admin/blocked-domains')
      .set(auth).send({ pattern: 'https://www.Example.com/rss.xml' });

    expect(res.status).toBe(201);
    expect(prismaMock.blockedDomain.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pattern: 'example.com', kind: 'domain' }),
    }));
  });

  it('stores a leading-dot pattern as a suffix rule', async () => {
    prismaMock.blockedDomain.findUnique.mockResolvedValue(null);
    prismaMock.blockedDomain.create.mockResolvedValue({
      id: 'r1', pattern: '.xyz', kind: 'suffix', note: '',
      createdByUsername: 'root', createdAt: new Date(),
    });

    await request(app).post('/api/v1/admin/blocked-domains').set(auth).send({ pattern: '.xyz' });
    expect(prismaMock.blockedDomain.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pattern: '.xyz', kind: 'suffix' }),
    }));
  });

  it('rejects a pattern that is not a hostname', async () => {
    const res = await request(app).post('/api/v1/admin/blocked-domains')
      .set(auth).send({ pattern: '*.example.com' });
    expect(res.status).toBe(400);
    expect(prismaMock.blockedDomain.create).not.toHaveBeenCalled();
  });

  it('reports the normalised pattern on a duplicate', async () => {
    // The stored rule may not look like what was typed, so a bare "already
    // exists" would be confusing.
    prismaMock.blockedDomain.findUnique.mockResolvedValue({ id: 'r1', pattern: 'example.com' });
    const res = await request(app).post('/api/v1/admin/blocked-domains')
      .set(auth).send({ pattern: 'WWW.example.com/' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('example.com');
  });

  it('switches off the feeds a new rule covers, and reports how many', async () => {
    prismaMock.blockedDomain.findUnique.mockResolvedValue(null);
    prismaMock.blockedDomain.create.mockResolvedValue({
      id: 'r1', pattern: 'spam.example', kind: 'domain', note: '',
      createdByUsername: 'root', createdAt: new Date(),
    });
    prismaMock.feed.findMany.mockResolvedValue([
      { id: 'f1', fetchUrl: 'https://spam.example/feed' },
      { id: 'f2', fetchUrl: 'https://news.spam.example/feed' },
      // Must not match: the whole point of label-boundary comparison.
      { id: 'f3', fetchUrl: 'https://notspam.example/feed' },
      { id: 'f4', fetchUrl: 'https://good.com/feed' },
    ]);
    prismaMock.feed.updateMany.mockResolvedValue({ count: 2 });

    const res = await request(app).post('/api/v1/admin/blocked-domains')
      .set(auth).send({ pattern: 'spam.example' });

    expect(res.status).toBe(201);
    expect(res.body.disabled).toBe(2);
    expect(prismaMock.feed.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['f1', 'f2'] } },
      data: expect.objectContaining({ disabledReason: 'blocked' }),
    }));
  });

  it('does not revive feeds when a rule is removed without restore', async () => {
    // A block usually outlives its rule. Silently restarting fetches to a host
    // an admin objected to is not a decision this makes on its own.
    prismaMock.blockedDomain.findUnique.mockResolvedValue({
      id: 'r1', pattern: '.xyz', kind: 'suffix',
    });
    const res = await request(app).delete('/api/v1/admin/blocked-domains/r1').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(0);
    expect(prismaMock.feed.updateMany).not.toHaveBeenCalled();
  });

  it('revives only the feeds no remaining rule covers', async () => {
    // Two overlapping rules: removing '.xyz' must not undo 'spam.xyz'.
    prismaMock.blockedDomain.findUnique.mockResolvedValue({
      id: 'r1', pattern: '.xyz', kind: 'suffix',
    });
    withRules([{ id: 'r2', pattern: 'spam.xyz', kind: 'domain' }]);
    prismaMock.feed.findMany.mockResolvedValue([
      { id: 'f1', fetchUrl: 'https://ordinary.xyz/feed' },
      { id: 'f2', fetchUrl: 'https://spam.xyz/feed' },
    ]);
    prismaMock.feed.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).delete('/api/v1/admin/blocked-domains/r1?restore=1').set(auth);

    expect(res.status).toBe(200);
    expect(prismaMock.feed.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['f1'] }, disabledReason: 'blocked' },
    }));
  });

  it('404s on a rule that is gone', async () => {
    prismaMock.blockedDomain.findUnique.mockResolvedValue(null);
    const res = await request(app).delete('/api/v1/admin/blocked-domains/nope').set(auth);
    expect(res.status).toBe(404);
  });

  it('refuses a non-admin', async () => {
    signedInAdmin(false);
    const res = await request(app).post('/api/v1/admin/blocked-domains')
      .set(auth).send({ pattern: 'example.com' });
    expect(res.status).toBe(403);
  });
});
