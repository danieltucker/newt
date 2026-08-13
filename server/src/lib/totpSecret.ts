import { sealSecret, openSecret } from './llm/secretBox';

/**
 * At-rest protection for TOTP shared secrets.
 *
 * A TOTP secret is the second factor. Whoever holds it can generate valid codes
 * for that account forever, and unlike a password it is not hashable - the
 * server has to be able to read it back to check a code, so it can only be
 * encrypted. It was being stored as bare base32, which meant a database dump
 * defeated two-factor authentication for every enrolled user on the instance:
 * exactly the threat lib/llm/secretBox was written for, applied to a credential
 * for this server rather than for someone else's API.
 *
 * Reuses secretBox (AES-256-GCM under LLM_KEY_SECRET) rather than introducing a
 * second key: one server secret to configure and rotate is a feature, and the
 * threat model in that file - a leaked dump, not a compromised host - is the
 * same one here.
 *
 * Packed into a single string rather than the three columns LlmCredential uses,
 * because there are two of these (`totpSecret` and `totpPendingSecret`) and six
 * columns to say what two can. The `v1:` prefix is what makes the packing
 * self-describing, and is also the migration: base32 is `[A-Z2-7]` and can
 * never contain a colon, so a stored value either announces itself as sealed or
 * is a plaintext secret written before this existed.
 */

const PREFIX = 'v1:';

export function sealTotpSecret(base32: string): string {
  const { cipher, iv, tag } = sealSecret(base32);
  return `${PREFIX}${iv}:${tag}:${cipher}`;
}

/** True if `stored` is already sealed - i.e. does not need re-writing. */
export function isSealedTotpSecret(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/**
 * The base32 secret, whether the column holds a sealed value or a plaintext one
 * written before sealing existed.
 *
 * Returns null only when a sealed value fails to open, which in practice means
 * LLM_KEY_SECRET changed. Callers treat that as "this code cannot be checked"
 * and refuse the sign-in rather than letting anyone past - see routes/auth.
 *
 * That does couple 2FA to a key whose name says LLM: rotating LLM_KEY_SECRET
 * now locks every enrolled user out until an admin clears `totpEnabled` and
 * `totpSecret` for them, where before it only invalidated stored API keys.
 * Worth knowing before rotating it; the alternative was leaving the secrets in
 * the clear, which is worse.
 */
export function openTotpSecret(stored: string): string | null {
  if (!isSealedTotpSecret(stored)) return stored;   // legacy plaintext
  const [, iv, tag, ...rest] = stored.split(':');
  if (!iv || !tag || rest.length === 0) return null;
  return openSecret({ iv, tag, cipher: rest.join(':') });
}
