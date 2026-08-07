-- When a feed item first entered the river.
--
-- fetchedAt could not be used for this: it is rewritten on every refresh, and a
-- 304 rewrites it for every item in the feed at once so the TTL sweep doesn't
-- delete a feed that simply hasn't published lately. Counting "new since you
-- loaded" off that column reports whole unchanged feeds as new.
ALTER TABLE "FeedItem" ADD COLUMN "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing rows get their last fetch time rather than the moment of this
-- migration. It is the closest thing already recorded to when they arrived, and
-- stamping them all "now" would make every article in the database look new to
-- the first person who opened their feed after deploying.
UPDATE "FeedItem" SET "firstSeenAt" = "fetchedAt";

CREATE INDEX "FeedItem_feedId_firstSeenAt_idx" ON "FeedItem"("feedId", "firstSeenAt");
