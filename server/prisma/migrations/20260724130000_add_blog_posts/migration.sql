-- Blog posts. "articleKey" is the canonical form of "url" and is what
-- Comment.articleKey threads on, so a post inherits the comment system without a
-- join table. It is unique so a key can be resolved back to at most one post
-- (the comment routes use that lookup to gate a thread on the post's visibility).
--
-- "feedToken" is a per-user bearer secret for the personal aggregate blog feed,
-- which carries friends-only posts and therefore must never be guessable.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "feedToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_feedToken_key" ON "User"("feedToken");

-- CreateTable
CREATE TABLE "BlogPost" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL DEFAULT '',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "commentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "url" TEXT NOT NULL,
    "articleKey" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlogPost_articleKey_key" ON "BlogPost"("articleKey");

-- CreateIndex
CREATE UNIQUE INDEX "BlogPost_userId_slug_key" ON "BlogPost"("userId", "slug");

-- CreateIndex
CREATE INDEX "BlogPost_userId_publishedAt_idx" ON "BlogPost"("userId", "publishedAt");

-- CreateIndex
CREATE INDEX "BlogPost_visibility_publishedAt_idx" ON "BlogPost"("visibility", "publishedAt");

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
