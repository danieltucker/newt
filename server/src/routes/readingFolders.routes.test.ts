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

// Archived is a shelf the app owns, not one the user made. Deleting a shelf
// tips its articles into Unsorted, so allowing it here would empty the archive
// back into the Library in one press - and the rows on it are what hold up the
// save counts of articles their owner has finished with.
describe('the Archived shelf cannot be deleted', () => {
  it('refuses to delete a system shelf', async () => {
    prismaMock.readingFolder.findFirst.mockResolvedValue({ id: 'archived-id', system: 'archived' });

    const res = await request(app).delete('/api/v1/reading-folders/archived-id').set(auth);

    expect(res.status).toBe(400);
    expect(prismaMock.readingFolder.delete).not.toHaveBeenCalled();
  });

  it('still deletes an ordinary shelf', async () => {
    prismaMock.readingFolder.findFirst.mockResolvedValue({ id: 'mine', system: null });
    prismaMock.readingListItem.findMany.mockResolvedValue([{ id: 'a' }]);
    prismaMock.readingFolder.delete.mockResolvedValue({ id: 'mine' });

    const res = await request(app).delete('/api/v1/reading-folders/mine').set(auth);

    expect(res.status).toBe(200);
    // The articles on it fall back to Unsorted rather than going with it.
    expect(res.body.unsortedIds).toEqual(['a']);
    expect(prismaMock.readingFolder.delete).toHaveBeenCalled();
  });

  // The client hides the delete control on this shelf; that is the polite half
  // of the rule, and this is the half that holds when the request is made by
  // hand.
  it('is refused even though the listing says which shelf is which', async () => {
    prismaMock.readingFolder.findMany.mockResolvedValue([
      { id: 'archived-id', name: 'Archived', color: '#8B8D98', position: 0, system: 'archived', _count: { items: 4 } },
    ]);

    const list = await request(app).get('/api/v1/reading-folders').set(auth);
    expect(list.body[0].system).toBe('archived');
  });
});
