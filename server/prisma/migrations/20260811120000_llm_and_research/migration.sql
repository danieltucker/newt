-- v1.16.0 — bring-your-own LLM, and the research threads it writes.
--
-- Three tables, no changes to anything that already exists:
--
--   LlmCredential   one person's key for one provider. The secret is stored
--                   encrypted (AES-256-GCM, see lib/llm/secretBox); the three
--                   columns below are the ciphertext, the nonce and the auth
--                   tag, all base64. `keyLast4` is the only part of the key any
--                   route will ever hand back.
--   ResearchThread  a conversation, private to its owner. No visibility column,
--                   deliberately — research becomes public by being condensed
--                   into a BlogPost, which has one of its own.
--   ResearchMessage a turn in that conversation.
--
-- Keys are per-account rather than instance-wide: there is no operator key to
-- fall back to, so an account with no credential has the AI features off rather
-- than quietly spending somebody else's quota.

-- CreateTable
CREATE TABLE "LlmCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "keyCipher" TEXT NOT NULL,
    "keyIv" TEXT NOT NULL,
    "keyTag" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCredential_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LlmCredential_userId_idx" ON "LlmCredential"("userId");

ALTER TABLE "LlmCredential" ADD CONSTRAINT "LlmCredential_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ResearchThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "sourceTitle" TEXT NOT NULL DEFAULT '',
    "credentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchThread_pkey" PRIMARY KEY ("id")
);

-- The thread list is "mine, most recently touched first", which is this index
-- whole — no sort step.
CREATE INDEX "ResearchThread_userId_updatedAt_idx" ON "ResearchThread"("userId", "updatedAt");

ALTER TABLE "ResearchThread" ADD CONSTRAINT "ResearchThread_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: removing a key from settings must never delete the
-- research it produced. The thread stays and simply has no key attached until
-- the next question picks the current default.
ALTER TABLE "ResearchThread" ADD CONSTRAINT "ResearchThread_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "LlmCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ResearchMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchMessage_threadId_createdAt_idx" ON "ResearchMessage"("threadId", "createdAt");

ALTER TABLE "ResearchMessage" ADD CONSTRAINT "ResearchMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "ResearchThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
