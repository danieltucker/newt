-- The archive drawer became the Library. Rename in place: the column already
-- holds exactly the right rows, so a rename keeps every existing archived
-- article without a data migration.
ALTER TABLE "ReadingListItem" RENAME COLUMN "archived" TO "inLibrary";

-- Library shelves.
CREATE TABLE "ReadingFolder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadingFolder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReadingFolder_userId_idx" ON "ReadingFolder"("userId");

ALTER TABLE "ReadingFolder" ADD CONSTRAINT "ReadingFolder_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable folderId: NULL means Unsorted, which is where every pre-existing
-- item lands. ON DELETE SET NULL so deleting a shelf never deletes articles.
ALTER TABLE "ReadingListItem" ADD COLUMN "folderId" TEXT;

CREATE INDEX "ReadingListItem_folderId_idx" ON "ReadingListItem"("folderId");

ALTER TABLE "ReadingListItem" ADD CONSTRAINT "ReadingListItem_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "ReadingFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
