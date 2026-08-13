import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_ACCESS_SECRET)  throw new Error('JWT_ACCESS_SECRET must be set in production');
  if (!process.env.JWT_REFRESH_SECRET) throw new Error('JWT_REFRESH_SECRET must be set in production');
}

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'change-me-access';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change-me-refresh';
const TOTP_PENDING_SECRET = (process.env.JWT_ACCESS_SECRET || 'change-me-access') + '-totp-pending';

export const ACCESS_TTL = '15m';
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function signAccess(userId: string): string {
  return jwt.sign({ sub: userId }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

export function signRefresh(userId: string): string {
  return jwt.sign({ sub: userId }, REFRESH_SECRET, { expiresIn: '7d' });
}

// Short-lived token (3 min) issued after password check when TOTP is required
export function signTotpPending(userId: string): string {
  return jwt.sign({ sub: userId, type: 'totp-pending' }, TOTP_PENDING_SECRET, { expiresIn: '3m' });
}

export function verifyAccess(token: string): { sub: string } {
  return jwt.verify(token, ACCESS_SECRET) as { sub: string };
}

export function verifyRefresh(token: string): { sub: string } {
  return jwt.verify(token, REFRESH_SECRET) as { sub: string };
}

export function verifyTotpPending(token: string): { sub: string } {
  const payload = jwt.verify(token, TOTP_PENDING_SECRET) as { sub: string; type: string };
  if (payload.type !== 'totp-pending') throw new Error('Invalid token type');
  return payload;
}

/**
 * What goes in the RefreshToken table in place of the token itself.
 *
 * A refresh token is a bearer credential good for seven days, and the table
 * used to hold the whole thing in the clear - so a database dump, a backup or a
 * `pg_dump` pasted into a support thread handed over every live session on the
 * instance, ready to use. The same reasoning that put LLM keys behind
 * lib/llm/secretBox applies here, and more sharply: these are credentials for
 * this server rather than someone else's.
 *
 * Hashed rather than encrypted, because unlike an API key nothing ever needs to
 * read it back. The server only asks "is the token in this cookie one I
 * issued?", which a digest answers. There is no key to lose and nothing to
 * decrypt if the column leaks.
 *
 * Plain SHA-256, not bcrypt: the input is a 200-plus-character signed JWT with
 * full entropy, not a human-chosen password, so there is no dictionary to slow
 * down - and this runs on every refresh, where a deliberately slow hash would
 * only be a cost. The row is still worthless without the signing secret.
 */
export function refreshTokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
