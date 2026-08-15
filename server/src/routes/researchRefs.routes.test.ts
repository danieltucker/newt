import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

/**
 * What each URL is known to be, for this test.
 *
 * articleContextFor is stubbed rather than driven through the prisma mock
 * because the thing under test is not how an article is read — that has its own
 * rules about posts, feeds, comments and page fetches — but what the route does
 * with the answer. Returning null is the interesting half: it is how "Newt has
 * no record of this URL, and is not going to go and fetch one on a caller's
 * say-so" arrives at the route.
 */
const KNOWN: Record<string, { title: string }> = {
  'https://a.test/one': { title: 'The first piece' },
  'https://b.test/two': { title: 'The second piece' },
  'https://c.test/three': { title: 'The third piece' },
  'https://d.test/four': { title: 'The fourth piece' },
  'https://e.test/five': { title: 'The fifth piece' },
  'https://src.test/source': { title: 'The article this thread is about' },
};

vi.mock('../lib/llm/articleContext', () => ({
  articleContextFor: vi.fn(async (url: string) => {
    const known = KNOWN[url];
    return known ? { title: known.title, url, text: known.title, source: 'stored', comments: [] } : null;
  }),
  renderContext: (ctx: { title: string }) => `<article>${ctx.title}</article>`,
}));

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';

const ME = 'me-id';
const auth = { Authorization: `Bearer ${signAccess(ME)}` };

beforeEach(() => {
  resetPrismaMock();
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false, settings: {},
  });
  prismaMock.researchThread.count.mockResolvedValue(0);
  prismaMock.researchThread.create.mockResolvedValue({
    id: 'thread-1', title: 'A question', sourceUrl: '', sourceTitle: '',
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  });
  prismaMock.researchMessage.findMany.mockResolvedValue([]);
});

/** The `sources` array the route wrote onto the opening question. */
function storedRefs(): { url: string; title: string }[] {
  const arg = prismaMock.researchThread.create.mock.calls[0]?.[0] as
    { data: { messages: { create: { sources: { url: string; title: string }[] }[] } } };
  return arg.data.messages.create[0].sources;
}

describe('starting a thread with /reference attachments', () => {
  it('stores what was attached, with the titles it resolved', async () => {
    const res = await request(app).post('/api/v1/research/threads').set(auth).send({
      question: 'How do these two differ?',
      refs: ['https://a.test/one', 'https://b.test/two'],
    });

    expect(res.status).toBe(201);
    expect(storedRefs()).toEqual([
      expect.objectContaining({ url: 'https://a.test/one', title: 'The first piece' }),
      expect.objectContaining({ url: 'https://b.test/two', title: 'The second piece' }),
    ]);
  });

  // The point of resolving rather than trusting: a URL this account has no
  // record of is not a fetch instruction, it is a reference to nothing.
  it('drops a URL it has no record of instead of fetching it', async () => {
    const res = await request(app).post('/api/v1/research/threads').set(auth).send({
      question: 'What about this?',
      refs: ['https://a.test/one', 'https://evil.test/ssrf'],
    });

    expect(res.status).toBe(201);
    expect(storedRefs().map(r => r.url)).toEqual(['https://a.test/one']);
  });

  it('ignores anything that is not an http(s) article URL', async () => {
    const res = await request(app).post('/api/v1/research/threads').set(auth).send({
      question: 'What about this?',
      refs: ['file:///etc/passwd', 'javascript:alert(1)', 42, null, 'https://a.test/one'],
    });

    expect(res.status).toBe(201);
    expect(storedRefs().map(r => r.url)).toEqual(['https://a.test/one']);
  });

  // Each attachment is a whole article, re-sent on every follow-up, so the
  // ceiling is what stops one question becoming the most expensive request the
  // account has ever made.
  it('caps the list at four, whatever the client sends', async () => {
    const res = await request(app).post('/api/v1/research/threads').set(auth).send({
      question: 'Compare all of these',
      refs: [
        'https://a.test/one', 'https://b.test/two', 'https://c.test/three',
        'https://d.test/four', 'https://e.test/five',
      ],
    });

    expect(res.status).toBe(201);
    expect(storedRefs()).toHaveLength(4);
    expect(storedRefs().map(r => r.url)).not.toContain('https://e.test/five');
  });

  it('does not count the same article twice', async () => {
    const res = await request(app).post('/api/v1/research/threads').set(auth).send({
      question: 'This one again',
      refs: ['https://a.test/one', 'https://a.test/one'],
    });

    expect(res.status).toBe(201);
    expect(storedRefs().map(r => r.url)).toEqual(['https://a.test/one']);
  });

  // The thread's own source frames every turn already. Attaching it as well
  // would spend a whole article's worth of tokens saying the same thing twice.
  it('drops a reference to the article the thread is already about', async () => {
    const res = await request(app).post('/api/v1/research/threads').set(auth).send({
      question: 'Go deeper on this',
      url: 'https://src.test/source',
      refs: ['https://src.test/source', 'https://a.test/one'],
    });

    expect(res.status).toBe(201);
    expect(storedRefs().map(r => r.url)).toEqual(['https://a.test/one']);
  });

  it('starts a thread with no attachments at all, as it always did', async () => {
    const res = await request(app).post('/api/v1/research/threads').set(auth)
      .send({ question: 'Just a question' });

    expect(res.status).toBe(201);
    expect(storedRefs()).toEqual([]);
  });
});
