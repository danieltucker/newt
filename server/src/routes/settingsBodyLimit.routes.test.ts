import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

import app from '../app';
import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';

const ME = 'me-id';
const auth = { Authorization: `Bearer ${signAccess(ME)}` };

beforeEach(() => {
  resetPrismaMock();
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false, username: 'me', settings: {},
  });
  prismaMock.user.update.mockResolvedValue({});
});

/**
 * The notes tree is written whole into the settings blob on every save, so the
 * request body grows with everything the user has ever written. The general
 * 256kb limit is a cliff for it: past that every save 413s for ever, and the
 * console has no way to shrink what it is sending.
 */
describe('PATCH /settings body limit', () => {
  const notesOf = (bytes: number) => ({
    noteDocs: [{ id: 'n1', title: 'Long note', body: 'x'.repeat(bytes), updatedAt: 1 }],
    noteFolders: [],
    noteTreeOrder: ['n1'],
    notesRev: 0,
  });

  it('accepts a notes tree well past the general 256kb limit', async () => {
    await request(app).patch('/api/v1/settings').set(auth).send(notesOf(600 * 1024)).expect(200);
    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it('still accepts one near the settings ceiling', async () => {
    await request(app).patch('/api/v1/settings').set(auth).send(notesOf(1_500 * 1024)).expect(200);
  });

  // The ceiling has to exist - this endpoint takes an arbitrary JSON blob from
  // anyone signed in - and it has to be reported, not swallowed.
  it('refuses one past the settings ceiling, with a 413 the client can read', async () => {
    const res = await request(app).patch('/api/v1/settings').set(auth).send(notesOf(3 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(res.body.error).toBeTruthy();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  // The bigger limit is mounted on the settings path only. Everything else
  // keeps the tighter one, which is the whole reason for mounting it separately.
  it('leaves the general limit alone on other routes', async () => {
    prismaMock.bookmark.findMany.mockResolvedValue([]);
    const res = await request(app)
      .post('/api/v1/bookmarks')
      .set(auth)
      .send({ name: 'x', domain: 'y'.repeat(400 * 1024) });
    expect(res.status).toBe(413);
  });
});
