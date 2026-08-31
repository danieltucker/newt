import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';
import { clearTrustCache } from '../lib/trust';
import { canonicalArticleKey } from '../lib/comments';

const ME = 'me-id';
const auth = { Authorization: `Bearer ${signAccess(ME)}` };
const URL_A = 'https://example.com/a-piece';

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false,
  });
});

function saved(over: Record<string, unknown> = {}) {
  return {
    id: 'existing', userId: ME, url: URL_A, title: 'A piece', source: 'example.com',
    readTime: '', tag: '', notes: '', imageUrl: '', inLibrary: false, folderId: null,
    savedAt: new Date('2026-01-01'),
    ...over,
  };
}

// An article belongs in a place once. Saving it again is not an error - it is
// how the feed behaves when a publisher touches an article you already kept -
// so the copy that exists comes back rather than a second one being made.
describe('one copy per destination', () => {
  it('hands back the copy already in the reading list', async () => {
    prismaMock.readingListItem.findMany.mockResolvedValue([{ id: 'existing', url: URL_A }]);
    prismaMock.readingListItem.findFirst.mockResolvedValue(saved());

    const res = await request(app).post('/api/v1/reading-list')
      .set(auth).send({ url: URL_A, title: 'A piece' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'existing', duplicate: true });
    expect(prismaMock.readingListItem.create).not.toHaveBeenCalled();
  });

  // Same article, tracking junk on the end. The canonical key is what decides
  // which comment thread these two share, so it decides this too.
  it('recognises the same article under a tracking parameter', async () => {
    prismaMock.readingListItem.findMany.mockResolvedValue([{ id: 'existing', url: URL_A }]);
    prismaMock.readingListItem.findFirst.mockResolvedValue(saved());

    const res = await request(app).post('/api/v1/reading-list')
      .set(auth).send({ url: `${URL_A}?utm_source=newsletter`, title: 'A piece' });

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  // A shelf is a different place, so filing an article you have queued is a
  // real save rather than a duplicate.
  it('still saves when the copy is somewhere else', async () => {
    prismaMock.readingFolder.findFirst.mockResolvedValue({ id: 'shelf-1' });
    prismaMock.readingListItem.findMany.mockResolvedValue([]);   // nothing on that shelf
    prismaMock.readingListItem.create.mockResolvedValue(saved({ id: 'new', folderId: 'shelf-1' }));

    const res = await request(app).post('/api/v1/reading-list')
      .set(auth).send({ url: URL_A, title: 'A piece', folderId: 'shelf-1' });

    expect(res.status).toBe(201);
    // The destination is checked against the shelf, and applied in the create -
    // it used to take a second request to move it there.
    expect(prismaMock.readingListItem.findMany.mock.calls[0][0].where)
      .toMatchObject({ userId: ME, folderId: 'shelf-1' });
    expect(prismaMock.readingListItem.create.mock.calls[0][0].data)
      .toMatchObject({ folderId: 'shelf-1', inLibrary: true });
  });

  it('refuses to file onto a shelf that is not yours', async () => {
    prismaMock.readingFolder.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/reading-list')
      .set(auth).send({ url: URL_A, title: 'A piece', folderId: 'someone-elses' });

    expect(res.status).toBe(404);
    expect(prismaMock.readingListItem.create).not.toHaveBeenCalled();
  });

  // The other way an article reaches a shelf. Only reachable for pairs saved
  // twice before the rule existed, but those pairs exist.
  it('refuses a move into a shelf that already holds the article', async () => {
    prismaMock.readingFolder.findFirst.mockResolvedValue({ id: 'shelf-1' });
    prismaMock.readingListItem.findFirst
      .mockResolvedValueOnce(saved({ id: 'moving' }))          // the row being moved
      .mockResolvedValueOnce(saved({ id: 'already-there' }));  // what is on the shelf
    prismaMock.readingListItem.findMany.mockResolvedValue([{ id: 'already-there', url: URL_A }]);

    const res = await request(app).patch('/api/v1/reading-list/moving')
      .set(auth).send({ folderId: 'shelf-1' });

    expect(res.status).toBe(409);
    expect(prismaMock.readingListItem.update).not.toHaveBeenCalled();
  });
});

// The number on an article's Save pill. It is an aggregate over other people's
// Libraries, which are otherwise self-only, so what it must never do is grow
// into a list.
describe('save counts', () => {
  const URL_B = 'https://example.com/another';

  it('counts people rather than rows, by canonical key', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { articleKey: canonicalArticleKey(URL_A), n: 3 },
    ]);

    const res = await request(app).post('/api/v1/reading-list/counts')
      .set(auth).send({ urls: [URL_A, `${URL_A}?utm_source=newsletter`, URL_B] });

    expect(res.status).toBe(200);
    // Both spellings of the same article report the one count; the article
    // nobody has saved reports 0 rather than going missing from the response.
    expect(res.body.counts).toEqual({
      [URL_A]: 3,
      [`${URL_A}?utm_source=newsletter`]: 3,
      [URL_B]: 0,
    });

    const sql = prismaMock.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('COUNT(DISTINCT "userId")');
  });

  it('answers with numbers and nothing else', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { articleKey: canonicalArticleKey(URL_A), n: 2 },
    ]);

    const res = await request(app).post('/api/v1/reading-list/counts')
      .set(auth).send({ urls: [URL_A] });

    expect(Object.keys(res.body)).toEqual(['counts']);
    // No userId, no folder, no date - a count is the whole answer.
    expect(JSON.stringify(res.body)).not.toContain(ME);
  });

  it('rejects anything that is not a list of URLs', async () => {
    const res = await request(app).post('/api/v1/reading-list/counts')
      .set(auth).send({ urls: 'https://example.com/a-piece' });

    expect(res.status).toBe(400);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  // Junk in the list is dropped rather than failing the request: a screenful of
  // cards is counted in one call, and one odd link must not cost the rest their
  // numbers.
  it('drops non-http entries and counts the rest', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);

    const res = await request(app).post('/api/v1/reading-list/counts')
      .set(auth).send({ urls: ['javascript:alert(1)', 42, null, URL_A] });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ [URL_A]: 0 });
  });

  it('needs no query when every URL was junk', async () => {
    const res = await request(app).post('/api/v1/reading-list/counts')
      .set(auth).send({ urls: ['not-a-url'] });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({});
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('is not public', async () => {
    const res = await request(app).post('/api/v1/reading-list/counts')
      .send({ urls: [URL_A] });

    expect(res.status).toBe(401);
  });
});

// Clearing an article off the reading list. It files onto the Archived shelf
// rather than deleting the row, because the row is what holds the article's
// save count up - see the endpoint. What these pin down is that the count
// cannot move as a side effect of tidying up.
describe('archiving instead of deleting', () => {
  const SHELF = {
    id: 'archived-id', userId: ME, name: 'Archived', color: '#8B8D98',
    position: 3, system: 'archived', createdAt: new Date('2026-01-01'),
  };

  it('moves the row onto the Archived shelf and never deletes it', async () => {
    prismaMock.readingListItem.findFirst.mockResolvedValue(saved());
    prismaMock.readingFolder.findFirst.mockResolvedValue(SHELF);
    prismaMock.readingListItem.findMany.mockResolvedValue([]);
    prismaMock.readingListItem.update.mockResolvedValue(
      saved({ folderId: SHELF.id, inLibrary: true }));

    const res = await request(app).post('/api/v1/reading-list/existing/archive').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.item.folderId).toBe(SHELF.id);
    expect(res.body.folder.id).toBe(SHELF.id);
    // The whole point: the save count is a count of rows' owners, so a delete
    // here would take the article's number down for everyone.
    expect(prismaMock.readingListItem.delete).not.toHaveBeenCalled();
    expect(prismaMock.readingListItem.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.readingListItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { folderId: SHELF.id, inLibrary: true } }));
  });

  it('makes the shelf on first use', async () => {
    prismaMock.readingListItem.findFirst.mockResolvedValue(saved());
    prismaMock.readingFolder.findFirst.mockResolvedValue(null);
    prismaMock.readingFolder.count.mockResolvedValue(2);
    prismaMock.readingFolder.create.mockResolvedValue(SHELF);
    prismaMock.readingListItem.findMany.mockResolvedValue([]);
    prismaMock.readingListItem.update.mockResolvedValue(
      saved({ folderId: SHELF.id, inLibrary: true }));

    const res = await request(app).post('/api/v1/reading-list/existing/archive').set(auth);

    expect(res.status).toBe(200);
    expect(prismaMock.readingFolder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: ME, system: 'archived', name: 'Archived' }),
      }));
    // Comes back with the item, because this is the only moment the client can
    // learn the shelf exists without a reload.
    expect(res.body.folder.id).toBe(SHELF.id);
  });

  // Two copies of one article, saved to two places, both archived. One copy per
  // destination is the rule everywhere else, and dropping the duplicate is safe
  // here in a way a plain delete is not: this user still has a row for the
  // article, and the count is per person.
  it('merges into a copy already on the shelf', async () => {
    prismaMock.readingListItem.findFirst.mockResolvedValue(saved({ id: 'dupe' }));
    prismaMock.readingFolder.findFirst.mockResolvedValue(SHELF);
    prismaMock.readingListItem.findMany.mockResolvedValue([{ id: 'first', url: URL_A }]);
    prismaMock.readingListItem.findFirst
      .mockResolvedValueOnce(saved({ id: 'dupe' }))
      .mockResolvedValueOnce(saved({ id: 'first', folderId: SHELF.id, inLibrary: true }));
    prismaMock.readingListItem.delete.mockResolvedValue(saved({ id: 'dupe' }));

    const res = await request(app).post('/api/v1/reading-list/dupe/archive').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body.item.id).toBe('first');
    expect(prismaMock.readingListItem.delete).toHaveBeenCalledWith({ where: { id: 'dupe' } });
  });

  it('is a no-op on something already archived', async () => {
    prismaMock.readingListItem.findFirst.mockResolvedValue(
      saved({ folderId: SHELF.id, inLibrary: true }));
    prismaMock.readingFolder.findFirst.mockResolvedValue(SHELF);

    const res = await request(app).post('/api/v1/reading-list/existing/archive').set(auth);

    expect(res.status).toBe(200);
    expect(prismaMock.readingListItem.update).not.toHaveBeenCalled();
    expect(prismaMock.readingListItem.delete).not.toHaveBeenCalled();
  });

  it('will not archive somebody else’s row', async () => {
    prismaMock.readingListItem.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/reading-list/theirs/archive').set(auth);

    expect(res.status).toBe(404);
    expect(prismaMock.readingFolder.create).not.toHaveBeenCalled();
  });

  it('is not public', async () => {
    const res = await request(app).post('/api/v1/reading-list/existing/archive');
    expect(res.status).toBe(401);
  });
});
