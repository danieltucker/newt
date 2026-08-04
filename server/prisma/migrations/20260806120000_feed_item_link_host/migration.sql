-- v1.11.2 — site pages need to know where an article actually lives.
--
-- A site page (/s/<domain>) gathers everything one publisher has dealt into
-- this account's feed. The obvious way to find those items is by the feed's own
-- address, and it is wrong often enough to be useless: Ars Technica publishes
-- at feeds.arstechnica.com, so /s/arstechnica.com — the domain printed on every
-- one of its cards, and the URL a person would guess — matched nothing at all.
--
-- The article's own link is the right key. Storing its host rather than
-- deriving one per row at query time is what lets the lookup use an index
-- instead of scanning every item the instance holds.

ALTER TABLE "FeedItem" ADD COLUMN "linkHost" TEXT;

-- Backfill, normalised exactly as articleHost() does it in lib/comments.ts —
-- which is `new URL(link).hostname`, lowercased, `www.` stripped. Reproducing
-- that in SQL means taking the authority (everything up to the first /?#) and
-- then dropping the two parts of it a hostname doesn't include: any `user@`
-- ahead of the host, and any `:port` after it.
--
-- Rows whose link isn't a URL are left NULL, which is a value no lookup
-- matches — the same outcome articleHost's '' gives on the write path. They
-- also fix themselves: every refresh re-upserts linkHost, so anything this
-- misses is corrected the next time its feed is polled.
UPDATE "FeedItem"
SET "linkHost" = lower(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        substring("link" from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]+)'),
        '^.*@', ''            -- userinfo
      ),
      ':[0-9]+$', ''          -- port
    ),
    '^www\.', ''
  )
)
WHERE "link" ~ '^[A-Za-z][A-Za-z0-9+.-]*://';

-- Compound, and in this order: every site-page query is "this user's feeds,
-- this host", and the feed filter is the selective half. A lone linkHost index
-- would be scanned for the whole instance and then filtered down to one account.
CREATE INDEX "FeedItem_feedId_linkHost_idx" ON "FeedItem"("feedId", "linkHost");
