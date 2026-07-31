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

beforeEach(() => {
  resetPrismaMock();
  clearTrustCache();
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false,
  });
});

// The IDOR protection was previously "correct by inspection". These assert that
// the scoping is really in the query the route sends, not merely available to it.
describe('every bookmark query is scoped to the caller', () => {
  it('scopes the bulk load', async () => {
    await request(app).get('/api/v1/bookmarks/all').set(auth).expect(200);
    expect(prismaMock.bookmark.findMany.mock.calls[0][0].where).toMatchObject({ userId: ME });
  });

  it('scopes a per-folder listing, so a guessed folderId returns nothing', async () => {
    await request(app).get('/api/v1/bookmarks?folderId=someone-elses').set(auth).expect(200);
    expect(prismaMock.bookmark.findMany.mock.calls[0][0].where).toMatchObject({
      folderId: 'someone-elses', userId: ME,
    });
  });

  it('scopes deletion', async () => {
    prismaMock.bookmark.deleteMany.mockResolvedValue({ count: 0 });
    await request(app).delete('/api/v1/bookmarks/abc').set(auth);
    const call = prismaMock.bookmark.deleteMany.mock.calls[0]
      ?? prismaMock.bookmark.delete.mock.calls[0];
    expect(JSON.stringify(call[0])).toContain(ME);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/bookmarks/all').expect(401);
  });
});

describe('per-account row cap', () => {
  it('refuses a new bookmark once the account is at the limit', async () => {
    prismaMock.bookmark.count.mockResolvedValue(2000);

    const res = await request(app).post('/api/v1/bookmarks')
      .set(auth).send({ folderId: 'f1', domain: 'example.com', name: 'Example' });

    expect(res.status).toBe(409);
    expect(prismaMock.bookmark.create).not.toHaveBeenCalled();
  });

  it('still allows a create below the limit', async () => {
    prismaMock.bookmark.count.mockResolvedValue(10);
    prismaMock.folder.findFirst.mockResolvedValue({ id: 'f1', userId: ME });

    const res = await request(app).post('/api/v1/bookmarks')
      .set(auth).send({ folderId: 'f1', domain: 'example.com', name: 'Example' });

    expect(res.status).not.toBe(409);
  });

  it('imports only what fits in the remaining budget instead of failing the call', async () => {
    prismaMock.folder.findFirst.mockResolvedValue({ id: 'f1', userId: ME });
    prismaMock.bookmark.findMany.mockResolvedValue([]);
    prismaMock.bookmark.count.mockResolvedValue(1998); // room for 2

    const payload = Array.from({ length: 50 }, (_, i) => ({
      name: `Site ${i}`, domain: `site${i}.com`, color: '#fff',
    }));

    const res = await request(app).post('/api/v1/bookmarks/import')
      .set(auth).send({ folderId: 'f1', bookmarks: payload });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped).toBe(48);
    expect(prismaMock.bookmark.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('reports atCap so the client can explain the truncation', async () => {
    prismaMock.folder.findFirst.mockResolvedValue({ id: 'f1', userId: ME });
    prismaMock.bookmark.count.mockResolvedValue(2000);

    const res = await request(app).post('/api/v1/bookmarks/import')
      .set(auth).send({ folderId: 'f1', bookmarks: [{ name: 'A', domain: 'a.com', color: '#fff' }] });

    expect(res.body).toMatchObject({ created: 0, atCap: true, limit: 2000 });
    expect(prismaMock.bookmark.createMany).not.toHaveBeenCalled();
  });

  it('rejects an import into a folder the caller does not own', async () => {
    prismaMock.folder.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/bookmarks/import')
      .set(auth).send({ folderId: 'not-mine', bookmarks: [{ name: 'A', domain: 'a.com', color: '#fff' }] });

    expect(res.status).toBe(404);
    // The ownership check must be part of the lookup, not a later comparison.
    expect(prismaMock.folder.findFirst.mock.calls[0][0].where).toMatchObject({ userId: ME });
    expect(prismaMock.bookmark.createMany).not.toHaveBeenCalled();
  });
});
