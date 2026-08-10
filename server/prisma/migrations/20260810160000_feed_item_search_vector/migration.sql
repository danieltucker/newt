-- Full-text search over the river.
--
-- Search used to happen in the browser: the client pulled the 200 newest
-- articles across every subscription once at mount and filtered that array by
-- substring. Two days of a busy river, matched on headline only, is not a
-- search — an article from last week was simply not in the data being searched,
-- and no amount of raising that limit fixes it, because the ceiling is the
-- payload the browser is willing to hold, not the number.
--
-- A stored generated column rather than a trigger: the vector cannot drift out
-- of step with the row it describes, because Postgres recomputes it on every
-- write and nothing is able to write it directly. Feed items are written by the
-- refresh loop in bulk upserts, which is exactly where a trigger would be
-- forgotten.
--
-- Weights, not a flat vector. A word in the headline is what the article is
-- *about*; the same word in the snippet may be an aside in the first paragraph.
-- ts_rank reads A as roughly four times B by default, so the piece actually
-- titled "Two schools to close" outranks the roundup that mentions it in
-- passing, which is the entire difference between a result list and a pile.
--
-- `content` (the full article HTML) is deliberately left out. It would roughly
-- decuple the index for a large accuracy loss, not a gain: boilerplate, nav
-- text and syndication footers all become searchable words, and every article
-- from a site whose template says "subscribe to our newsletter" starts matching
-- a search for "newsletter".
ALTER TABLE "FeedItem"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce("snippet", '')), 'B')
  ) STORED;

-- GIN over the vector: what makes `@@` an index lookup instead of a scan of
-- every item in every feed the user follows.
--
-- CONCURRENTLY is deliberately not used, for the same reason as the BlogPost
-- tags index — it cannot run inside the transaction Prisma wraps a migration
-- in. Note that the ADD COLUMN above rewrites the table regardless, so this
-- migration wants a quiet moment on a large database.
CREATE INDEX "FeedItem_searchVector_idx" ON "FeedItem" USING GIN ("searchVector");
