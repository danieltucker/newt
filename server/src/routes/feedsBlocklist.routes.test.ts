import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

// Discovery goes over the network. Stubbed to resolve to whatever the test asks
// for, so these can exercise the gate rather than the fetcher — including the
// case that matters most: the typed address resolving onto a *different* host.
//
// The factory is hoisted above every top-level statement in this file, so the
// stub has to be created inside it; a `const` declared above would not exist yet.
vi.mock('../lib/feedDiscovery', () => ({ resolveFeedUrl: vi.fn() }));

// Nothing here should reach the refresher, and letting it try would fire real
// requests from the test run.
vi.mock('../lib/feedRefresh', () => ({
  ensureFeeds: vi.fn().mockResolvedValue([]),
  refreshStaleFeeds: vi.fn().mockResolvedValue(undefined),
}));

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';
import { clearTrustCache } from '../lib/trust';
import { invalidateBlockCache } from '../lib/feedBlocklist';
import { resolveFeedUrl as resolveFeedUrlImport } from '../lib/feedDiscovery';

const resolveFeedUrl = vi.mocked(resolveFeedUrlImport);

const ME = 'me-id';
const auth = { Authorization: `Bearer ${signAccess(ME)}` };

function withRules(rules: { id: string; pattern: string; kind: string }[]) {
  prismaMock.blockedDomain.findMany.mockResolvedValue(rules.map(r => ({ note: '', ...r })));
  invalidateBlockCache();
}

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  invalidateBlockCache();
  resolveFeedUrl.mockReset();
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false,
  });
  prismaMock.feedSubscription.count.mockResolvedValue(0);
  prismaMock.feedSubscription.findMany.mockResolvedValue([]);
});

describe('POST /feeds — the block gate', () => {
  it('refuses a feed on a blocked domain', async () => {
    withRules([{ id: 'r1', pattern: 'spam.example', kind: 'domain' }]);
    resolveFeedUrl.mockResolvedValue({ ok: true, url: 'https://spam.example/feed', title: 'Spam' });

    const res = await request(app).post('/api/v1/feeds').set(auth).send({ url: 'spam.example' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('spam.example');
    expect(prismaMock.feedSubscription.create).not.toHaveBeenCalled();
  });

  it('refuses a feed under a blocked extension', async () => {
    withRules([{ id: 'r1', pattern: '.xyz', kind: 'suffix' }]);
    resolveFeedUrl.mockResolvedValue({ ok: true, url: 'https://anything.xyz/feed', title: '' });

    const res = await request(app).post('/api/v1/feeds').set(auth).send({ url: 'anything.xyz' });
    expect(res.status).toBe(403);
  });

  it('checks the resolved address, not the one that was typed', async () => {
    // A shortener or a redirect through a clean host would otherwise walk
    // straight past the rule — which is the whole reason the check sits after
    // discovery rather than before it.
    withRules([{ id: 'r1', pattern: 'spam.example', kind: 'domain' }]);
    resolveFeedUrl.mockResolvedValue({ ok: true, url: 'https://spam.example/feed', title: '' });

    const res = await request(app).post('/api/v1/feeds').set(auth).send({ url: 'https://tidy.link/abc' });
    expect(res.status).toBe(403);
  });

  it('applies to server-vouched URLs too', async () => {
    // skipValidation means "this is a real feed", not "this one is permitted".
    withRules([{ id: 'r1', pattern: 'spam.example', kind: 'domain' }]);

    const res = await request(app).post('/api/v1/feeds').set(auth)
      .send({ url: 'https://spam.example/feed', skipValidation: true });

    expect(res.status).toBe(403);
    expect(resolveFeedUrl).not.toHaveBeenCalled();
    expect(prismaMock.feedSubscription.create).not.toHaveBeenCalled();
  });

  it('lets a lookalike domain through', async () => {
    // notspam.example is a different site. Over-blocking here is silent — nobody
    // reports a feed they were never allowed to add.
    withRules([{ id: 'r1', pattern: 'spam.example', kind: 'domain' }]);
    resolveFeedUrl.mockResolvedValue({ ok: true, url: 'https://notspam.example/feed', title: 'Fine' });
    prismaMock.feedSubscription.create.mockResolvedValue({
      id: 's1', url: 'https://notspam.example/feed', name: '', position: 0, feedFolderId: null,
    });

    const res = await request(app).post('/api/v1/feeds').set(auth).send({ url: 'notspam.example' });
    expect(res.status).toBe(201);
  });

  it('adds normally when nothing is blocked', async () => {
    withRules([]);
    resolveFeedUrl.mockResolvedValue({ ok: true, url: 'https://good.com/feed', title: 'Good' });
    prismaMock.feedSubscription.create.mockResolvedValue({
      id: 's1', url: 'https://good.com/feed', name: '', position: 0, feedFolderId: null,
    });

    const res = await request(app).post('/api/v1/feeds').set(auth).send({ url: 'good.com' });
    expect(res.status).toBe(201);
  });
});

describe('POST /feeds/batch — the block gate', () => {
  it('skips only the blocked entries and imports the rest', async () => {
    // One bad address in an OPML import must not cost the other forty-nine.
    withRules([{ id: 'r1', pattern: '.xyz', kind: 'suffix' }]);
    prismaMock.feedFolder.findMany.mockResolvedValue([]);
    prismaMock.feedSubscription.create.mockImplementation(
      async ({ data }: { data: { url: string } }) =>
        ({ id: `s-${data.url}`, url: data.url, name: '', position: 0, feedFolderId: null }),
    );

    const res = await request(app).post('/api/v1/feeds/batch').set(auth).send({
      feeds: [
        { url: 'https://good.com/feed' },
        { url: 'https://bad.xyz/feed' },
        { url: 'https://alsogood.com/feed' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.added).toHaveLength(2);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].url).toBe('https://bad.xyz/feed');
    expect(res.body.skipped[0].reason).toContain('.xyz');
  });
});
