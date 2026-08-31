-- Personas out, AiTask/AiJob in. See the AiTask doc comment in schema.prisma
-- for why the feature was narrowed rather than extended.

-- ── Guard: never destroy somebody else's writing silently ───────────────────
--
-- Deleting a persona User cascades to its comments (Comment_userId_fkey) and
-- from there, recursively, to every reply beneath them (Comment_parentId_fkey).
-- Both are real ON DELETE CASCADE. So dropping personas can take replies written
-- by *real people* with it, and nothing in the schema would complain.
--
-- On the instance this was written for the answer was zero. It is not zero
-- everywhere, so this aborts the migration instead of assuming. If it fires,
-- reparent or tombstone those replies first — Comment.deletedAt already exists
-- for exactly this case, and is what the author-delete path in routes/comments
-- uses when a comment with replies goes away.
DO $$
DECLARE orphaned INT;
BEGIN
  SELECT COUNT(*) INTO orphaned
  FROM "Comment" reply
  JOIN "Comment" parent ON parent.id = reply."parentId"
  JOIN "User" pu ON pu.id = parent."userId" AND pu."isPersona" = true
  JOIN "User" ru ON ru.id = reply."userId" AND ru."isPersona" = false;

  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Refusing to remove personas: % repl(y/ies) from real users sit under persona comments and would be deleted by the cascade. Tombstone or reparent them first.', orphaned;
  END IF;
END $$;

-- The accounts themselves. Cascades to Persona, their comments and their posts.
DELETE FROM "User" WHERE "isPersona" = true;

-- ── Persona configuration ──────────────────────────────────────────────────
DROP TABLE "Persona";
ALTER TABLE "User" DROP COLUMN "isPersona";

-- ── Usage history survives the rename ──────────────────────────────────────
-- ALTER ... RENAME rather than drop/add: these rows are the only record of what
-- the endpoint has been doing, and the panel's latency and failure-rate figures
-- are computed over a 30-day window that spans this migration.
ALTER TABLE "SiteModelUsage" RENAME COLUMN "personaId" TO "taskId";
ALTER TABLE "SiteModelUsage" RENAME COLUMN "personaName" TO "taskLabel";
ALTER INDEX "SiteModelUsage_personaId_createdAt_idx" RENAME TO "SiteModelUsage_taskId_createdAt_idx";

-- ── The tasks ──────────────────────────────────────────────────────────────
CREATE TABLE "AiTask" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "siteModelId" TEXT,
    "trigger" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiTask_kind_enabled_idx" ON "AiTask"("kind", "enabled");
CREATE INDEX "AiTask_createdById_idx" ON "AiTask"("createdById");
CREATE INDEX "AiTask_siteModelId_idx" ON "AiTask"("siteModelId");

ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_siteModelId_fkey" FOREIGN KEY ("siteModelId") REFERENCES "SiteModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── The queue ──────────────────────────────────────────────────────────────
CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'admin',
    "articleKey" TEXT NOT NULL DEFAULT '',
    "articleUrl" TEXT NOT NULL DEFAULT '',
    "subjectId" TEXT NOT NULL DEFAULT '',
    "threadId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiJob_status_createdAt_idx" ON "AiJob"("status", "createdAt");
CREATE INDEX "AiJob_taskId_articleKey_idx" ON "AiJob"("taskId", "articleKey");

ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AiTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Generated explores ─────────────────────────────────────────────────────
-- userId becomes nullable so a generated thread can belong to nobody. The FK
-- keeps ON DELETE CASCADE: a *person's* thread still dies with them.
ALTER TABLE "ResearchThread" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "ResearchThread" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "ResearchThread" ADD COLUMN "siteModelId" TEXT;

ALTER TABLE "ResearchThread" ADD CONSTRAINT "ResearchThread_siteModelId_fkey" FOREIGN KEY ("siteModelId") REFERENCES "SiteModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Moderation ─────────────────────────────────────────────────────────────
ALTER TABLE "AiJob" ADD COLUMN "verdict" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiJob" ADD COLUMN "category" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiJob" ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX "AiJob_verdict_confidence_idx" ON "AiJob"("verdict", "confidence");

-- Reversible, and deliberately not deletedAt. See the schema comment: a
-- tombstone is the author's irreversible delete; this is a screen an automated
-- judgement put in front of content that is still there and must come back
-- intact when a moderator disagrees.
ALTER TABLE "Comment" ADD COLUMN "hiddenAt" TIMESTAMP(3);
ALTER TABLE "Comment" ADD COLUMN "hiddenReason" TEXT NOT NULL DEFAULT '';
