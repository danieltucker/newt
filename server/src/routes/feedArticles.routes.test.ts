import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});
vi.mock('../lib/feedRefresh', () => ({
  ensureFeeds: vi.fn(async () => [{ id: 'feed-a', fetchUrl: 'https://a.example/feed', title: 'A', lastCheckedAt: new Date() }]),
  refreshStaleFeeds: vi.fn(async () => {}),
}));

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';
import { clearTrustCache } from '../lib/trust';

const ME = 'me-id';
const auth = { Authorization: `Bearer ${signAccess(ME)}` };

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false,
  });
  prismaMock.feedSubscription.findMany.mockResolvedValue([
    { url: 'https://a.example/feed', name: 'A', feedFolderId: null },
  ]);
  prismaMock.readFeedItem.findMany.mockResolvedValue([]);
});

/**
 * The river's page query and its two totals are raw SQL, so a route test is the
 * only place the *shape* of what they are asked for gets checked. These assert
 * the properties that make it correct and cheap - not the SQL text, which is
 * free to change.
 */
describe('GET /feeds/articles — the story page query', () => {
  function rawResults(page: unknown[], counts: { total: number; unread: number }) {
    // The route fires the page query and the count query; order is not
    // guaranteed by Promise.all, so answer on the shape of the statement.
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (/DISTINCT ON/.test(sql)) return Promise.resolve(page);
      return Promise.resolve([{ total: BigInt(counts.total), unread: BigInt(counts.unread) }]);
    });
  }

  const ITEM = {
    id: 'i1', feedId: 'feed-a', title: 'Headline', link: 'https://a.example/1',
    pubDate: new Date('2026-08-01'), fetchedAt: new Date('2026-08-02'),
    firstSeenAt: new Date('2026-08-01'), readTime: 4, snippet: 's',
    imageUrl: null, categories: ['tech'],
  };

  it('returns the page and both totals', async () => {
    rawResults([ITEM], { total: 42, unread: 7 });
    const res = await request(app).get('/api/v1/feeds/articles').set(auth).expect(200);
    expect(res.body.articles).toHaveLength(1);
    expect(res.body.articles[0].title).toBe('Headline');
    expect(res.body.total).toBe(42);
    expect(res.body.unread).toBe(7);
    expect(res.body.hasMore).toBe(true);
  });

  // The whole point of the rewrite: the database returns one page, not the
  // whole river for the process to slice. If LIMIT ever leaves this statement,
  // rendering ten cards goes back to shipping every item the user subscribes to.
  it('pushes dedupe, offset and limit into SQL', async () => {
    rawResults([ITEM], { total: 1, unread: 1 });
    await request(app).get('/api/v1/feeds/articles?offset=20&limit=5').set(auth).expect(200);

    const call = prismaMock.$queryRaw.mock.calls
      .map(c => (c[0] as TemplateStringsArray).join(' ?? '))
      .find(sql => /DISTINCT ON/.test(sql));
    expect(call).toBeDefined();
    expect(call).toMatch(/DISTINCT ON \(i\."linkKey"\)/);
    expect(call).toMatch(/OFFSET/);
    expect(call).toMatch(/LIMIT/);
    // The offset and limit travel as parameters, not interpolated text.
    const params = prismaMock.$queryRaw.mock.calls
      .find(c => /DISTINCT ON/.test((c[0] as TemplateStringsArray).join(' ')))!
      .slice(1);
    expect(params).toContain(20);
    expect(params).toContain(5);
  });

  // fetchedAt is rewritten on every poll and en masse on a 304. Ordering the
  // river by it reshuffles the cards under the reader each time the scheduler
  // runs, and flips which copy of a duplicated story wins.
  it('never orders by fetchedAt', async () => {
    rawResults([ITEM], { total: 1, unread: 1 });
    await request(app).get('/api/v1/feeds/articles').set(auth).expect(200);

    const sql = prismaMock.$queryRaw.mock.calls
      .map(c => (c[0] as TemplateStringsArray).join(' '))
      .find(s => /DISTINCT ON/.test(s))!;
    const orderClauses = sql.match(/ORDER BY[^)]*/g) ?? [];
    expect(orderClauses.length).toBeGreaterThan(0);
    for (const clause of orderClauses) expect(clause).not.toMatch(/fetchedAt/);
    // Both sorts are present and lead correctly: the inner one by linkKey (a
    // DISTINCT ON requirement), the outer by publication date.
    expect(sql).toMatch(/ORDER BY i\."linkKey", i\."pubDate" DESC, i\."firstSeenAt" DESC/);
    expect(sql).toMatch(/ORDER BY s\."pubDate" DESC, s\."firstSeenAt" DESC/);
  });

  // The endpoint never returns article bodies, and selecting them was 7.3MB of
  // the 11.7MB the old query moved.
  it('does not select the content column', async () => {
    rawResults([ITEM], { total: 1, unread: 1 });
    await request(app).get('/api/v1/feeds/articles').set(auth).expect(200);

    const sql = prismaMock.$queryRaw.mock.calls
      .map(c => (c[0] as TemplateStringsArray).join(' '))
      .find(s => /DISTINCT ON/.test(s))!;
    expect(sql).not.toMatch(/"content"/);
  });

  // Two scans of every item in every subscribed feed became one.
  it('asks for total and unread in a single statement', async () => {
    rawResults([ITEM], { total: 9, unread: 3 });
    await request(app).get('/api/v1/feeds/articles').set(auth).expect(200);

    const counting = prismaMock.$queryRaw.mock.calls
      .map(c => (c[0] as TemplateStringsArray).join(' '))
      .filter(s => /COUNT\(DISTINCT/.test(s));
    expect(counting).toHaveLength(1);
    expect(counting[0]).toMatch(/FILTER/);
  });

  it('serves an empty river without touching the database', async () => {
    prismaMock.feedSubscription.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/v1/feeds/articles').set(auth).expect(200);
    expect(res.body).toMatchObject({ articles: [], total: 0, unread: 0, hasMore: false });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});

/**
 * The Site filter narrows the query, not the response.
 *
 * It used to sift the loaded page in the client, which meant it could only ever
 * offer a site it had already dealt a card from - so filtering down to a
 * publisher that had been quiet for a few pages meant paging the river until one
 * of its articles appeared, at which point the filter had nothing left to do.
 *
 * These assert the scope reaches the subscription lookup, because that is what
 * everything downstream is derived from: the feed ids the page query runs
 * against, and the totals the client pages by.
 */
describe('feed scope — the Site filter', () => {
  const scopeArg = () => prismaMock.feedSubscription.findMany.mock.calls.at(-1)![0].where;

  function rawResults() {
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (/DISTINCT ON/.test(sql)) return Promise.resolve([]);
      return Promise.resolve([{ total: BigInt(0), unread: BigInt(0) }]);
    });
  }

  it('narrows the subscriptions to the requested feed', async () => {
    rawResults();
    await request(app).get('/api/v1/feeds/articles?feed=sub-7').set(auth).expect(200);
    expect(scopeArg()).toMatchObject({ userId: ME, id: 'sub-7' });
  });

  // A site lives inside a category rather than beside one, so the two filters
  // intersect. Dropping either would answer a question nobody asked.
  it('composes with the category filter', async () => {
    rawResults();
    await request(app).get('/api/v1/feeds/articles?folder=f1&feed=sub-7').set(auth).expect(200);
    expect(scopeArg()).toMatchObject({ userId: ME, feedFolderId: 'f1', id: 'sub-7' });
  });

  // The scope is always tied to the signed-in user, so a subscription id
  // belonging to someone else matches nothing rather than leaking their feed.
  // That is why there is no separate ownership check to forget.
  it('keeps the scope bound to the caller', async () => {
    rawResults();
    await request(app).get('/api/v1/feeds/articles?feed=someone-elses-sub').set(auth).expect(200);
    expect(scopeArg().userId).toBe(ME);
  });

  it('leaves the whole river unscoped when no site is picked', async () => {
    rawResults();
    await request(app).get('/api/v1/feeds/articles').set(auth).expect(200);
    expect(scopeArg()).not.toHaveProperty('id');
  });

  // 'all' is what the client sends for "no site", the same sentinel `folder`
  // already uses. Treating it as an id would filter to a subscription that
  // cannot exist and answer with an empty feed.
  it('treats "all" as no site at all', async () => {
    rawResults();
    await request(app).get('/api/v1/feeds/articles?feed=all').set(auth).expect(200);
    expect(scopeArg()).not.toHaveProperty('id');
  });

  // A filter that narrows what you are reading has to narrow what a button does
  // to it: "mark all read" from inside one site must not clear every other one.
  it('scopes mark-all-read to the site as well as the category', async () => {
    prismaMock.feedItem.findMany.mockResolvedValue([]);
    await request(app)
      .post('/api/v1/feeds/articles/read-all')
      .set(auth)
      .send({ folder: 'f1', feed: 'sub-7' })
      .expect(200);
    expect(scopeArg()).toMatchObject({ userId: ME, feedFolderId: 'f1', id: 'sub-7' });
  });

  it('scopes the new-article count to the site', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ count: BigInt(0) }]);
    await request(app)
      .get('/api/v1/feeds/articles/new-count?since=2026-08-01T00:00:00.000Z&feed=sub-7')
      .set(auth)
      .expect(200);
    expect(scopeArg()).toMatchObject({ userId: ME, id: 'sub-7' });
  });
});
