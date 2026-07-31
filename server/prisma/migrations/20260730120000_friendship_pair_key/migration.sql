-- Give every friendship a direction-independent identity.
--
-- @@unique([requesterId, addresseeId]) only constrains one direction, so
-- simultaneous A->B and B->A requests could both pass the "already exists?" read
-- and both insert, leaving two pending rows for a single pair. pairKey collapses
-- both directions onto one value so the database can reject the second writer.

ALTER TABLE "Friendship" ADD COLUMN "pairKey" TEXT;

UPDATE "Friendship"
SET "pairKey" = CASE
  WHEN "requesterId" < "addresseeId" THEN "requesterId" || ':' || "addresseeId"
  ELSE "addresseeId" || ':' || "requesterId"
END;

-- Collapse any duplicate pairs the race already created, keeping the most
-- meaningful row: an accepted friendship beats a pending request, and among
-- equals the oldest wins.
DELETE FROM "Friendship" f
USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "pairKey"
    ORDER BY CASE WHEN "status" = 'accepted' THEN 0 ELSE 1 END, "createdAt"
  ) AS rn
  FROM "Friendship"
) dup
WHERE f."id" = dup.id AND dup.rn > 1;

ALTER TABLE "Friendship" ALTER COLUMN "pairKey" SET NOT NULL;

CREATE UNIQUE INDEX "Friendship_pairKey_key" ON "Friendship"("pairKey");
