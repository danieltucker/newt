import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { refreshTokenKey } from './jwt';

describe('refreshTokenKey', () => {
  /**
   * A refresh cookie's *shape*, not a credential.
   *
   * refreshTokenKey only hashes the string it is handed, so nothing here needs
   * to be a real token - what matters is that the fixture looks like what the
   * lookup will actually see: three dot-separated base64url segments.
   *
   * Assembled rather than written out as a literal, and that is deliberate. A
   * JWT literal begins `eyJ`, which is exactly what secret scanners match on,
   * and this file tripped one. The value was always a hand-made fake - its
   * "signature" is the ASCII word `signature`, nine bytes where a real HS256
   * signature is thirty-two, and no key ever signed it - but a scanner cannot
   * know that, and a repository that cries wolf gets its alerts ignored.
   * Building the string here keeps the shape without the tripwire.
   *
   * Please don't inline it again.
   */
  const seg = (s: string) => Buffer.from(s).toString('base64url');
  const token = [seg('{"alg":"HS256"}'), seg('{"sub":"user_123"}'), seg('signature')].join('.');

  it('is a 64-character hex digest', () => {
    expect(refreshTokenKey(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never contains the token it stands for', () => {
    expect(refreshTokenKey(token)).not.toContain(token);
  });

  it('is stable, so a returning cookie still finds its row', () => {
    expect(refreshTokenKey(token)).toBe(refreshTokenKey(token));
  });

  it('separates two tokens that differ by one character', () => {
    expect(refreshTokenKey(token)).not.toBe(refreshTokenKey(token + 'x'));
  });

  it('matches what the migration computes in SQL', () => {
    // The migration converts existing rows with
    //   encode(sha256(token::bytea), 'hex')
    // and this is what the lookup will compute for the same cookie. If these
    // two ever disagree, every signed-in user is signed out by the deploy.
    expect(refreshTokenKey(token)).toBe(createHash('sha256').update(token).digest('hex'));
  });
});
