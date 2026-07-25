import { describe, it, expect } from 'vitest';
import { encodeArticleId, decodeArticleId, articlePathFor, parseArticlePath } from './articleUrl';

describe('article URL round-trip', () => {
  const urls = [
    'https://arstechnica.com/space/2026/07/some-article/',
    'https://example.com/path?utm_source=x&y=1#frag',
    'https://news.example.co.uk/2026/07/24/café-über-señor',   // non-ASCII
    'http://plain.example/a',
  ];

  it('encodes and decodes back to the same URL', () => {
    for (const u of urls) {
      expect(decodeArticleId(encodeArticleId(u))).toBe(u);
    }
  });

  it('produces a URL-safe id (no +, /, or = padding)', () => {
    for (const u of urls) {
      expect(encodeArticleId(u)).not.toMatch(/[+/=]/);
    }
  });

  it('parses a path back to its URL', () => {
    for (const u of urls) {
      expect(parseArticlePath(articlePathFor(u))).toBe(u);
    }
  });

  it('returns null for non-article or malformed paths', () => {
    expect(parseArticlePath('/')).toBeNull();
    expect(parseArticlePath('/settings')).toBeNull();
    expect(parseArticlePath('/a/')).toBeNull();
    expect(parseArticlePath('/a/!!!not-base64!!!')).toBeNull();
  });

  it('rejects a decoded value that isn’t an http(s) URL', () => {
    // base64url of "javascript:alert(1)" must not resolve to a usable URL
    const bad = encodeArticleId('javascript:alert(1)');
    expect(decodeArticleId(bad)).toBeNull();
  });
});
