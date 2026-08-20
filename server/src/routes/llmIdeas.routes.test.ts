import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Must be registered before app.ts is imported, so every route module resolves
// './lib/prisma' to the mock.
vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

// The two things that would otherwise leave the machine: the model call and the
// decryption of a stored key. Everything else in the route — the feed planner,
// the archive search, the joining of picks back onto hits — is the real code.
vi.mock('../lib/llm/chat', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/llm/chat')>()),
  completeChat: vi.fn(),
}));
vi.mock('../lib/llm/credentials', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/llm/credentials')>()),
  resolveCredential: vi.fn(),
}));

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';
import { clearTrustCache } from '../lib/trust';
import { completeChat } from '../lib/llm/chat';
import { resolveCredential } from '../lib/llm/credentials';
import { PROVIDERS } from '../lib/llm/providers';

const USER = 'user-id';
const auth = { Authorization: `Bearer ${signAccess(USER)}` };

const chat = vi.mocked(completeChat);
const credential = vi.mocked(resolveCredential);

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({
    id: USER, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false, username: 'writer',
  });
  credential.mockResolvedValue({
    id: 'cred-1',
    provider: PROVIDERS.anthropic,
    apiKey: 'sk-test',
    baseUrl: '',
    model: 'claude-opus-5',
  });
});

/** One subscribed feed holding one article, which the planner will find. */
function withArchive(rows: { title: string; link: string; snippet: string }[]) {
  prismaMock.feedSubscription.count.mockResolvedValue(1);
  prismaMock.feedSubscription.findMany.mockResolvedValue([
    { url: 'https://news.test/feed.xml', name: 'The Test' },
  ]);
  prismaMock.feed.findMany.mockResolvedValue([
    { id: 'feed-0', fetchUrl: 'https://news.test/feed.xml', title: 'The Test' },
  ]);
  prismaMock.$queryRaw.mockResolvedValue(rows.map((r, i) => ({
    id: r.link, linkKey: r.link, title: r.title, link: r.link,
    feedId: 'feed-0', pubDate: new Date('2026-08-01'), snippet: r.snippet,
    content: null, rank: 1 - i * 0.1,
  })));
}

/**
 * The three calls a turn with a feed makes, in order: the search planner, the
 * ideas pass, and the relevance screen over what came out of it.
 */
function replies(plan: string, ideas: string, screen = '{"keep":[{"n":1,"why":""}]}') {
  chat.mockResolvedValueOnce(plan).mockResolvedValueOnce(ideas).mockResolvedValueOnce(screen);
}

describe('POST /api/v1/llm/ideas', () => {
  it('returns angles, questions and related articles', async () => {
    withArchive([
      { title: 'Feed readers are back', link: 'https://news.test/back', snippet: 'Numbers.' },
    ]);
    replies(
      '{"search": true, "queries": ["RSS"]}',
      JSON.stringify({
        summary: 'A piece about feed readers.',
        angles: [{ title: 'RSS never died', detail: 'It stopped being a product.' }],
        questions: ['How many feeds does a reader keep?'],
        related: [{ url: 'https://news.test/back', why: 'Has the numbers.' }],
      }),
      // Keeps it and says nothing, so the ideas pass's own line survives.
      '{"keep":[{"n":1}]}',
    );

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS', title: '', body: '<p>Draft.</p>' });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('A piece about feed readers.');
    expect(res.body.angles).toEqual([{ title: 'RSS never died', detail: 'It stopped being a product.' }]);
    expect(res.body.questions).toEqual(['How many feeds does a reader keep?']);
    // The title and publication come from the archive row, not from the reply.
    expect(res.body.related).toEqual([{
      title: 'Feed readers are back',
      url: 'https://news.test/back',
      source: 'The Test',
      pubDate: new Date('2026-08-01').toISOString(),
      why: 'Has the numbers.',
    }]);
  });

  // The whole point of joining picks back onto the hits: a URL the model made
  // up has no row to join to, so it cannot reach the author as a link.
  it('drops a URL the model invented', async () => {
    withArchive([
      { title: 'Feed readers are back', link: 'https://news.test/back', snippet: 'Numbers.' },
    ]);
    replies(
      '{"search": true, "queries": ["RSS"]}',
      JSON.stringify({
        angles: [{ title: 'One', detail: 'Two' }],
        related: [
          { url: 'https://news.test/back', why: 'Real.' },
          { url: 'https://news.test/never-existed', why: 'Invented.' },
        ],
      }),
    );

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS', body: '' });

    expect(res.status).toBe(200);
    expect(res.body.related.map((a: { url: string }) => a.url)).toEqual(['https://news.test/back']);
  });

  // Losing every article the search found because the model put them under the
  // wrong key would be the wrong way to fail: the author asked for these. They
  // go through the screen like everything else, and its line is what they carry.
  it('falls back to the search hits when the model picks none', async () => {
    withArchive([
      { title: 'Feed readers are back', link: 'https://news.test/back', snippet: 'Numbers.' },
    ]);
    replies(
      '{"search": true, "queries": ["RSS"]}',
      '{"angles":[{"title":"One","detail":"Two"}]}',
      '{"keep":[{"n":1,"why":"Has the subscriber numbers."}]}',
    );

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS' });

    expect(res.status).toBe(200);
    expect(res.body.related).toEqual([{
      title: 'Feed readers are back',
      url: 'https://news.test/back',
      source: 'The Test',
      pubDate: new Date('2026-08-01').toISOString(),
      why: 'Has the subscriber numbers.',
    }]);
  });

  // The whole point of the second opinion: a keyword search over a year of
  // someone's reading turns up coincidences, and the author should not have to
  // filter them out by opening them.
  it('drops an article the relevance screen rejects', async () => {
    withArchive([
      { title: 'Feed readers are back', link: 'https://news.test/back', snippet: 'Numbers.' },
      { title: 'RSS the shipping firm posts a loss', link: 'https://news.test/rss-plc', snippet: 'Freight.' },
    ]);
    replies(
      '{"search": true, "queries": ["RSS"]}',
      JSON.stringify({
        angles: [{ title: 'One', detail: 'Two' }],
        related: [
          { url: 'https://news.test/back', why: 'Real.' },
          { url: 'https://news.test/rss-plc', why: 'Shares a word.' },
        ],
      }),
      '{"keep":[{"n":1,"why":"The only one about feed readers."}]}',
    );

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS readers' });

    expect(res.status).toBe(200);
    expect(res.body.related).toEqual([{
      title: 'Feed readers are back',
      url: 'https://news.test/back',
      source: 'The Test',
      pubDate: new Date('2026-08-01').toISOString(),
      why: 'The only one about feed readers.',
    }]);
  });

  it('returns nothing when the screen keeps nothing', async () => {
    withArchive([
      { title: 'RSS the shipping firm posts a loss', link: 'https://news.test/rss-plc', snippet: 'Freight.' },
    ]);
    replies(
      '{"search": true, "queries": ["RSS"]}',
      '{"angles":[{"title":"One","detail":"Two"}],"related":[{"url":"https://news.test/rss-plc","why":"?"}]}',
      '{"keep":[]}',
    );

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS readers' });

    expect(res.status).toBe(200);
    expect(res.body.related).toEqual([]);
    // The screen judges the reading list, not the post: the angles are untouched.
    expect(res.body.angles).toHaveLength(1);
  });

  // Deciding to show nothing and failing to decide are different. An unreadable
  // screen leaves the ideas model's own picks standing...
  it('keeps the picks when the screen cannot be read', async () => {
    withArchive([
      { title: 'Feed readers are back', link: 'https://news.test/back', snippet: 'Numbers.' },
    ]);
    replies(
      '{"search": true, "queries": ["RSS"]}',
      '{"angles":[{"title":"One","detail":"Two"}],"related":[{"url":"https://news.test/back","why":"Real."}]}',
      'I am not sure which of these are relevant.',
    );

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS readers' });

    expect(res.status).toBe(200);
    expect(res.body.related.map((a: { why: string }) => a.why)).toEqual(['Real.']);
  });

  // ...but not an unscreened keyword fallback, which no judgement has touched.
  it('drops the fallback entirely when the screen cannot be read', async () => {
    withArchive([
      { title: 'RSS the shipping firm posts a loss', link: 'https://news.test/rss-plc', snippet: 'Freight.' },
    ]);
    replies(
      '{"search": true, "queries": ["RSS"]}',
      '{"angles":[{"title":"One","detail":"Two"}]}',
      'no idea',
    );

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS readers' });

    expect(res.status).toBe(200);
    expect(res.body.related).toEqual([]);
  });

  it('answers without a feed when the account has no subscriptions', async () => {
    prismaMock.feedSubscription.count.mockResolvedValue(0);
    chat.mockResolvedValueOnce('{"angles":[{"title":"One","detail":"Two"}]}');

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS' });

    expect(res.status).toBe(200);
    expect(res.body.related).toEqual([]);
    // The planner is a paid call. Nothing to search means nothing to plan.
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('refuses when there is nothing at all to work from', async () => {
    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: '   ', title: '', body: '<p><br></p>' });

    expect(res.status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });

  // A draft with no brief is a real case - "what else could I say here" - so the
  // body alone has to be enough.
  it('works from the draft alone', async () => {
    prismaMock.feedSubscription.count.mockResolvedValue(0);
    chat.mockResolvedValueOnce('{"angles":[{"title":"One","detail":"Two"}]}');

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: '', title: 'On feed readers', body: '<p>Half a page about RSS.</p>' });

    expect(res.status).toBe(200);
    expect(res.body.angles).toHaveLength(1);
    const sent = chat.mock.calls[0][0].turns[0].content;
    expect(sent).toContain('Half a page about RSS.');
    expect(sent).toContain('On feed readers');
  });

  it('reports a reply it could not read rather than an empty report', async () => {
    prismaMock.feedSubscription.count.mockResolvedValue(0);
    chat.mockResolvedValueOnce('I have thought about it and I have no ideas.');

    const res = await request(app).post('/api/v1/llm/ideas').set(auth)
      .send({ brief: 'Something about RSS' });

    expect(res.status).toBe(502);
  });

  it('needs a signed-in user', async () => {
    const res = await request(app).post('/api/v1/llm/ideas').send({ brief: 'x' });
    expect(res.status).toBe(401);
  });
});
