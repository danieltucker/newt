import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Must be registered before app.ts is imported, so every route module resolves
// './lib/prisma' to the mock. The factory is async so it can import the shared
// singleton rather than duplicating it per test file.
vi.mock('../lib/prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

import app from '../app';
import { prismaMock, resetPrismaMock, uniqueViolation } from '../test/prismaMock';
import { signAccess } from '../lib/jwt';
import { clearTrustCache } from '../lib/trust';

const ME = 'me-id';
const THEM = 'them-id';
const auth = { Authorization: `Bearer ${signAccess(ME)}` };

// requireAuth and trustLevelFor both read the caller through user.findUnique, so
// one stub covering every selected field serves both.
function signedIn(overrides: Record<string, unknown> = {}) {
  prismaMock.user.findUnique.mockResolvedValue({
    id: ME, bannedAt: null, isAdmin: false,
    createdAt: new Date('2020-01-01'), totpEnabled: false,
    ...overrides,
  });
}

beforeEach(() => {
  resetPrismaMock();
  // The trust level is cached per user id across requests; without this a level
  // computed in one test leaks into the next.
  clearTrustCache();
  signedIn();
});

describe('auth is actually enforced, not just imported', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/friends');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const res = await request(app).get('/api/v1/friends')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });

  it('rejects a banned account even with a valid token', async () => {
    signedIn({ bannedAt: new Date() });
    const res = await request(app).get('/api/v1/friends').set(auth);
    expect(res.status).toBe(401);
  });
});

describe('GET /friends/search', () => {
  it('matches by prefix, not substring', async () => {
    await request(app).get('/api/v1/friends/search?q=ali').set(auth).expect(200);

    const where = prismaMock.user.findMany.mock.calls[0][0].where;
    expect(where.username).toEqual({ startsWith: 'ali', mode: 'insensitive' });
    // A contains match is what let one account enumerate the whole userbase.
    expect(JSON.stringify(where)).not.toContain('contains');
  });

  it('excludes the searcher, banned accounts, and anyone behind a block wall', async () => {
    prismaMock.block.findMany.mockResolvedValue([{ blockerId: THEM, blockedId: ME }]);

    await request(app).get('/api/v1/friends/search?q=ali').set(auth).expect(200);

    const where = prismaMock.user.findMany.mock.calls[0][0].where;
    expect(where.bannedAt).toBeNull();
    expect(where.NOT).toEqual({ id: ME });
    expect(where.id).toEqual({ notIn: [THEM] });
  });

  it('does not query at all for a one-character term', async () => {
    const res = await request(app).get('/api/v1/friends/search?q=a').set(auth).expect(200);
    expect(res.body.results).toEqual([]);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it('never reports a declined request as a live relationship', async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: THEM, username: 'them', firstName: null, lastName: null, avatar: null },
    ]);
    await request(app).get('/api/v1/friends/search?q=the').set(auth).expect(200);

    const where = prismaMock.friendship.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['pending', 'accepted'] });
  });
});

describe('POST /friends/requests', () => {
  const target = { id: THEM };

  it('answers a blocked-by-target request with the same 404 as a missing user', async () => {
    prismaMock.user.findFirst.mockResolvedValue(target);
    prismaMock.block.findFirst.mockResolvedValue({ blockerId: THEM });

    const res = await request(app).post('/api/v1/friends/requests')
      .set(auth).send({ username: 'them' });

    expect(res.status).toBe(404);
    // Telling them they were blocked is the signal blocking exists to withhold.
    expect(JSON.stringify(res.body)).not.toMatch(/block/i);
    expect(prismaMock.friendship.create).not.toHaveBeenCalled();
  });

  it('writes a direction-independent pairKey', async () => {
    prismaMock.user.findFirst.mockResolvedValue(target);

    await request(app).post('/api/v1/friends/requests')
      .set(auth).send({ username: 'them' }).expect(201);

    const data = prismaMock.friendship.create.mock.calls[0][0].data;
    expect(data.pairKey).toBe([ME, THEM].sort().join(':'));
    expect(data.status).toBe('pending');
  });

  // The race the pairKey constraint exists to catch: our insert loses to their
  // simultaneous reciprocal request. The right answer is to accept theirs, not
  // to 500.
  it('accepts the other side instead of erroring when it loses the insert race', async () => {
    prismaMock.user.findFirst.mockResolvedValue(target);
    prismaMock.friendship.findUnique
      .mockResolvedValueOnce(null)                        // nothing there when we looked
      .mockResolvedValueOnce({                            // ...but there is now
        id: 'f1', status: 'pending', requesterId: THEM, respondedAt: null,
      });
    prismaMock.friendship.create.mockRejectedValue(uniqueViolation());

    const res = await request(app).post('/api/v1/friends/requests')
      .set(auth).send({ username: 'them' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: true });
    expect(prismaMock.friendship.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'accepted' }) }),
    );
  });

  it('lets a genuine server error surface rather than swallowing it', async () => {
    prismaMock.user.findFirst.mockResolvedValue(target);
    prismaMock.friendship.create.mockRejectedValue(new Error('connection lost'));

    const res = await request(app).post('/api/v1/friends/requests')
      .set(auth).send({ username: 'them' });
    expect(res.status).toBe(500);
  });

  it('silently no-ops a re-request inside the decline cooldown', async () => {
    prismaMock.user.findFirst.mockResolvedValue(target);
    prismaMock.friendship.findUnique.mockResolvedValue({
      id: 'f1', status: 'declined', requesterId: ME, respondedAt: new Date(),
    });

    const res = await request(app).post('/api/v1/friends/requests')
      .set(auth).send({ username: 'them' });

    // Looks exactly like a successful send — an error here would confirm both
    // that the account exists and that they were turned down.
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(prismaMock.friendship.update).not.toHaveBeenCalled();
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
  });

  it('lets the person who declined send their own request back', async () => {
    prismaMock.user.findFirst.mockResolvedValue(target);
    prismaMock.friendship.findUnique.mockResolvedValue({
      id: 'f1', status: 'declined', requesterId: THEM, respondedAt: new Date(),
    });

    await request(app).post('/api/v1/friends/requests')
      .set(auth).send({ username: 'them' }).expect(201);

    const data = prismaMock.friendship.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'pending', requesterId: ME, addresseeId: THEM });
  });
});

describe('POST /friends/requests/:id/decline', () => {
  it('keeps a declined row as the cooldown tombstone', async () => {
    prismaMock.friendship.findFirst.mockResolvedValue({ id: 'f1', addresseeId: ME });

    await request(app).post('/api/v1/friends/requests/f1/decline').set(auth).expect(200);

    expect(prismaMock.friendship.delete).not.toHaveBeenCalled();
    expect(prismaMock.friendship.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'declined' }) }),
    );
  });

  it('deletes outright when the requester cancels their own request', async () => {
    prismaMock.friendship.findFirst.mockResolvedValue({ id: 'f1', addresseeId: THEM });

    await request(app).post('/api/v1/friends/requests/f1/decline').set(auth).expect(200);

    // Withdrawing your own request must not put you in a cooldown.
    expect(prismaMock.friendship.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
    expect(prismaMock.friendship.update).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller, so a stranger cannot decline for someone else', async () => {
    await request(app).post('/api/v1/friends/requests/f1/decline').set(auth).expect(404);

    const where = prismaMock.friendship.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ addresseeId: ME }, { requesterId: ME }]);
  });
});

describe('accept and unfriend are scoped to the caller', () => {
  it('only accepts a request addressed to the caller', async () => {
    await request(app).post('/api/v1/friends/requests/f1/accept').set(auth).expect(404);

    expect(prismaMock.friendship.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'f1', addresseeId: ME, status: 'pending',
    });
  });

  it('only unfriends a friendship the caller is part of', async () => {
    await request(app).delete(`/api/v1/friends/${THEM}`).set(auth).expect(404);

    const where = prismaMock.friendship.deleteMany.mock.calls[0][0].where;
    expect(where.status).toBe('accepted');
    expect(where.OR).toEqual([
      { requesterId: ME, addresseeId: THEM },
      { requesterId: THEM, addresseeId: ME },
    ]);
  });
});
