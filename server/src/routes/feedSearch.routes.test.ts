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

/**
 * Subscribes the user to `urls` and gives each a Feed row.
 *
 * The Feed table on a real instance also holds every feed *other* people follow;
 * the mock can't model that, because it ignores where clauses. So the tests
 * below assert on the feed ids the route hands to SQL rather than on what comes
 * back — which is the stronger check anyway: it fails if the route ever stops
 * narrowing, whether or not another user's feed happens to match today.
 */
function withSubscriptions(urls: string[]) {
  prismaMock.feedSubscription.findMany.mockResolvedValue(
    urls.map(url => ({ url, name: '' })),
  );
  prismaMock.feed.findMany.mockResolvedValue(
    urls.map((url, i) => ({ id: `feed-${i}`, fetchUrl: url, title: '' })),
  );
}

/** The values Prisma was handed for the search query's bound parameters. */
function queryValues(): unknown[] {
  const call = prismaMock.$queryRaw.mock.calls[0];
  return call ? call.slice(1) : [];
}

/** The SQL text around those parameters, with the bound values as `?`. */
function querySql(): string {
  const call = prismaMock.$queryRaw.mock.calls[0];
  return call ? (call[0] as unknown as string[]).join('?') : '';
}

describe('GET /api/v1/feeds/search — scoping', () => {
  // The one that matters. FeedItem rows are shared across every account on the
  // instance and carry no userId, so nothing about the table itself stops a
  // search reading articles from feeds this user has never heard of. The only
  // thing that does is the route deriving its feed ids from FeedSubscription.
  it('resolves the feed list from this user’s subscriptions alone', async () => {
    withSubscriptions(['https://cascadedaily.com/feed']);

    const res = await request(app)
      .get('/api/v1/feeds/search?q=schools closing').set(auth);

    expect(res.status).toBe(200);
    expect(prismaMock.feedSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
    // The feed ids reaching SQL are exactly the subscribed ones.
    expect(queryValues()).toContainEqual(['feed-0']);
  });

  it('never queries when the user subscribes to nothing', async () => {
    prismaMock.feedSubscription.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/v1/feeds/search?q=schools').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.articles).toEqual([]);
    // Not "returned nothing" — never asked. An unscoped query that happened to
    // match nothing today would pass a weaker assertion than this one.
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('scopes by feed id before anything else can widen the search', async () => {
    withSubscriptions(['https://a.example/feed', 'https://b.example/feed']);

    await request(app).get('/api/v1/feeds/search?q=budget').set(auth);

    const ids = queryValues().find(v => Array.isArray(v)) as string[];
    expect(ids).toEqual(['feed-0', 'feed-1']);
  });

  it('requires a signed-in user', async () => {
    const res = await request(app).get('/api/v1/feeds/search?q=schools');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/feeds/search — query handling', () => {
  beforeEach(() => withSubscriptions(['https://cascadedaily.com/feed']));

  it('passes a prefixed AND query to Postgres', async () => {
    await request(app).get('/api/v1/feeds/search?q=two schools clos').set(auth);
    expect(queryValues()).toContain('two & schools & clos:*');
  });

  it('answers a too-short query without touching the database', async () => {
    const res = await request(app).get('/api/v1/feeds/search?q=a').set(auth);
    expect(res.body.articles).toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers a query of pure punctuation without touching the database', async () => {
    const res = await request(app).get('/api/v1/feeds/search?q=%26%26%26').set(auth);
    expect(res.body.articles).toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('escapes LIKE wildcards in a tag search', async () => {
    await request(app).get('/api/v1/feeds/search?mode=tag&q=100%25').set(auth);
    expect(queryValues()).toContain('100\\%%');
  });

  it('caps the number of results it will return', async () => {
    await request(app).get('/api/v1/feeds/search?q=schools&limit=500').set(auth);
    expect(queryValues()).toContain(25);
  });
});

describe('GET /api/v1/feeds/search — results', () => {
  it('names the source the way the river does', async () => {
    prismaMock.feedSubscription.findMany.mockResolvedValue([
      { url: 'https://cascadedaily.com/feed', name: 'Cascade Daily' },
    ]);
    prismaMock.feed.findMany.mockResolvedValue([
      { id: 'feed-0', fetchUrl: 'https://cascadedaily.com/feed', title: 'Cascade Daily News' },
    ]);
    prismaMock.$queryRaw.mockResolvedValue([{
      id: 'item-1',
      title: 'District votes to close two schools',
      link: 'https://cascadedaily.com/schools',
      feedId: 'feed-0',
      pubDate: new Date('2026-03-02'),
      categories: ['Education'],
      rank: 0.6,
    }]);

    const res = await request(app).get('/api/v1/feeds/search?q=schools').set(auth);

    expect(res.body.articles).toHaveLength(1);
    // The subscription's own name wins over the publisher's title.
    expect(res.body.articles[0]).toMatchObject({
      id: 'item-1',
      title: 'District votes to close two schools',
      url: 'https://cascadedaily.com/schools',
      source: 'Cascade Daily',
      categories: ['Education'],
    });
  });

  it('falls back to the hostname when neither name is set', async () => {
    prismaMock.feedSubscription.findMany.mockResolvedValue([
      { url: 'https://cascadedaily.com/feed', name: '' },
    ]);
    prismaMock.feed.findMany.mockResolvedValue([
      { id: 'feed-0', fetchUrl: 'https://cascadedaily.com/feed', title: '' },
    ]);
    prismaMock.$queryRaw.mockResolvedValue([{
      id: 'item-1', title: 'A headline', link: 'https://cascadedaily.com/a',
      feedId: 'feed-0', pubDate: null, categories: [], rank: 0.1,
    }]);

    const res = await request(app).get('/api/v1/feeds/search?q=headline').set(auth);
    expect(res.body.articles[0].source).toBe('cascadedaily.com');
  });
});

describe('GET /api/v1/feeds/search — reads the archive', () => {
  // v1.24.0 moved the corpus. FeedItem holds an article only for as long as its
  // publisher lists it plus a week, so searching it meant this route could only
  // ever answer for the last fortnight — while its own docblock promised "the
  // whole archive". These pin the query at the table that can keep that promise.
  //
  // They assert on SQL text, so they check shape and not meaning: the mock runs
  // no SQL. That is still the right check for this change, because what changed
  // is which table is named and how the scoping is joined.

  it('searches ArticleArchive rather than the river', async () => {
    withSubscriptions(['https://cascadedaily.com/feed']);
    await request(app).get('/api/v1/feeds/search?q=schools').set(auth).expect(200);

    const sql = querySql();
    expect(sql).toContain('FROM "ArticleArchive"');
    // Reaching back into FeedItem would undo the split: the river is quick only
    // because it stays small, and three of its queries have no date bound.
    expect(sql).not.toContain('FROM "FeedItem"');
  });

  it('scopes results to the reader’s own feeds through the join table', async () => {
    withSubscriptions(['https://cascadedaily.com/feed', 'https://example.com/rss']);
    await request(app).get('/api/v1/feeds/search?q=schools').set(auth).expect(200);

    // The archive is deduped instance-wide and carries no userId, so the join
    // table is the only thing standing between "search your feeds" and "search
    // everything this instance ever fetched".
    expect(querySql()).toContain('"ArticleArchiveFeed"');
    expect(queryValues()).toContainEqual(['feed-0', 'feed-1']);
  });

  it('no longer needs DISTINCT ON, because the archive is deduped on write', async () => {
    withSubscriptions(['https://cascadedaily.com/feed']);
    await request(app).get('/api/v1/feeds/search?q=schools').set(auth).expect(200);

    // One article is one row here, keyed on articleKey. Dropping DISTINCT ON is
    // what stops a deeper corpus costing more: it was a full sort of every
    // matching row, in a query whose LIMIT is applied last and so could never
    // cut it short.
    expect(querySql()).not.toContain('DISTINCT ON');
  });

  it('searches the archive by tag too', async () => {
    withSubscriptions(['https://cascadedaily.com/feed']);
    await request(app).get('/api/v1/feeds/search?q=games&mode=tag').set(auth).expect(200);

    const sql = querySql();
    expect(sql).toContain('FROM "ArticleArchive"');
    expect(sql).toContain('"ArticleArchiveFeed"');
  });
});
