import crypto from 'crypto';

/**
 * Encryption for the one class of data Newt stores that is a bearer credential
 * for somebody else's money: LLM provider API keys.
 *
 * AES-256-GCM, one random 96-bit nonce per key, authenticated. The three parts
 * are returned separately and stored in three columns (see LlmCredential) so a
 * decrypt failure is legible in the data rather than a mangled packed string.
 *
 * ── What this does and does not protect against ──
 * The key is derived from an environment variable, so this protects a database
 * dump, a stolen backup, or a `pg_dump` in a support ticket — the realistic
 * ways a hobby-scale deployment leaks its rows. It does *not* protect against
 * an attacker who already has code execution on the server, because that
 * attacker has the environment too. Nothing short of a KMS would, and a KMS is
 * not a reasonable dependency for something people run on a NAS.
 *
 * The point is that the keys are never at rest in plaintext, and are never
 * returned by any route — see credentials.ts.
 */

// Same shape as lib/jwt: refuse to start in production without a real secret,
// but let a dev machine come up with a fixed one so `npm run dev` works with an
// empty .env. A dev-secret database is not portable to production, which is the
// correct outcome: those rows decrypt to keys that were only ever local.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.LLM_KEY_SECRET) {
    throw new Error(
      'LLM_KEY_SECRET must be set in production — it encrypts stored LLM API keys. ' +
      'Generate one with: openssl rand -base64 32',
    );
  }
}

const SECRET = process.env.LLM_KEY_SECRET || 'change-me-llm-key-secret';

/**
 * The 32-byte AES key, derived once at load.
 *
 * scrypt rather than a bare hash of the env var, so a short or low-entropy
 * LLM_KEY_SECRET costs something to attack. The salt is fixed and public
 * because the input is a server secret, not a user password — a per-row salt
 * would mean storing it, and it would buy nothing here: there is exactly one
 * secret, so there are no rainbow tables across users to defeat.
 */
const AES_KEY = crypto.scryptSync(SECRET, 'newt-llm-key-v1', 32);

export interface SealedSecret {
  cipher: string; // base64
  iv: string;     // base64
  tag: string;    // base64
}

export function sealSecret(plaintext: string): SealedSecret {
  const iv = crypto.randomBytes(12);
  const box = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const cipher = Buffer.concat([box.update(plaintext, 'utf8'), box.final()]);
  return {
    cipher: cipher.toString('base64'),
    iv: iv.toString('base64'),
    tag: box.getAuthTag().toString('base64'),
  };
}

/**
 * Returns null rather than throwing on any failure — a wrong secret, a
 * truncated column, a row written by a different deployment. Every caller has
 * to handle "this key can't be used" anyway (the provider could equally have
 * revoked it), so one branch covers both and a corrupt row can't take down the
 * settings screen.
 */
export function openSecret(sealed: SealedSecret): string | null {
  try {
    const box = crypto.createDecipheriv('aes-256-gcm', AES_KEY, Buffer.from(sealed.iv, 'base64'));
    box.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      box.update(Buffer.from(sealed.cipher, 'base64')),
      box.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The tail of a key, for telling two of them apart in a list.
 *
 * Four characters of a 100-plus-bit secret is not a meaningful disclosure, and
 * it is the only part of the key that ever leaves the server. Short keys are
 * masked entirely rather than half-shown.
 */
export function last4(key: string): string {
  const trimmed = key.trim();
  return trimmed.length >= 12 ? trimmed.slice(-4) : '';
}
