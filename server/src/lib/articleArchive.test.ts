import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./prisma', async () => {
  const { prismaMock } = await import('../test/prismaMock');
  return { default: prismaMock };
});

import { prismaMock, resetPrismaMock } from '../test/prismaMock';
import { pruneArticleArchive, ARCHIVE_TTL_MS } from './feedRefresh';

beforeEach(resetPrismaMock);

/**
 * What these can and cannot show.
 *
 * The prisma mock does not run SQL, so nothing here proves the sweep deletes the
 * right rows — only a real-Postgres suite can say that. What they do pin is the
 * *shape* of the statement, and the shape is where the whole retention design
 * lives: three NOT EXISTS guards and a cutoff. Every one of those is a clause
 * that would be silently easy to drop during a refactor and catastrophic to lose
 * — dropping a guard means deleting articles somebody has commented on, which is
 * exactly the promise this table was added to keep.
 */
function sweepSql(): string {
  const call = prismaMock.$executeRaw.mock.calls[0];
  return call ? (call[0] as unknown as string[]).join('?') : '';
}

describe('pruneArticleArchive', () => {
  it('keeps anything a comment, a post citation or a reading list points at', async () => {
    await pruneArticleArchive();
    const sql = sweepSql();

    // The three references that pin an article. Losing any one of these is the
    // failure this test exists for.
    expect(sql).toMatch(/NOT EXISTS[\s\S]*"Comment"/);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*"PostReference"/);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*"ReadingListItem"/);
    // All three join on the canonical key rather than a url, which is what makes
    // them indexed lookups instead of a scan.
    expect(sql).toContain('"articleKey"');
  });

  it('deletes from the archive and never from the river', async () => {
    await pruneArticleArchive();
    const sql = sweepSql();
    expect(sql).toContain('DELETE FROM "ArticleArchive"');
    // The river has its own expiry, bounded by what publishers still list. If
    // this sweep ever reached FeedItem it would be deleting the reader's current
    // feed on a three-year timer.
    expect(sql).not.toContain('"FeedItem"');
  });

  it('measures age from the last sighting, not the first', async () => {
    const now = new Date('2026-08-20T12:00:00Z');
    await pruneArticleArchive(now);

    expect(sweepSql()).toContain('"lastSeenAt"');
    const cutoff = prismaMock.$executeRaw.mock.calls[0][1] as Date;
    expect(cutoff.getTime()).toBe(now.getTime() - ARCHIVE_TTL_MS);
  });

  it('holds an article a feed still carries, however old it is', async () => {
    // The consequence of measuring lastSeenAt: a piece a publisher keeps listing
    // has its sighting refreshed on every poll, so it cannot age out while it is
    // still being carried. firstSeenAt would have expired it mid-feed.
    expect(sweepSql()).not.toContain('"firstSeenAt"');
    await pruneArticleArchive();
    expect(sweepSql()).not.toContain('"firstSeenAt"');
  });

  it('reports how many it removed', async () => {
    prismaMock.$executeRaw.mockResolvedValue(12);
    expect(await pruneArticleArchive()).toBe(12);
  });
});
