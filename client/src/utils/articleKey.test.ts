import { describe, it, expect } from 'vitest';
import { canonicalArticleKey } from './articleKey';

describe('canonicalArticleKey', () => {
  it('ignores scheme, www and a trailing slash', () => {
    expect(canonicalArticleKey('http://www.example.com/post/')).toBe(
      canonicalArticleKey('https://example.com/post'));
  });

  it('drops tracking params but keeps real ones', () => {
    expect(canonicalArticleKey('https://example.com/p?utm_source=rss&id=7&fbclid=x'))
      .toBe('example.com/p?id=7');
  });

  it('sorts the params that survive', () => {
    expect(canonicalArticleKey('https://example.com/p?b=2&a=1'))
      .toBe(canonicalArticleKey('https://example.com/p?a=1&b=2'));
  });

  it('falls back to the trimmed string for a non-URL', () => {
    expect(canonicalArticleKey('  Not A URL ')).toBe('not a url');
  });
});
