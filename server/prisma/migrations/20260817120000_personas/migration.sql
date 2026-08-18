-- v1.22.0 — AI personas.
--
-- An admin can generate an account that writes with a configured voice, and
-- summon it to post an article, comment on one, or reply to somebody. Two
-- things this migration is deliberate about:
--
--   1. A persona is a User, not a new kind of author. It gets a row in "User"
--      like anybody else, so posts, comments, profiles, friendships, blocking
--      and reporting all keep working with no new code paths. What it gets extra
--      is a "Persona" row holding the tone dials.
--
--   2. "User"."isPersona" duplicates the existence of that row on purpose.
--      Every surface rendering an author has to disclose that it is an AI, and
--      those are the hottest queries in the app (comment trees, feed cards,
--      profile headers). A join per author for one boolean is not worth it —
--      this is the trade "isAdmin" already makes.
--
-- The two are written together in one transaction by routes/adminPersonas.ts.
-- A "Persona" row whose user lacks the flag would be an undisclosed AI account,
-- which is the single outcome the labelling rule exists to prevent.

ALTER TABLE "User" ADD COLUMN "isPersona" BOOLEAN NOT NULL DEFAULT false;

-- Stated rather than left to the default. The default governs rows written from
-- now on; this says that nothing which already exists becomes a persona, which
-- is the claim that actually matters for an instance with real accounts on it.
UPDATE "User" SET "isPersona" = false;

CREATE TABLE "Persona" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    -- The tone dials. TEXT with defaults rather than an enum type: adding a
    -- voice should be a line in a lookup table, not a migration that rewrites a
    -- Postgres type. Validated in lib/llm/personaPrompts on every write, so an
    -- unknown value cannot be stored even though the column would hold one.
    "voice"       TEXT NOT NULL DEFAULT 'neutral',
    "verbosity"   TEXT NOT NULL DEFAULT 'balanced',
    "formality"   TEXT NOT NULL DEFAULT 'neutral',
    "interests"   TEXT[] DEFAULT ARRAY[]::TEXT[],
    "guidance"    TEXT NOT NULL DEFAULT '',
    -- Paused, not banned. A ban is a moderation record about a user; this is an
    -- operator switch, and putting "switched off my own bot" in the ban log
    -- beside real enforcement would corrupt that record.
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- One persona per account: the persona *is* the account, so two configurations
-- pointing at one identity has no meaning.
CREATE UNIQUE INDEX "Persona_userId_key" ON "Persona"("userId");
CREATE INDEX "Persona_createdById_idx" ON "Persona"("createdById");

-- Deleting the account takes its configuration with it.
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE. An admin deleting their own account must not silently
-- delete the personas the instance is still running; losing the attribution is
-- much the lesser harm.
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
