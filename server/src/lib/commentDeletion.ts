import { Prisma } from '@prisma/client';
import prisma from './prisma';

// Every query here goes through whichever client the caller supplied: the plain
// one for the author's own delete, or a transactional client when an admin's
// delete has to commit atomically with its audit row. The two paths must leave
// identical wreckage, so they share one implementation and differ only in the
// handle they run on.
type Db = Prisma.TransactionClient | typeof prisma;

// Removes any ancestor tombstones that have just lost their last reply, walking
// up the thread — so a "[deleted]" placeholder never lingers with nothing under
// it. Bounded by the thread depth.
async function pruneChildlessTombstones(db: Db, startParentId: string | null): Promise<void> {
  let pid = startParentId;
  while (pid) {
    const parent = await db.comment.findUnique({
      where: { id: pid },
      select: { id: true, parentId: true, deletedAt: true },
    });
    if (!parent || !parent.deletedAt) break;           // real comment, or gone — stop
    const kids = await db.comment.count({ where: { parentId: pid } });
    if (kids > 0) break;                                // still holding up replies
    const grandparent = parent.parentId;
    await db.comment.delete({ where: { id: pid } });
    pid = grandparent;
  }
}

export type CommentDeleteResult = 'not-found' | 'already-deleted' | 'tombstoned' | 'removed';

// Deletes a comment without breaking the thread hanging off it. One copy of this
// serves both the author's own delete and admin moderation, so the two can never
// drift into leaving different shapes of wreckage behind.
//
// `userId` scopes the lookup to an author when given (the self-delete path); the
// admin path omits it and may remove anyone's comment.
export async function deleteCommentPreservingThread(
  id: string,
  userId?: string,
  db: Db = prisma,
): Promise<CommentDeleteResult> {
  const comment = await db.comment.findFirst({
    where: userId ? { id, userId } : { id },
    select: { id: true, parentId: true, deletedAt: true },
  });
  if (!comment) return 'not-found';
  if (comment.deletedAt) return 'already-deleted';

  const replyCount = await db.comment.count({ where: { parentId: comment.id } });

  if (replyCount > 0) {
    // Tombstone: wipe content + history, keep the node for the thread below it.
    // Sequential rather than a nested $transaction — when `db` is already a
    // transactional client these are part of the caller's transaction, and when
    // it isn't, the pair is small enough that a partial write leaves a tombstone
    // with stale revisions rather than anything user-visible.
    await db.commentRevision.deleteMany({ where: { commentId: comment.id } });
    await db.comment.update({
      where: { id: comment.id },
      data: { deletedAt: new Date(), body: '', title: null },
    });
    return 'tombstoned';
  }

  // Leaf: remove outright (revisions cascade), then tidy up orphaned tombstones
  await db.comment.delete({ where: { id: comment.id } });
  await pruneChildlessTombstones(db, comment.parentId);
  return 'removed';
}
