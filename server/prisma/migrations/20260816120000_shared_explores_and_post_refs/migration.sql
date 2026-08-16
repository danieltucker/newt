-- v1.20.0 — explored paths.
--
-- An article page gains a section between the text and the comments listing
-- what people did with the piece beyond replying to it: explore threads their
-- authors chose to share, and public posts written about it. Two things had to
-- become answerable for that, and neither was.
--
--   1. An explore thread had no visibility at all. Every one of them was
--      private by construction, readable only through routes scoped to the
--      owner. Sharing one needs the same three tiers the rest of the app uses.
--
--   2. A post's link to an article existed only inside its HTML, as a data-url
--      on an embed. "Which posts are about this article" was therefore a LIKE
--      across every post body on the instance.

-- ── Explores can be shared ──
-- Nullable rather than defaulted: sharedAt records an event that has not
-- happened for any existing row.
ALTER TABLE "ResearchThread" ADD COLUMN "sourceKey"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "ResearchThread" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "ResearchThread" ADD COLUMN "sharedAt"   TIMESTAMP(3);

-- Every existing thread stays private. Stated rather than left to the column
-- default, because the default only governs rows written from now on and the
-- whole point of this column is that nothing becomes visible by accident.
UPDATE "ResearchThread" SET "visibility" = 'private';

-- sourceKey is backfilled by the server on next write rather than here: the
-- canonical form is computed by canonicalArticleKey() in TypeScript (it strips
-- tracking parameters, normalises the host, drops a trailing slash), and
-- reimplementing that in SQL would give a key that disagrees with the one every
-- other table uses. A thread with an empty sourceKey simply doesn't appear in
-- an article's list until it is next touched; see backfillSourceKeys() in
-- server/src/lib/exploredPaths.ts, which runs once at boot.
CREATE INDEX "ResearchThread_sourceKey_visibility_sharedAt_idx"
  ON "ResearchThread"("sourceKey", "visibility", "sharedAt");

-- ── Posts point at articles ──
CREATE TABLE "PostReference" (
    "id"         TEXT NOT NULL,
    "postId"     TEXT NOT NULL,
    "articleKey" TEXT NOT NULL,
    "url"        TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostReference_pkey" PRIMARY KEY ("id")
);

-- One row per article per post: a post citing the same piece three times is
-- still one post about it.
CREATE UNIQUE INDEX "PostReference_postId_articleKey_key"
  ON "PostReference"("postId", "articleKey");
CREATE INDEX "PostReference_articleKey_idx" ON "PostReference"("articleKey");

-- Cascade, because these rows are derived from the post's body and mean nothing
-- without it.
ALTER TABLE "PostReference"
  ADD CONSTRAINT "PostReference_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing posts are backfilled at boot for the same reason sourceKey is: the
-- URLs live in HTML attributes, and parsing that in SQL to then canonicalise it
-- in SQL would be two reimplementations of code that already exists and is
-- tested. See backfillPostReferences().
