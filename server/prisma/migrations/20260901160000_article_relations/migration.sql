-- Cross-site "related coverage": pairs of articles a relate task judged to be
-- about the same story.
--
-- One row per pair, with the two keys sorted lexically so (A,B) and (B,A) are
-- the same row. Without that the unique constraint below buys nothing and every
-- re-run doubles the list. Sorting is done by the writer (lib/ai/relate.ts).
CREATE TABLE "ArticleRelation" (
    "id" TEXT NOT NULL,
    "keyA" TEXT NOT NULL,
    "keyB" TEXT NOT NULL,
    "urlA" TEXT NOT NULL DEFAULT '',
    "urlB" TEXT NOT NULL DEFAULT '',
    "titleA" TEXT NOT NULL DEFAULT '',
    "titleB" TEXT NOT NULL DEFAULT '',
    "hostA" TEXT NOT NULL DEFAULT '',
    "hostB" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "taskId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArticleRelation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArticleRelation_keyA_keyB_key" ON "ArticleRelation"("keyA", "keyB");
-- "What relates to this article", asked from either side.
CREATE INDEX "ArticleRelation_keyA_createdAt_idx" ON "ArticleRelation"("keyA", "createdAt");
CREATE INDEX "ArticleRelation_keyB_createdAt_idx" ON "ArticleRelation"("keyB", "createdAt");
