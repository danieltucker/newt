import { describe, it, expect } from 'vitest';
import { sealTotpSecret, openTotpSecret, isSealedTotpSecret } from './totpSecret';

// A real speakeasy secret shape: base32, uppercase, no padding.
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe('totpSecret', () => {
  it('round-trips a secret', () => {
    expect(openTotpSecret(sealTotpSecret(SECRET))).toBe(SECRET);
  });

  it('does not store the secret in the clear', () => {
    expect(sealTotpSecret(SECRET)).not.toContain(SECRET);
  });

  it('uses a fresh nonce, so the same secret seals differently each time', () => {
    expect(sealTotpSecret(SECRET)).not.toBe(sealTotpSecret(SECRET));
  });

  it('reads a legacy plaintext secret unchanged', () => {
    // Base32 can never contain a colon, so a stored value with no `v1:` prefix
    // is unambiguously one written before sealing existed.
    expect(isSealedTotpSecret(SECRET)).toBe(false);
    expect(openTotpSecret(SECRET)).toBe(SECRET);
  });

  it('recognises its own output as sealed, so it is never double-sealed', () => {
    expect(isSealedTotpSecret(sealTotpSecret(SECRET))).toBe(true);
  });

  it('returns null for a tampered ciphertext rather than a wrong secret', () => {
    const sealed = sealTotpSecret(SECRET);
    const parts = sealed.split(':');
    // Flip a character of the ciphertext; GCM's tag must catch it.
    const cipher = parts[3];
    parts[3] = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1);
    expect(openTotpSecret(parts.join(':'))).toBeNull();
  });

  it('returns null for a truncated sealed value', () => {
    expect(openTotpSecret('v1:onlyonepart')).toBeNull();
  });
});
