-- Full-text search over the two things written *here*, rather than fetched.
--
-- The archive has had a search vector since 20260810160000, so "search" has so
-- far meant "search the river". The search page asks the wider question — what
-- is on this instance about X — and the other two corpora that can answer it
-- are posts and explores. Both were reachable only by already knowing where
-- they were: a post through its author's profile, an explore through the
-- article it was started from.
--
-- Stored generated columns rather than triggers, for the reason the FeedItem
-- one gives: the vector cannot drift out of step with the row it describes,
-- because Postgres recomputes it on every write and nothing is able to write it
-- directly. Both tables are written from several places (the composer, the
-- share dialog, the AI task runner), which is exactly the shape a trigger gets
-- forgotten in.

-- ── Posts ──────────────────────────────────────────────────────────────────
--
-- Title as A, excerpt as B, tags as C. The author's own labels are a real
-- signal — a post tagged "postgres" is about postgres — but a weaker one than
-- the sentence they wrote to summarise it, so they rank below the excerpt
-- rather than beside it.
--
-- `body` is left out for the same reason FeedItem excludes `content`: it is
-- sanitized HTML, so every tag name, image path and embed attribute in it would
-- become a searchable word. `span`, `data-url` and the hostname of every
-- referenced article are not what anybody is searching for, and a body-weighted
-- vector is dominated by them.
-- A generated column's expression must be IMMUTABLE, and `array_to_string` is
-- only STABLE: it is declared over `anyarray`, and for some element types the
-- output function can depend on a runtime setting. Postgres has no way to know
-- that this particular call cannot, so it refuses the column outright.
--
-- For text[] with a constant separator the conversion genuinely is pure - there
-- is no output function to consult and nothing to depend on - so this wrapper
-- makes that promise in the one narrow case where it is true. Typed to text[]
-- rather than anyarray deliberately: the promise is exactly as wide as the
-- guarantee behind it.
CREATE FUNCTION newt_array_to_string(text[], text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $fn$ SELECT array_to_string($1, $2) $fn$;

ALTER TABLE "BlogPost"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce("excerpt", '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(newt_array_to_string("tags", ' '), '')), 'C')
  ) STORED;

CREATE INDEX "BlogPost_searchVector_idx" ON "BlogPost" USING GIN ("searchVector");

-- ── Explores ───────────────────────────────────────────────────────────────
--
-- Title as A, the source article's title as B. A thread's title is taken from
-- the opening question, so it is already a fair summary of what was asked; the
-- source title is what it was asked *about*, which is how somebody looks for
-- "that thread I had about the Rosetta piece".
--
-- The transcript is deliberately not indexed here. Message bodies are where a
-- thread's substance is, but they are also where articleContext's quoting of
-- the reader's own private comments and reading-list notes ends up (see
-- lib/exploredPaths for the long version). Indexing them would make a
-- friends-visible thread matchable on words its author never wrote and does not
-- know are in there. Titles are the author's own words, so that is what this
-- searches.
ALTER TABLE "ResearchThread"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce("sourceTitle", '')), 'B')
  ) STORED;

CREATE INDEX "ResearchThread_searchVector_idx" ON "ResearchThread" USING GIN ("searchVector");

-- Text search over one's own threads narrows by userId first and by the
-- visibility tier for everyone else's. The existing index leads with sourceKey,
-- which neither query has a value for.
CREATE INDEX "ResearchThread_visibility_idx" ON "ResearchThread" ("visibility");
