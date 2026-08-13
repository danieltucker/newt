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
