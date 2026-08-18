-- v1.23.0 — site models in the admin panel, and usage monitoring.
--
-- v1.22.0 configured the personas' model entirely through OPERATOR_LLM_BASE_URL
-- and OPERATOR_LLM_MODEL. That works but means a shell session to change a model
-- name. Endpoints now live in a table an admin edits, and personas may override
-- which one writes for them.
--
-- WHAT DID *NOT* MOVE INTO THE DATABASE: which private hosts may be reached.
-- That stays in OPERATOR_LLM_PRIVATE_HOSTS in the environment. Editing a row
-- needs an admin web session; editing the environment needs the host. Since the
-- site model is the only call permitted to reach inside the network, the
-- capability stays on the more expensive side of that line while the day-to-day
-- settings move to the cheaper one. See server/src/lib/llm/operatorEnv.ts.
--
-- The old environment variables keep working as a fallback when no row exists,
-- so upgrading does not switch personas off.

CREATE TABLE "SiteModel" (
    "id"          TEXT NOT NULL,
    "label"       TEXT NOT NULL DEFAULT '',
    "baseUrl"     TEXT NOT NULL,
    "model"       TEXT NOT NULL,
    -- Sealed with AES-256-GCM exactly as LlmCredential's key is, and never
    -- returned by any route. Empty is normal: a local Ollama has no auth.
    "keyCipher"   TEXT NOT NULL DEFAULT '',
    "keyIv"       TEXT NOT NULL DEFAULT '',
    "keyTag"      TEXT NOT NULL DEFAULT '',
    "keyLast4"    TEXT NOT NULL DEFAULT '',
    "isDefault"   BOOLEAN NOT NULL DEFAULT false,
    -- Off without being deleted, for a box that is down for maintenance.
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteModel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiteModel_createdById_idx" ON "SiteModel"("createdById");

-- SET NULL: an admin deleting their own account must not take the instance's
-- model configuration with them.
ALTER TABLE "SiteModel" ADD CONSTRAINT "SiteModel_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Personas may name an endpoint ───────────────────────────────────────────
-- NULL means "the instance default", which is what nearly every persona should
-- be: on a single GPU only one model is resident at a time, so two personas on
-- one endpoint with different models make Ollama unload and reload between them.
ALTER TABLE "Persona" ADD COLUMN "siteModelId" TEXT;
CREATE INDEX "Persona_siteModelId_idx" ON "Persona"("siteModelId");

-- SET NULL, not CASCADE. Removing an endpoint falls its personas back to the
-- default; it must never delete them.
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_siteModelId_fkey"
    FOREIGN KEY ("siteModelId") REFERENCES "SiteModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Usage log ───────────────────────────────────────────────────────────────
-- Every attempt, successes and failures alike. A failure-only log cannot tell a
-- healthy endpoint from one nothing has called since the last deploy — the same
-- reasoning FeedFetchLog was built on.
--
-- For a self-hosted GPU the useful numbers are not money but latency, tokens per
-- second and failure rate. durationMs is the one that exposes model swapping.
CREATE TABLE "SiteModelUsage" (
    "id"           TEXT NOT NULL,
    "siteModelId"  TEXT,
    -- Denormalised so a row stays readable after its endpoint or persona is
    -- deleted — and a persona is often deleted precisely because of what it
    -- wrote, which is when this log matters most.
    "modelLabel"   TEXT NOT NULL DEFAULT '',
    "modelName"    TEXT NOT NULL DEFAULT '',
    "personaId"    TEXT,
    "personaName"  TEXT NOT NULL DEFAULT '',
    -- 'comment' | 'reply' | 'post' | 'identity' | 'test'
    "kind"         TEXT NOT NULL,
    -- 'success' | 'failed'
    "outcome"      TEXT NOT NULL,
    -- 0 is a real value meaning "not reported": Ollama only sends usage on newer
    -- versions, and a call that failed before the first byte never had any.
    "inputTokens"  INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs"   INTEGER NOT NULL DEFAULT 0,
    "error"        TEXT NOT NULL DEFAULT '',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteModelUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiteModelUsage_createdAt_idx" ON "SiteModelUsage"("createdAt");
CREATE INDEX "SiteModelUsage_siteModelId_createdAt_idx" ON "SiteModelUsage"("siteModelId", "createdAt");
CREATE INDEX "SiteModelUsage_personaId_createdAt_idx" ON "SiteModelUsage"("personaId", "createdAt");

-- SET NULL rather than CASCADE: deleting an endpoint must not erase the record
-- of what it did.
ALTER TABLE "SiteModelUsage" ADD CONSTRAINT "SiteModelUsage_siteModelId_fkey"
    FOREIGN KEY ("siteModelId") REFERENCES "SiteModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
