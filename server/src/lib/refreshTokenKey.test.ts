import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { refreshTokenKey } from './jwt';

describe('refreshTokenKey', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJl';

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
