import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

// The shell is fetched from the nginx container over the network. Stubbed to a
// minimal template carrying both markers, so these tests exercise what gets
// injected rather than how it is fetched.
vi.mock('../lib/htmlShell', () => ({
  renderShell: vi.fn(async (head: string, body = '') =>
    `<!DOCTYPE html><html><head>${head}</head><body><div id="root"></div>${body}</body></html>`),
  clearShellCache: vi.fn(),
}));

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';

const AUTHOR = {
  id: 'u1', username: 'dan', firstName: 'Dan', lastName: 'Tucker',
  avatar: null, coverImage: null, createdAt: new Date('2026-01-01'),
};

const POST = {
  title: 'On rewriting my editor',
  slug: 'on-rewriting-my-editor',
  body: '<p>The editor was fine. I rewrote it anyway.</p>',
  excerpt: 'The editor was fine.',
  heroImage: '',
  tags: ['editors'],
  visibility: 'public',
  commentsEnabled: true,
  articleKey: 'key-1',
  publishedAt: new Date('2026-08-01T10:00:00Z'),
  updatedAt: new Date('2026-08-02T10:00:00Z'),
};

beforeEach(() => {
  resetPrismaMock();
  prismaMock.user.findFirst.mockResolvedValue(AUTHOR);
});

describe('GET /u/:username/:slug', () => {
  it('gives the post its own title, description and canonical', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue(POST);

    const res = await request(app).get('/u/dan/on-rewriting-my-editor').expect(200);

    expect(res.text).toContain('<title>On rewriting my editor · Newt</title>');
    expect(res.text).toContain('<meta name="description" content="The editor was fine.">');
    expect(res.text).toMatch(/<link rel="canonical" href="[^"]*\/u\/dan\/on-rewriting-my-editor">/);
    expect(res.text).toContain('property="og:type" content="article"');
  });

  it('is indexable — there is no per-user opt-out, so public means public', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue(POST);

    const res = await request(app).get('/u/dan/on-rewriting-my-editor').expect(200);

    expect(res.text).not.toContain('name="robots"');
  });

  it('escapes a title that tries to break out of the tag it lands in', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue({
      ...POST, title: '</title><script>alert(1)</script>',
    });

    const res = await request(app).get('/u/dan/x').expect(200);

    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('escapes a title that tries to break out of the JSON-LD block', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue({
      ...POST, title: '</script><script>alert(1)</script>',
    });

    const res = await request(app).get('/u/dan/x').expect(200);

    // The only closing script tags are the ones the renderer wrote itself.
    expect(res.text).not.toMatch(/<script>alert/);
    expect(res.text).toContain('\\u003c');
  });

  it('404s a friends-only post, because it renders the anonymous view', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue({ ...POST, visibility: 'friends' });

    await request(app).get('/u/dan/on-rewriting-my-editor').expect(404);
  });

  it('404s a draft', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue({ ...POST, visibility: 'private' });

    await request(app).get('/u/dan/on-rewriting-my-editor').expect(404);
  });

  it('404s rather than soft-404ing, so un-publishing actually leaves the index', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/u/dan/gone');

    expect(res.status).toBe(404);
    expect(res.text).toContain('noindex');
  });

  it('404s an unknown author without looking for a post', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);

    await request(app).get('/u/nobody/whatever').expect(404);
    expect(prismaMock.blogPost.findFirst).not.toHaveBeenCalled();
  });
});

describe('comments on a post document', () => {
  const COMMENT = {
    id: 'c1', parentId: null, title: null,
    body: '<p>Good post.</p>', createdAt: new Date('2026-08-03T10:00:00Z'),
    user: { id: 'u2', username: 'sam', firstName: 'Sam', lastName: null, avatar: null },
  };

  it('renders public comments into the post, and counts them in the structured data', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue(POST);
    prismaMock.comment.findMany.mockResolvedValue([COMMENT]);

    const res = await request(app).get('/u/dan/on-rewriting-my-editor').expect(200);

    expect(res.text).toContain('Good post.');
    expect(res.text).toContain('Sam');
    expect(res.text).toContain('"commentCount":1');
  });

  it('asks only for public, undeleted comments', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue(POST);

    await request(app).get('/u/dan/on-rewriting-my-editor').expect(200);

    expect(prismaMock.comment.findMany.mock.calls[0][0].where).toMatchObject({
      articleKey: 'key-1', visibility: 'public', deletedAt: null,
    });
  });

  it('does not fetch comments at all when the author turned them off', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue({ ...POST, commentsEnabled: false });

    await request(app).get('/u/dan/on-rewriting-my-editor').expect(200);

    expect(prismaMock.comment.findMany).not.toHaveBeenCalled();
  });

  it('cannot be escaped by a comment carrying a closing noscript tag', async () => {
    prismaMock.blogPost.findFirst.mockResolvedValue(POST);
    prismaMock.comment.findMany.mockResolvedValue([
      { ...COMMENT, body: '<p>x</p></noscript><img src=x onerror=alert(1)>' },
    ]);

    const res = await request(app).get('/u/dan/on-rewriting-my-editor').expect(200);

    // Exactly one </noscript>: the one that closes the block we opened.
    expect(res.text.match(/<\/noscript>/g)).toHaveLength(1);
  });
});

describe('GET /u/:username — the crawlable archive', () => {
  const SUMMARY = {
    title: 'A post', slug: 'a-post', excerpt: 'Some words.',
    publishedAt: new Date('2026-08-01T10:00:00Z'),
  };

  it('links every post with a real anchor, which infinite scroll never did', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([SUMMARY]);
    prismaMock.blogPost.count.mockResolvedValue(1);

    const res = await request(app).get('/u/dan').expect(200);

    expect(res.text).toContain('href="/u/dan/a-post"');
    expect(res.text).toContain('property="og:type" content="profile"');
  });

  it('lists only public posts', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([]);
    prismaMock.blogPost.count.mockResolvedValue(0);

    await request(app).get('/u/dan').expect(200);

    expect(prismaMock.blogPost.findMany.mock.calls[0][0].where)
      .toMatchObject({ userId: 'u1', visibility: 'public' });
  });

  it('offers a next link while there are more pages', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([SUMMARY]);
    prismaMock.blogPost.count.mockResolvedValue(120);

    const res = await request(app).get('/u/dan').expect(200);

    expect(res.text).toContain('rel="next"');
    expect(res.text).not.toContain('rel="prev"');
  });

  it('404s a page past the end, so a crawler cannot walk ?page= forever', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([]);
    prismaMock.blogPost.count.mockResolvedValue(3);

    await request(app).get('/u/dan?page=99').expect(404);
  });

  it('declines the index entry for a profile with nothing on it', async () => {
    prismaMock.blogPost.findMany.mockResolvedValue([]);
    prismaMock.blogPost.count.mockResolvedValue(0);

    const res = await request(app).get('/u/dan').expect(200);

    expect(res.text).toContain('content="noindex, follow"');
  });
});

describe('GET /a/:id — a thread on somebody else\'s article', () => {
  const ID = Buffer.from('https://example.com/article').toString('base64url');

  it('is noindex, and carries no canonical pointing off-site', async () => {
    prismaMock.comment.findFirst.mockResolvedValue({ articleTitle: 'Someone else\'s article' });
    prismaMock.comment.count.mockResolvedValue(2);

    const res = await request(app).get(`/a/${ID}`).expect(200);

    expect(res.text).toContain('content="noindex, follow"');
    // Pairing noindex with a canonical aimed at a publisher we do not control
    // is a way to ask Google to drop *their* article. The canonical must stay
    // pointed at us.
    expect(res.text).not.toContain('canonical" href="https://example.com/article"');
    expect(res.text).toMatch(/<link rel="canonical" href="[^"]*\/a\//);
  });

  it('still renders unfurl meta, since a link preview ignores robots', async () => {
    prismaMock.comment.findFirst.mockResolvedValue({ articleTitle: 'A headline' });
    prismaMock.comment.count.mockResolvedValue(1);

    const res = await request(app).get(`/a/${ID}`).expect(200);

    expect(res.text).toContain('<title>A headline · Newt</title>');
    expect(res.text).toContain('og:description');
  });

  it('404s an id that is not an http URL', async () => {
    const bad = Buffer.from('javascript:alert(1)').toString('base64url');
    await request(app).get(`/a/${bad}`).expect(404);
  });
});
