-- Replace the isPublic boolean with a three-value visibility column.
-- Existing public comments become 'public'; everything else stays 'private'.
ALTER TABLE "Comment" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';

UPDATE "Comment" SET "visibility" = 'public' WHERE "isPublic" = true;

ALTER TABLE "Comment" DROP COLUMN "isPublic";
