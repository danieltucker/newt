import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

vi.mock('../lib/htmlShell', () => ({
  renderShell: vi.fn(async (head: string, body = '') =>
    `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`),
  clearShellCache: vi.fn(),
}));

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { MIN_TAG_POSTS_TO_INDEX, normalizeTag, tagPostsWhere } from '../lib/tags';
import { MIN_POSTS_FOR_RECENT } from '../lib/recent';

const POST = {
  title: 'A post about editors',
  slug: 'a-post',
  excerpt: 'Words.',
  publishedAt: new Date('2026-08-01T10:00:00Z'),
  user: { id: 'u1', username: 'dan', firstName: 'Dan', lastName: null, avatar: null },
};

beforeEach(() => {
  resetPrismaMock();
});

describe('normalizeTag', () => {
  it('finds the stored tag however the link spelled it', () => {
    expect(normalizeTag('News')).toBe('news');
    expect(normalizeTag('#News')).toBe('news');
  });

  it('rejects something that is not a tag', () => {
    expect(normalizeTag('   ')).toBeNull();
  });
});

describe('tagPostsWhere', () => {
  it('is public posts by established authors, never ingested feed items', () => {
    const where = tagPostsWhere('news', new Date('2026-08-10T12:00:00Z'));
    expect(where.visibility).toBe('public');
    expect(where.tags).toEqual({ has: 'news' });
    expect(where.user.bannedAt).toBeNull();
  });
});

describe('GET /t/:tag', () => {
  it('lists every author\'s posts under the word, with links to both', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([POST]);
    prismaMock.blogPost.count.mockResolvedValue(5);

    const res = await request(app).get('/t/editors').expect(200);

    expect(res.text).toContain('<title>#editors · Newt</title>');
    expect(res.text).toContain('href="/u/dan/a-post"');
    expect(res.text).toContain('/u/dan"');
  });

  it('offers itself as a feed, which is what makes a tag followable', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([POST]);
    prismaMock.blogPost.count.mockResolvedValue(5);

    const res = await request(app).get('/t/editors').expect(200);

    expect(res.text).toMatch(/rel="alternate" type="application\/rss\+xml"[^>]*\/t\/editors\/feed\.xml/);
  });

  it('declines the index entry while the tag is still thin', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([POST]);
    prismaMock.blogPost.count.mockResolvedValue(MIN_TAG_POSTS_TO_INDEX - 1);

    const res = await request(app).get('/t/editors').expect(200);

    expect(res.text).toContain('content="noindex, follow"');
  });

  it('asks to be indexed once enough posts carry it', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([POST]);
    prismaMock.blogPost.count.mockResolvedValue(MIN_TAG_POSTS_TO_INDEX);

    const res = await request(app).get('/t/editors').expect(200);

    expect(res.text).not.toContain('name="robots"');
  });

  it('normalises the tag out of the URL, so /t/News finds "news"', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([]);
    prismaMock.blogPost.count.mockResolvedValue(0);

    await request(app).get('/t/News').expect(200);

    expect(prismaMock.blogPost.findMany.mock.calls[0][0].where.tags).toEqual({ has: 'news' });
  });

  it('404s a page past the end', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([]);
    prismaMock.blogPost.count.mockResolvedValue(2);

    await request(app).get('/t/editors?page=50').expect(404);
  });
});

describe('GET /t/:tag/feed.xml', () => {
  it('renders the tag as RSS', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([{
      ...POST, body: '<p>Body.</p>', heroImage: '', tags: ['editors'],
    }]);

    const res = await request(app).get('/t/editors/feed.xml').expect(200);

    expect(res.headers['content-type']).toContain('rss');
    expect(res.text).toContain('<title>#editors on Newt</title>');
    expect(res.text).toContain('/u/dan/a-post');
  });
});

describe('GET /recent — the gated front door', () => {
  it('requires 2FA of the authors it lists', async () => {
    prismaMock.blogPost.groupBy.mockResolvedValue([]);

    await request(app).get('/recent').expect(200);

    expect(prismaMock.blogPost.groupBy.mock.calls[0][0].where.user)
      .toMatchObject({ totpEnabled: true, bannedAt: null });
  });

  it('requires more than one post, so a drive-by account cannot buy a slot', async () => {
    prismaMock.blogPost.groupBy.mockResolvedValue([]);

    await request(app).get('/recent').expect(200);

    expect(prismaMock.blogPost.groupBy.mock.calls[0][0].having)
      .toMatchObject({ userId: { _count: { gte: MIN_POSTS_FOR_RECENT } } });
  });

  it('drops an author a moderator has acted on recently', async () => {
    prismaMock.blogPost.groupBy.mockResolvedValue([
      { userId: 'good', _count: { _all: 4 } },
      { userId: 'bad', _count: { _all: 9 } },
    ]);
    prismaMock.report.findMany.mockResolvedValue([{ subjectId: 'bad' }]);
    prismaMock.blogPost.findMany.mockResolvedValue([]);

    await request(app).get('/recent').expect(200);

    expect(prismaMock.blogPost.findMany.mock.calls[0][0].where.userId)
      .toEqual({ in: ['good'] });
  });

  it('counts upheld reports only — being reported is not evidence', async () => {
    prismaMock.blogPost.groupBy.mockResolvedValue([{ userId: 'u1', _count: { _all: 3 } }]);
    prismaMock.blogPost.findMany.mockResolvedValue([]);

    await request(app).get('/recent').expect(200);

    expect(prismaMock.report.findMany.mock.calls[0][0].where.status).toBe('resolved');
  });

  it('renders an empty page rather than failing when nobody qualifies', async () => {
    prismaMock.blogPost.groupBy.mockResolvedValue([]);

    const res = await request(app).get('/recent').expect(200);

    expect(res.text).toContain('Recent posts');
    expect(prismaMock.blogPost.findMany).not.toHaveBeenCalled();
  });
});
