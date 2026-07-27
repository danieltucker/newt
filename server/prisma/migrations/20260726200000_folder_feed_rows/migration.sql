-- Folder.feedUrls (String[]) becomes FolderFeed rows, so a subscription can
-- carry a name, be re-pointed at a new URL, and move between folders.

-- CreateTable
CREATE TABLE "FolderFeed" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FolderFeed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FolderFeed_userId_idx" ON "FolderFeed"("userId");
CREATE INDEX "FolderFeed_folderId_idx" ON "FolderFeed"("folderId");
CREATE UNIQUE INDEX "FolderFeed_folderId_url_key" ON "FolderFeed"("folderId", "url");

-- AddForeignKey
ALTER TABLE "FolderFeed" ADD CONSTRAINT "FolderFeed_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FolderFeed" ADD CONSTRAINT "FolderFeed_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill one row per existing URL, keeping array order as position. Names
-- start empty so they keep deriving exactly as they did before. DISTINCT ON
-- guards the new unique index against a folder that listed a URL twice.
INSERT INTO "FolderFeed" ("id", "folderId", "userId", "url", "name", "position")
SELECT DISTINCT ON (f."id", u."url")
       gen_random_uuid()::text, f."id", f."userId", u."url", '', u."ord" - 1
FROM "Folder" f, unnest(f."feedUrls") WITH ORDINALITY AS u("url", "ord")
ORDER BY f."id", u."url", u."ord";

-- DropColumn
ALTER TABLE "Folder" DROP COLUMN "feedUrls";
