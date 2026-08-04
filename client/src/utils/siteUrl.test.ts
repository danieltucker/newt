import { describe, it, expect } from 'vitest';
import { siteDomainOf, sitePathFor, parseSitePath } from './siteUrl';

describe('siteDomainOf', () => {
  it('takes the host out of a full URL', () => {
    expect(siteDomainOf('https://arstechnica.com/gadgets/2026/thing/')).toBe('arstechnica.com');
  });

  it('drops www and lowercases', () => {
    expect(siteDomainOf('HTTPS://WWW.Arstechnica.COM')).toBe('arstechnica.com');
  });

  it('passes a bare hostname through', () => {
    expect(siteDomainOf('arstechnica.com')).toBe('arstechnica.com');
  });

  it('keeps a subdomain that isn’t www', () => {
    expect(siteDomainOf('https://blog.cloudflare.com/x')).toBe('blog.cloudflare.com');
  });

  it('drops a trailing dot and a query', () => {
    expect(siteDomainOf('https://example.com./a?b=c')).toBe('example.com');
  });
});

describe('sitePathFor / parseSitePath', () => {
  it('round-trips', () => {
    for (const d of ['arstechnica.com', 'blog.cloudflare.com', 'news.ycombinator.com']) {
      expect(parseSitePath(sitePathFor(d))).toBe(d);
    }
  });

  it('normalises on the way in', () => {
    expect(sitePathFor('https://www.theverge.com/tech')).toBe('/s/theverge.com');
  });

  it('ignores paths that aren’t site pages', () => {
    expect(parseSitePath('/')).toBeNull();
    expect(parseSitePath('/settings')).toBeNull();
    expect(parseSitePath('/s/')).toBeNull();
  });

  it('rejects a host that isn’t one', () => {
    expect(parseSitePath('/s/localhost')).toBeNull();
    expect(parseSitePath('/s/not a domain')).toBeNull();
    expect(parseSitePath('/s/example.com/extra')).toBeNull();
  });

  it('tolerates a trailing slash', () => {
    expect(parseSitePath('/s/example.com/')).toBe('example.com');
  });
});
