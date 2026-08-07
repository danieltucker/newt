-- Feeds can be switched off without being destroyed.
--
-- Until now nothing ever stopped polling a broken feed: a URL that had 404ed for
-- a month was still fetched every 30 minutes for as long as one subscriber kept
-- opening it, and its articles aged out after the 7-day TTL, leaving an empty
-- entry that never explained itself. Deleting the feed was the only lever, and it
-- is the wrong one — a dead URL is usually a moved one, and the Feed row is what
-- the subscriptions point at.
--
-- disabledAt is that missing middle. See the note on the column in schema.prisma
-- for why claimFeed, not the scheduler, is where it is enforced.
ALTER TABLE "Feed" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "Feed" ADD COLUMN "disabledReason" TEXT;

CREATE INDEX "Feed_disabledAt_idx" ON "Feed"("disabledAt");

-- Existing feeds all start enabled, including ones already deep into a failure
-- run. Back-filling "disabled" for anything currently over the threshold was
-- tempting and is wrong: it would silently switch off a batch of feeds at deploy
-- time with no admin having decided that, and the first anyone would know is a
-- reader asking where their articles went. They disable on their next failure
-- through the normal path instead, which at least writes a log line and a bell.

-- Hosts this instance refuses to poll. 'domain' matches the host and its
-- subdomains; 'suffix' matches a whole domain extension.
CREATE TABLE "BlockedDomain" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByUsername" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedDomain_pkey" PRIMARY KEY ("id")
);

-- One rule per pattern. Patterns are normalised before they are written, so this
-- also catches "EXAMPLE.com", "https://example.com/" and "www.example.com" being
-- offered as three separate rules for the same thing.
CREATE UNIQUE INDEX "BlockedDomain_pattern_key" ON "BlockedDomain"("pattern");
CREATE INDEX "BlockedDomain_kind_idx" ON "BlockedDomain"("kind");
