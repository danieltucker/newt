import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { clearSitemapCache } from './seo';
import { indexableAuthorWhere, NEW_ACCOUNT_MS } from '../lib/trust';

const AI_ENV = process.env.AI_CRAWLERS;

beforeEach(() => {
  resetPrismaMock();
  clearSitemapCache();
  delete process.env.AI_CRAWLERS;
});

afterEach(() => {
  if (AI_ENV === undefined) delete process.env.AI_CRAWLERS;
  else process.env.AI_CRAWLERS = AI_ENV;
});

describe('robots.txt', () => {
  it('points at the sitemap', async () => {
    const res = await request(app).get('/robots.txt').expect(200);
    expect(res.text).toMatch(/^Sitemap: https?:\/\/.+\/sitemap\.xml$/m);
  });

  it('blocks model-training crawlers by default', async () => {
    const res = await request(app).get('/robots.txt').expect(200);
    expect(res.text).toContain('User-agent: GPTBot');
    expect(res.text).toContain('User-agent: ClaudeBot');
    expect(res.text).toContain('User-agent: CCBot');
  });

  it('lets them in when the deployment says so', async () => {
    process.env.AI_CRAWLERS = 'allow';
    const res = await request(app).get('/robots.txt').expect(200);
    expect(res.text).not.toContain('GPTBot');
  });

  it('leaves /a/ crawlable, so its noindex can actually be read', async () => {
    // Disallowing a page is how a URL ends up indexed *without* its noindex
    // being seen. The thread pages must stay fetchable.
    const res = await request(app).get('/robots.txt').expect(200);
    expect(res.text).not.toMatch(/^Disallow: \/a\//m);
  });

  it('keeps crawlers out of the API but lets the blog feeds through', async () => {
    const res = await request(app).get('/robots.txt').expect(200);
    expect(res.text).toContain('Disallow: /api/');
    expect(res.text).toContain('Allow: /api/v1/blogs/*/feed.xml$');
  });
});

describe('indexableAuthorWhere', () => {
  const now = new Date('2026-08-10T12:00:00Z');

  it('admits an account that has been around a day', () => {
    const where = indexableAuthorWhere(now);
    expect(where.OR).toContainEqual({
      createdAt: { lte: new Date(now.getTime() - NEW_ACCOUNT_MS) },
    });
  });

  it('admits a 2FA account regardless of age, matching the trust ladder', () => {
    expect(indexableAuthorWhere(now).OR).toContainEqual({ totpEnabled: true });
  });

  it('never admits a banned account', () => {
    expect(indexableAuthorWhere(now).bannedAt).toBeNull();
  });
});

describe('sitemap', () => {
  it('is an index, so growing past one shard needs no resubmission', async () => {
    prismaMock.blogPost.count.mockResolvedValue(3);
    prismaMock.user.count.mockResolvedValue(2);
    prismaMock.blogPost.findFirst.mockResolvedValue({ updatedAt: new Date('2026-08-01') });

    const res = await request(app).get('/sitemap.xml').expect(200);

    expect(res.text).toContain('<sitemapindex');
    expect(res.text).toContain('/sitemap-posts-1.xml');
    expect(res.text).toContain('/sitemap-profiles-1.xml');
    expect(res.headers['content-type']).toContain('xml');
  });

  it('shards once there are more posts than a sitemap may hold', async () => {
    prismaMock.blogPost.count.mockResolvedValue(120_000);
    prismaMock.user.count.mockResolvedValue(1);
    prismaMock.blogPost.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/sitemap.xml').expect(200);

    expect(res.text).toContain('/sitemap-posts-3.xml');
    expect(res.text).not.toContain('/sitemap-posts-4.xml');
  });

  it('lists public posts by established authors, with an honest lastmod', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([
      { slug: 'a-post', updatedAt: new Date('2026-08-05T09:00:00Z'), user: { username: 'dan' } },
    ]);

    const res = await request(app).get('/sitemap-posts-1.xml').expect(200);

    expect(res.text).toContain('/u/dan/a-post</loc>');
    expect(res.text).toContain('<lastmod>2026-08-05T09:00:00.000Z</lastmod>');
    expect(prismaMock.blogPost.findMany.mock.calls[0][0].where).toMatchObject({
      visibility: 'public',
    });
  });

  it('applies the trust filter to the post query, not just the profile one', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([]);

    await request(app).get('/sitemap-posts-1.xml').expect(200);

    const where = prismaMock.blogPost.findMany.mock.calls[0][0].where;
    expect(where.user.bannedAt).toBeNull();
    expect(where.user.OR).toContainEqual({ totpEnabled: true });
  });

  it('emits a parseable <loc> for a username full of XML metacharacters', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([
      { slug: 's', updatedAt: new Date('2026-08-05'), user: { username: 'a&b<c>' } },
    ]);

    const res = await request(app).get('/sitemap-posts-1.xml').expect(200);

    // postPathFor percent-encodes the username before escapeXml ever sees it, so
    // the metacharacters are gone by then rather than escaped. Either route to a
    // valid document is fine; what must never appear is a raw one.
    expect(res.text).toContain('/u/a%26b%3Cc%3E/s</loc>');
    const loc = res.text.match(/<loc>([\s\S]*?)<\/loc>/)?.[1] ?? '';
    expect(loc).not.toMatch(/[&<>]/);
  });

  it('omits profiles with nothing published on them', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);

    await request(app).get('/sitemap-profiles-1.xml').expect(200);

    expect(prismaMock.user.findMany.mock.calls[0][0].where.blogPosts)
      .toMatchObject({ some: { visibility: 'public' } });
  });

  it('404s a shard name that is not a page number', async () => {
    await request(app).get('/sitemap-posts-abc.xml').expect(404);
  });
});
