-- v1.17.0 — the cache behind Explore reading the article itself.
--
-- One table, no changes to anything that already exists.
--
--   ArticleText   the readable text of a page, keyed by the canonical article
--                 key (the same key comments thread on). Shared by every user
--                 rather than stored per account: it is the published article,
--                 identical for all of them, and a per-user copy would mean
--                 fetching the same page once per reader.
--
-- Nothing user-specific lives here. Comments and notes stay where they were and
-- are still read live, per viewer, so an article's cached text can never carry
-- somebody's private material into somebody else's prompt.
--
-- Safe to drop and rebuild: every row is re-derivable by fetching the page
-- again, which is what an expired row causes anyway.

-- CreateTable
CREATE TABLE "ArticleText" (
    "articleKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    -- Empty is a cached answer, not a missing one: the page was read and had no
    -- article in it. Kept so a paywall isn't re-fetched on every question.
    "text" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleText_pkey" PRIMARY KEY ("articleKey")
);

-- Supports the age sweep that drops stale rows.
CREATE INDEX "ArticleText_fetchedAt_idx" ON "ArticleText"("fetchedAt");
