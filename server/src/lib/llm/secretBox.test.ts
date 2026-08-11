import { describe, it, expect } from 'vitest';
import { sealSecret, openSecret, last4 } from './secretBox';

describe('sealSecret / openSecret', () => {
  it('round-trips a key', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(openSecret(sealSecret(key))).toBe(key);
  });

  it('produces a different ciphertext each time', () => {
    // A fresh nonce per seal, so two accounts storing the same key are not
    // visibly storing the same key.
    const a = sealSecret('sk-test-same-key-value');
    const b = sealSecret('sk-test-same-key-value');
    expect(a.cipher).not.toBe(b.cipher);
    expect(a.iv).not.toBe(b.iv);
  });

  it('round-trips unicode and empty strings', () => {
    expect(openSecret(sealSecret('ключ-🔑-key'))).toBe('ключ-🔑-key');
    expect(openSecret(sealSecret(''))).toBe('');
  });

  it('returns null rather than throwing on a tampered ciphertext', () => {
    // The auth tag is the point: a flipped byte must not decrypt to anything.
    const sealed = sealSecret('sk-test-abcdefghijklmnop');
    const bytes = Buffer.from(sealed.cipher, 'base64');
    bytes[0] ^= 0xff;
    expect(openSecret({ ...sealed, cipher: bytes.toString('base64') })).toBeNull();
  });

  it('returns null on a tampered auth tag', () => {
    const sealed = sealSecret('sk-test-abcdefghijklmnop');
    const tag = Buffer.from(sealed.tag, 'base64');
    tag[0] ^= 0xff;
    expect(openSecret({ ...sealed, tag: tag.toString('base64') })).toBeNull();
  });

  it('returns null on garbage rather than throwing', () => {
    // What a row written by a deployment with a different LLM_KEY_SECRET looks
    // like. The settings screen must survive it.
    expect(openSecret({ cipher: 'not-base64!!', iv: 'nope', tag: 'nope' })).toBeNull();
  });
});

describe('last4', () => {
  it('takes the tail of a real-length key', () => {
    expect(last4('sk-ant-api03-abcdefgh1234')).toBe('1234');
  });

  it('masks a short string entirely', () => {
    // Four characters of a short secret is a meaningful fraction of it.
    expect(last4('short')).toBe('');
  });
});
