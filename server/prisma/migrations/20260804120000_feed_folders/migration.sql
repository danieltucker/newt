-- v1.11.0 — the feed stops living inside bookmark folders.
--
-- Feeds were subscribed to *within* a bookmark folder, so reading them meant
-- selecting that folder first and managing them meant opening its edit modal.
-- They now hang off the user directly, filed into FeedFolder categories that
-- exist only for the reader ("Tech news", "Local"), the way ReadingFolder
-- already split the Library off from bookmark folders.
--
-- Existing groupings are preserved: every bookmark folder that actually held
-- feeds becomes a FeedFolder of the same name and colour.

-- CreateTable
CREATE TABLE "FeedFolder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedFolder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FeedFolder_userId_idx" ON "FeedFolder"("userId");

ALTER TABLE "FeedFolder" ADD CONSTRAINT "FeedFolder_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the old grouping across. Only folders that held feeds become
-- categories — a bookmark folder with none of its own would arrive as an empty
-- category nobody asked for. The source id rides along in a temporary column so
-- the subscriptions below can find their new home, then is dropped.
ALTER TABLE "FeedFolder" ADD COLUMN "_srcFolderId" TEXT;

INSERT INTO "FeedFolder" ("id", "userId", "name", "color", "position", "_srcFolderId")
SELECT gen_random_uuid()::text, f."userId", f."name", f."color", f."position", f."id"
FROM "Folder" f
WHERE EXISTS (SELECT 1 FROM "FolderFeed" ff WHERE ff."folderId" = f."id");

-- ── FolderFeed → FeedSubscription ────────────────────────────────────────────
-- Renamed rather than rebuilt: it is the same subscription, and a rename keeps
-- every id stable for anything already pointing at one.
ALTER TABLE "FolderFeed" RENAME TO "FeedSubscription";

ALTER TABLE "FeedSubscription" ADD COLUMN "feedFolderId" TEXT;

UPDATE "FeedSubscription" s
SET "feedFolderId" = ff."id"
FROM "FeedFolder" ff
WHERE ff."_srcFolderId" = s."folderId";

ALTER TABLE "FeedFolder" DROP COLUMN "_srcFolderId";

-- Uniqueness moves from (folder, url) to (user, url). One river means the same
-- URL filed in two categories would deal each of its articles twice, so any
-- user who had a feed in more than one folder keeps the oldest row.
DELETE FROM "FeedSubscription" a
USING "FeedSubscription" b
WHERE a."userId" = b."userId"
  AND a."url" = b."url"
  AND (a."createdAt" > b."createdAt" OR (a."createdAt" = b."createdAt" AND a."id" > b."id"));

ALTER TABLE "FeedSubscription" DROP CONSTRAINT "FolderFeed_folderId_fkey";
ALTER TABLE "FeedSubscription" DROP CONSTRAINT "FolderFeed_userId_fkey";
DROP INDEX "FolderFeed_folderId_url_key";
DROP INDEX "FolderFeed_folderId_idx";
DROP INDEX "FolderFeed_userId_idx";
ALTER TABLE "FeedSubscription" DROP COLUMN "folderId";
ALTER TABLE "FeedSubscription" RENAME CONSTRAINT "FolderFeed_pkey" TO "FeedSubscription_pkey";

CREATE UNIQUE INDEX "FeedSubscription_userId_url_key" ON "FeedSubscription"("userId", "url");
CREATE INDEX "FeedSubscription_userId_idx" ON "FeedSubscription"("userId");
CREATE INDEX "FeedSubscription_feedFolderId_idx" ON "FeedSubscription"("feedFolderId");

ALTER TABLE "FeedSubscription" ADD CONSTRAINT "FeedSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: deleting a category must never silently unsubscribe
-- you from what was in it. Those feeds fall back to Uncategorised.
ALTER TABLE "FeedSubscription" ADD CONSTRAINT "FeedSubscription_feedFolderId_fkey"
    FOREIGN KEY ("feedFolderId") REFERENCES "FeedFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Dismissals stop being per-folder ─────────────────────────────────────────
-- An article waved away in the feed is waved away. Keeping it keyed by bookmark
-- folder meant the same item could be dismissed in one and still waiting in
-- another, which only ever made sense while feeds lived in folders.
DELETE FROM "DismissedFeedItem" a
USING "DismissedFeedItem" b
WHERE a."userId" = b."userId"
  AND a."itemId" = b."itemId"
  AND (a."createdAt" > b."createdAt" OR (a."createdAt" = b."createdAt" AND a."folderId" > b."folderId"));

ALTER TABLE "DismissedFeedItem" DROP CONSTRAINT "DismissedFeedItem_folderId_fkey";
DROP INDEX "DismissedFeedItem_folderId_userId_idx";
ALTER TABLE "DismissedFeedItem" DROP CONSTRAINT "DismissedFeedItem_pkey";
ALTER TABLE "DismissedFeedItem" DROP COLUMN "folderId";
ALTER TABLE "DismissedFeedItem" ADD CONSTRAINT "DismissedFeedItem_pkey" PRIMARY KEY ("userId", "itemId");
CREATE INDEX "DismissedFeedItem_userId_idx" ON "DismissedFeedItem"("userId");
