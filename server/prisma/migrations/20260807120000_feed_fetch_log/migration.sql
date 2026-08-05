-- A log of feed refresh attempts, successes included.
--
-- The admin panel could already say which feeds were failing, but not whether
-- the refresher had run at all. A feed showing no errors is indistinguishable
-- from a feed nobody has fetched since the last deploy, and the difference is
-- the whole diagnosis. One row per attempt answers both, and gives the timing
-- and response detail a failure line on its own never carried.
--
-- Rows expire (FEED_LOG_RETENTION_DAYS, pruned on write in lib/feedLog.ts) —
-- this is telemetry, not a record like AdminAction.

CREATE TABLE "FeedFetchLog" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "feedTitle" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL,
    "status" INTEGER,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "items" INTEGER,
    "newItems" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedFetchLog_pkey" PRIMARY KEY ("id")
);

-- The default view: everything, newest first.
CREATE INDEX "FeedFetchLog_createdAt_idx" ON "FeedFetchLog"("createdAt");
-- One feed's history, reached by clicking its row in the feed list.
CREATE INDEX "FeedFetchLog_feedId_createdAt_idx" ON "FeedFetchLog"("feedId", "createdAt");
-- The outcome filter chips, and the 24-hour tallies that label them.
CREATE INDEX "FeedFetchLog_outcome_createdAt_idx" ON "FeedFetchLog"("outcome", "createdAt");

-- No foreign key to "Feed" on purpose: a feed row can be removed and its
-- history has to survive that, exactly as "ErrorLog"."feedUrl" does.
