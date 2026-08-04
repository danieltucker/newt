import { describe, it, expect } from 'vitest';
import { normalizeDomain } from './sites';

// The site key travels from a card byline, through a URL, to a database query.
// Every hop is somewhere a spelling can drift, so the normaliser is what makes
// /s/WWW.Example.com/ and /s/example.com the same page. Its client-side twin is
// siteDomainOf in client/src/utils/siteUrl.ts - the two must agree.
describe('normalizeDomain', () => {
  it('lowercases, drops the scheme, www and any path', () => {
    expect(normalizeDomain('HTTPS://WWW.ArsTechnica.com/gadgets/x')).toBe('arstechnica.com');
  });

  it('accepts a bare hostname', () => {
    expect(normalizeDomain('theverge.com')).toBe('theverge.com');
  });

  it('keeps a subdomain that is not www', () => {
    expect(normalizeDomain('blog.cloudflare.com')).toBe('blog.cloudflare.com');
  });

  it('drops a trailing dot and a query string', () => {
    expect(normalizeDomain('https://example.com./a?b=c#d')).toBe('example.com');
  });

  it('rejects anything that is not a public hostname', () => {
    for (const bad of ['', '   ', 'localhost', 'not a domain', 'example', '.com', 'http://']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });

  it('rejects a hostname longer than DNS allows', () => {
    expect(normalizeDomain(`${'a'.repeat(300)}.com`)).toBeNull();
  });
});
