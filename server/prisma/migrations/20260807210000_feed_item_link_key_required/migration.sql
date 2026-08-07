-- Make FeedItem.linkKey required, so the river can dedupe on it.
--
-- The river shows one card per linkKey now (two feeds carrying the same article
-- was dealing it twice). SQL treats NULLs as equal for DISTINCT, so a single
-- null-keyed row would collapse every other null-keyed row into it and the rest
-- would vanish from the feed entirely. Requiring the column makes that
-- impossible rather than merely unlikely.
--
-- The nulls are legacy: rows written before the column existed. Every write path
-- (feedRefresh, blogFeed) has set it on both create and update since, so live
-- feeds have already backfilled themselves on their next poll; what is left
-- belongs to feeds that have gone dormant.
--
-- `link` is the fallback rather than a computed canonical key: the real
-- canonicalArticleKey() strips tracking parameters and normalises the host in
-- JS, which SQL can't reproduce faithfully, and a wrong key would merge two
-- articles that are not the same. The raw link is always distinct per row within
-- a feed (there is a unique index on it), so it is a safe identity. Any of these
-- rows still in a live feed will be rewritten with the true key on its next
-- refresh.
UPDATE "FeedItem" SET "linkKey" = "link" WHERE "linkKey" IS NULL;

ALTER TABLE "FeedItem" ALTER COLUMN "linkKey" SET NOT NULL;
