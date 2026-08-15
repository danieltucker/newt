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
