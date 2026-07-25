-- Soft-delete marker: a deleted comment that still has replies is kept as a
-- tombstone (content wiped) so the replies beneath it survive.
ALTER TABLE "Comment" ADD COLUMN "deletedAt" TIMESTAMP(3);
