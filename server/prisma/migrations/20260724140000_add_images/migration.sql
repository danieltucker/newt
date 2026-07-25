-- Images embedded in notes, comments and blog posts.
--
-- The bytes live in Postgres rather than on disk because the server container has
-- no persistent volume (docker-compose.yml mounts one only for postgres), so a
-- rebuild would wipe a filesystem store. BYTEA also means uploads are captured by
-- the existing database backup rather than needing one of their own.
--
-- "size" duplicates length("data") so a per-user quota can be summed without the
-- planner reading every blob, and "mime" is sniffed from the file's magic number
-- on upload — it is never the value the client claimed.

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Image_userId_createdAt_idx" ON "Image"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
