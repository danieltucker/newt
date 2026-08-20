-- The searchable archive: years of articles, kept away from the river.
--
-- Feed history used to end after FEED_TTL_MS, seven days past the point an
-- article left its publisher's feed. Search read "FeedItem" directly, so the
-- searchable corpus ended there too — and so did Explore's grounding, which has
-- been asking for a 365-day window (lib/llm/feedContext MAX_AGE_DAYS) against a
-- table that could never hold more than a fortnight of anything.
--
-- The obvious fix — raise the TTL — is the wrong one, and this table exists
-- because of why. Three of the river's queries have no date bound:
--
--   fetchStories     DISTINCT ON over every item in every feed you follow, sorted
--                    in full before OFFSET/LIMIT
--   countStories     the same set, counted, with a correlated NOT EXISTS per row
--   countNewStories  GROUP BY linkKey HAVING MIN(firstSeenAt) > $since — and MIN()
--                    per group must see every row of the group, so no index on
--                    firstSeenAt can prune it. This one polls on a timer.
--
-- They are quick today only because "FeedItem" is small, and it is small for a
-- reason unrelated to time: parseFeed caps ingestion at 50 items per feed per
-- refresh, so the river is bounded by subscription count and stays flat. Raising
-- the TTL would have made the front page and a background poll degrade forever,
-- in exchange for search depth. Splitting the two costs nothing on either side.
--
-- Written on ingest, not on expiry. Filling this from the sweep would have left
-- search reading a union of two tables and deduping across them; writing on the
-- way in makes it a superset of the river, so search reads one table and the
-- river's queries are untouched by any of this.
CREATE TABLE "ArticleArchive" (
    -- canonicalArticleKey — the key comments thread on, posts cite, and
    -- FeedItem.linkKey carries. One row per article for the whole instance, so
    -- two feeds running the same piece is one row and the DISTINCT ON that both
    -- the river and the old search needed is gone from this path entirely: the
    -- dedupe already happened, at write time.
    "articleKey"  TEXT NOT NULL,
    "link"        TEXT NOT NULL,
    "linkHost"    TEXT,
    "title"       TEXT NOT NULL,
    "snippet"     TEXT,
    -- Stored, never indexed. Explore quotes article bodies to the model, so
    -- dropping this would leave grounding over anything older than the river
    -- with nothing but a snippet. It stays out of "searchVector" below for the
    -- reason migration 20260810160000 sets out at length: boilerplate, nav text
    -- and syndication footers all become searchable words. Storing it and
    -- indexing it are separate decisions and this table makes them differently.
    "content"     TEXT,
    "imageUrl"    TEXT,
    "readTime"    INTEGER,
    "categories"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "pubDate"     TIMESTAMP(3),
    -- Earliest sighting across every feed that carried it; never moved back.
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    -- Most recent sighting. What retention measures against, so an article a
    -- publisher keeps listing stays as long as it is still being carried.
    "lastSeenAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleArchive_pkey" PRIMARY KEY ("articleKey")
);

-- Identical weights and configuration to "FeedItem"."searchVector", because the
-- two are searched by one tsquery builder (lib/feedSearch) and a difference here
-- would make the same typed words mean different things depending on the age of
-- what they matched. Generated rather than triggered for the same reason as
-- before: the vector cannot drift from the row, and nothing can write it.
ALTER TABLE "ArticleArchive"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce("snippet", '')), 'B')
  ) STORED;

CREATE INDEX "ArticleArchive_searchVector_idx" ON "ArticleArchive" USING GIN ("searchVector");
-- The retention sweep's ordering column.
CREATE INDEX "ArticleArchive_lastSeenAt_idx" ON "ArticleArchive"("lastSeenAt");
-- Site pages (/s/<domain>) ask "this host, these feeds"; same shape as the
-- FeedItem index that serves them over the recent window.
CREATE INDEX "ArticleArchive_linkHost_idx" ON "ArticleArchive"("linkHost");

-- Which feeds carried an article.
--
-- The archive is deduped across the whole instance, which is what makes it
-- cheap, but it means an article row cannot say whose search may return it.
-- Without this table "search your feeds" would quietly become "search everything
-- this instance has ever fetched" — a different product, and a privacy question
-- nobody was asked.
CREATE TABLE "ArticleArchiveFeed" (
    "articleKey" TEXT NOT NULL,
    "feedId"     TEXT NOT NULL,

    CONSTRAINT "ArticleArchiveFeed_pkey" PRIMARY KEY ("articleKey", "feedId")
);

CREATE INDEX "ArticleArchiveFeed_feedId_idx" ON "ArticleArchiveFeed"("feedId");

ALTER TABLE "ArticleArchiveFeed"
  ADD CONSTRAINT "ArticleArchiveFeed_articleKey_fkey"
  FOREIGN KEY ("articleKey") REFERENCES "ArticleArchive"("articleKey")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArticleArchiveFeed"
  ADD CONSTRAINT "ArticleArchiveFeed_feedId_fkey"
  FOREIGN KEY ("feedId") REFERENCES "Feed"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Reading-list entries join the archive by canonical key.
--
-- The retention sweep keeps any article somebody has engaged with — commented
-- on, cited in a post, or saved — and the first two already carry an indexed
-- "articleKey" ("Comment", "PostReference"). The reading list did not: it stored
-- the raw url and canonicalised it in JavaScript at query time, which is fine
-- for finding one row and useless as a NOT EXISTS guard over a whole table.
--
-- Left NULL for existing rows rather than backfilled in SQL. canonicalArticleKey
-- strips tracking parameters and normalises the host in JS, and SQL cannot
-- reproduce it faithfully — migration 20260807210000 hit exactly this and could
-- accept `link` as an approximation only because live feeds rewrite themselves
-- on the next poll. Reading-list rows are never rewritten, so a wrong key here
-- would be permanent, and it would pin the wrong article forever. NULL means
-- "unknown", and the sweep treats unknown as "do not delete".
-- scripts/backfillArticleKeys.ts fills them in with the real function.
ALTER TABLE "ReadingListItem" ADD COLUMN "articleKey" TEXT;

CREATE INDEX "ReadingListItem_articleKey_idx" ON "ReadingListItem"("articleKey");
