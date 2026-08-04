-- v1.11.1 — make failures visible.
--
-- Two things were happening silently. A feed that stopped resolving logged a
-- pino warning and was otherwise indistinguishable from a feed that simply
-- hadn't published; and an unhandled route error reached the client as a bare
-- 500 with nothing kept about it. Neither was answerable from the admin panel,
-- which is where someone actually looks.
--
-- Feed.* records health per subscription. ErrorLog records the incidents
-- themselves, and is pruned on write — it is diagnostics, not a record like
-- AdminAction, so it ages out.

-- ── Feed health ──
ALTER TABLE "Feed" ADD COLUMN "lastSuccessAt"       TIMESTAMP(3);
ALTER TABLE "Feed" ADD COLUMN "lastError"           TEXT;
ALTER TABLE "Feed" ADD COLUMN "lastErrorAt"         TIMESTAMP(3);
ALTER TABLE "Feed" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Feed" ADD COLUMN "failureAlertedAt"    TIMESTAMP(3);

-- Existing feeds are assumed healthy rather than unknown: every one of them has
-- been fetched by the old code path, and starting them at zero failures means
-- the first real failure is the one that gets reported. Seeding lastSuccessAt
-- from lastCheckedAt is the closest true statement available — that column was
-- only ever set by a refresh that got far enough to claim the feed.
UPDATE "Feed" SET "lastSuccessAt" = "lastCheckedAt" WHERE "lastCheckedAt" IS NOT NULL;

CREATE INDEX "Feed_consecutiveFailures_idx" ON "Feed"("consecutiveFailures");

-- ── Error log ──
CREATE TABLE "ErrorLog" (
    "id"        TEXT NOT NULL,
    "source"    TEXT NOT NULL,
    "message"   TEXT NOT NULL,
    "detail"    TEXT,
    "method"    TEXT,
    "path"      TEXT,
    "status"    INTEGER,
    "userId"    TEXT,
    "username"  TEXT,
    "feedUrl"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- No foreign key on userId, deliberately. The row has to survive the account
-- being deleted — an error that only ever hit one user is worth keeping the
-- shape of afterwards — and `username` carries the readable identity, the same
-- trade AdminAction.actorUsername makes.
CREATE INDEX "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");
CREATE INDEX "ErrorLog_source_createdAt_idx" ON "ErrorLog"("source", "createdAt");
