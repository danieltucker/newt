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

const USER = 'user-id';
const auth = { Authorization: `Bearer ${signAccess(USER)}` };

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  prismaMock.user.findUnique.mockResolvedValue({
    id: USER, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false, username: 'reader',
  });
});

/** Subscribes the user to one feed, so the article half has somewhere to look. */
function withSubscription() {
  prismaMock.feedSubscription.findMany.mockResolvedValue([{ url: 'https://x.test/f', name: '' }]);
  prismaMock.feed.findMany.mockResolvedValue([{ id: 'feed-0', fetchUrl: 'https://x.test/f', title: '' }]);
}

/** The `where` a model's findMany was called with. */
function whereOf(calls: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = calls.mock.calls[0];
  return (call?.[0] as { where: Record<string, unknown> })?.where ?? {};
}

describe('GET /api/v1/search — access', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/v1/search?q=climate');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/search — query handling', () => {
  it('answers a one-character query without touching the database', async () => {
    const res = await request(app).get('/api/v1/search?q=a').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      articles: [], posts: [], explores: [],
      more: { articles: false, posts: false, explores: false },
      offset: 0,
    });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers a query of punctuation without touching the database', async () => {
    // Nothing survives tokenising, so there is no tsquery to run — and an empty
    // one matches either everything or nothing depending on the Postgres
    // version, which is why it must never be built.
    const res = await request(app).get('/api/v1/search?q=--%20%2B%2B').set(auth);
    expect(res.status).toBe(200);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('searches all three corpora by default', async () => {
    withSubscription();
    await request(app).get('/api/v1/search?q=climate').set(auth);
    // One ranking query per corpus: the archive, posts, explores.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('searches only the corpora asked for', async () => {
    withSubscription();
    await request(app).get('/api/v1/search?q=climate&kinds=posts').set(auth);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.feedSubscription.findMany).not.toHaveBeenCalled();
  });

  it('falls back to everything when kinds is unrecognised', async () => {
    withSubscription();
    await request(app).get('/api/v1/search?q=climate&kinds=nonsense').set(auth);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('caps the limit', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    await request(app).get('/api/v1/search?q=climate&kinds=posts&limit=9999').set(auth);
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1);
    // The candidate window is a multiple of the span, so an uncapped limit
    // would become an uncapped scan. 51 is LIMIT_MAX plus the one extra row
    // that answers "is there another page".
    expect(values).toContain(255);   // (50 + 1) × 5
  });
});

describe('GET /api/v1/search — paging', () => {
  /** `limit` rows of whatever the ranking query hands back. */
  function withPostHits(n: number) {
    const ids = Array.from({ length: n }, (_, i) => ({ id: `post-${i}`, rank: 1 - i / 100 }));
    prismaMock.$queryRaw.mockResolvedValue(ids);
    prismaMock.blogPost.findMany.mockResolvedValue(ids.map(({ id }) => ({
      id, title: id, slug: id, excerpt: '', tags: [], heroImage: '',
      visibility: 'public', publishedAt: new Date('2026-01-01'),
      userId: 'other', url: `https://n.test/${id}`,
      user: { id: 'other', username: 'writer', firstName: '', lastName: '', avatar: '' },
    })));
  }

  it('reports another page when there is one, without claiming a total', async () => {
    withPostHits(6);
    const res = await request(app).get('/api/v1/search?q=climate&kinds=posts&limit=5').set(auth);
    // Five back, not the six that were fetched: the extra row is the signal,
    // not a result.
    expect(res.body.posts).toHaveLength(5);
    expect(res.body.more.posts).toBe(true);
    expect(res.body).not.toHaveProperty('total');
  });

  it('reports no next page when the corpus runs out exactly on the boundary', async () => {
    withPostHits(5);
    const res = await request(app).get('/api/v1/search?q=climate&kinds=posts&limit=5').set(auth);
    expect(res.body.posts).toHaveLength(5);
    expect(res.body.more.posts).toBe(false);
  });

  it('reports it per corpus, since they run out at different depths', async () => {
    withSubscription();
    withPostHits(2);
    const res = await request(app).get('/api/v1/search?q=climate&limit=5').set(auth);
    expect(res.body.more).toEqual({ articles: false, posts: false, explores: false });
  });

  it('offsets the archive in SQL', async () => {
    withSubscription();
    await request(app).get('/api/v1/search?q=climate&kinds=articles&limit=10&offset=30').set(auth);
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(11);   // limit + the probe row
    expect(values).toContain(30);
  });

  it('widens the candidate window to cover the page being asked for', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    await request(app).get('/api/v1/search?q=climate&kinds=posts&limit=10&offset=40').set(auth);
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1);
    // The ranking query knows nothing about visibility, so page five can only
    // be served by ranking far enough to contain it: (40 + 11) × 5.
    expect(values).toContain(255);
  });

  it('caps how deep paging can go', async () => {
    withSubscription();
    await request(app).get('/api/v1/search?q=climate&kinds=articles&offset=99999').set(auth);
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(400);   // MAX_OFFSET
  });

  it('treats a nonsense offset as the first page', async () => {
    withSubscription();
    await request(app).get('/api/v1/search?q=climate&kinds=articles&offset=-5').set(auth);
    expect(prismaMock.$queryRaw.mock.calls[0].slice(1)).toContain(0);
  });
});

describe('GET /api/v1/search — tag mode', () => {
  it('matches post tags rather than post text', async () => {
    await request(app).get('/api/v1/search?q=energy&mode=tag&kinds=posts').set(auth);
    // No ranking query at all: a tag is an equality test against an indexed
    // array, so there is nothing to rank and nothing to draw a window of.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    expect(whereOf(prismaMock.blogPost.findMany).tags).toEqual({ has: 'energy' });
  });

  it('normalises the tag the way the write path does', async () => {
    await request(app).get('/api/v1/search?q=Energy&mode=tag&kinds=posts').set(auth);
    expect(whereOf(prismaMock.blogPost.findMany).tags).toEqual({ has: 'energy' });
  });

  it('still applies the viewer scope to a tag search', async () => {
    await request(app).get('/api/v1/search?q=energy&mode=tag&kinds=posts').set(auth);
    expect(whereOf(prismaMock.blogPost.findMany).OR).toBeDefined();
  });

  it('returns no explores for a tag search', async () => {
    // A thread carries no labels, so answering a tag search with a text match
    // would put rows under a heading that means something else.
    const res = await request(app).get('/api/v1/search?q=energy&mode=tag').set(auth);
    expect(res.body.explores).toEqual([]);
    expect(prismaMock.researchThread.findMany).not.toHaveBeenCalled();
  });

  it('asks the archive for categories rather than text', async () => {
    withSubscription();
    await request(app).get('/api/v1/search?q=energy&mode=tag&kinds=articles').set(auth);
    // The tag branch of the archive query passes an escaped LIKE prefix; the
    // text branch passes a tsquery. Which one ran is visible in the values.
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain('energy%');
  });
});

describe('GET /api/v1/search — visibility', () => {
  // The one that matters. The ranking query above is deliberately unfiltered —
  // it ranks every matching row on the instance — so the *only* thing standing
  // between a search and somebody else's private post is the where clause the
  // second query is built with.
  it('filters ranked posts through the viewer scope', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'post-1', rank: 0.9 }]);
    prismaMock.friendship.findMany.mockResolvedValue([
      { requesterId: USER, addresseeId: 'friend-1', status: 'accepted' },
    ]);
    prismaMock.block.findMany.mockResolvedValue([
      { blockerId: USER, blockedId: 'blocked-1' },
    ]);

    await request(app).get('/api/v1/search?q=climate&kinds=posts').set(auth);

    const where = whereOf(prismaMock.blogPost.findMany);
    expect(where.id).toEqual({ in: ['post-1'] });
    expect(where.OR).toEqual([
      { visibility: 'public' },
      { visibility: 'friends', userId: { in: ['friend-1'] } },
      { userId: USER },
    ]);
    expect(where.userId).toEqual({ notIn: ['blocked-1'] });
  });

  it('never asks for a post by id alone', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'post-1', rank: 0.9 }]);
    await request(app).get('/api/v1/search?q=climate&kinds=posts').set(auth);
    const where = whereOf(prismaMock.blogPost.findMany);
    expect(where.OR).toBeDefined();
  });

  it('keeps generated explores visible to a viewer who has blocked someone', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'thread-1', rank: 0.9 }]);
    prismaMock.block.findMany.mockResolvedValue([
      { blockerId: USER, blockedId: 'blocked-1' },
    ]);

    await request(app).get('/api/v1/search?q=climate&kinds=explores').set(auth);

    const where = whereOf(prismaMock.researchThread.findMany);
    // `userId NOT IN (…)` is NULL for a thread nobody owns, so the block filter
    // has to admit the null case explicitly or every generated explore vanishes
    // the moment the reader blocks anybody.
    expect(where.AND).toContainEqual({
      OR: [{ userId: null }, { userId: { notIn: ['blocked-1'] } }],
    });
  });

  it('applies no block filter when the viewer has blocked nobody', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'thread-1', rank: 0.9 }]);
    await request(app).get('/api/v1/search?q=climate&kinds=explores').set(auth);
    const where = whereOf(prismaMock.researchThread.findMany);
    expect((where.AND as unknown[]).length).toBe(2);   // id + tiers, nothing else
  });
});

describe('GET /api/v1/search — results', () => {
  it('returns posts in the order the ranking query gave them', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { id: 'post-a', rank: 0.9 },
      { id: 'post-b', rank: 0.4 },
    ]);
    const post = (id: string, title: string) => ({
      id, title, slug: title.toLowerCase(), excerpt: '', tags: [],
      visibility: 'public', publishedAt: new Date('2026-01-01'),
      userId: 'other', url: `https://n.test/${id}`,
      user: { id: 'other', username: 'writer', firstName: '', lastName: '', avatar: '' },
    });
    // Deliberately handed back in the wrong order: findMany makes no promises,
    // and the ranking is the whole point of the first query.
    prismaMock.blogPost.findMany.mockResolvedValue([post('post-b', 'B'), post('post-a', 'A')]);

    const res = await request(app).get('/api/v1/search?q=climate&kinds=posts').set(auth);

    expect(res.body.posts.map((p: { id: string }) => p.id)).toEqual(['post-a', 'post-b']);
    expect(res.body.posts[0].href).toBe('/u/writer/a');
    expect(res.body.posts[0].own).toBe(false);
  });

  it('marks the viewer’s own results and counts explore turns as exchanges', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'thread-1', rank: 0.9 }]);
    prismaMock.researchThread.findMany.mockResolvedValue([{
      id: 'thread-1', title: 'Grid storage', sourceTitle: '', visibility: 'private',
      sharedAt: null, updatedAt: new Date('2026-02-02'), userId: USER, origin: 'user',
      user: { id: USER, username: 'reader', firstName: '', lastName: '', avatar: '' },
      _count: { messages: 6 },
      messages: [{ body: '## Heading\n\nThe **answer**.' }],
    }]);

    const res = await request(app).get('/api/v1/search?q=grid&kinds=explores').set(auth);

    const hit = res.body.explores[0];
    expect(hit.own).toBe(true);
    expect(hit.visibility).toBe('private');
    expect(hit.turns).toBe(3);
    expect(hit.href).toBe('/e/thread-1');
    // Markdown is de-marked for the preview line rather than shown raw.
    expect(hit.snippet).toBe('Heading The answer.');
  });
});
