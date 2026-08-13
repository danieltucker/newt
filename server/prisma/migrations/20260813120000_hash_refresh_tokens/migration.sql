-- Refresh tokens are stored as a SHA-256 digest rather than as the token.
--
-- The column held the whole signed JWT in the clear, so anyone reading the
-- table - a dump, a backup, a `pg_dump` in a support thread - held every live
-- session on the instance, usable for up to seven days. Nothing ever needs to
-- read the value back (the only question asked of it is "did I issue this?"),
-- so a digest is enough. See server/src/lib/jwt.ts refreshTokenKey.
--
-- Rewritten in place rather than truncated: the plaintext is right here, so the
-- rows can be converted to exactly what the new lookup will compute, and no one
-- is signed out by the deploy. `sha256` is built into PostgreSQL 11+ and needs
-- no extension; `encode(..., 'hex')` matches Node's .digest('hex').
--
-- Rows already 64 hex characters long are skipped, so re-running this is safe.
UPDATE "RefreshToken"
SET "token" = encode(sha256("token"::bytea), 'hex')
WHERE "token" !~ '^[0-9a-f]{64}$';
