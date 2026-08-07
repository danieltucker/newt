import { describe, it, expect } from 'vitest';
import {
  normalizeBlockPattern,
  ruleMatchesHost,
  matchRule,
  hostOf,
  blockedMessage,
  type BlockPattern,
} from './feedBlocklist';

const domain = (pattern: string): BlockPattern => ({ kind: 'domain', pattern });
const suffix = (pattern: string): BlockPattern => ({ kind: 'suffix', pattern });

describe('normalizeBlockPattern', () => {
  it('reads a bare host with a dot in it as a domain rule', () => {
    expect(normalizeBlockPattern('example.com')).toEqual(domain('example.com'));
  });

  it('reads a leading dot as a suffix rule', () => {
    expect(normalizeBlockPattern('.xyz')).toEqual(suffix('.xyz'));
    expect(normalizeBlockPattern('.co.uk')).toEqual(suffix('.co.uk'));
  });

  it('reads a single label as a suffix rule even without the dot', () => {
    // "ru" is never a real feed origin, so it can only mean the extension.
    expect(normalizeBlockPattern('ru')).toEqual(suffix('.ru'));
  });

  it('keeps an explicit dot prefix on a multi-label pattern', () => {
    // ".example.com" means subdomains of it, which the suffix kind expresses
    // exactly — and unlike the domain kind, it does not match the bare host.
    expect(normalizeBlockPattern('.example.com')).toEqual(suffix('.example.com'));
  });

  it('accepts a pasted URL and keeps only the host', () => {
    expect(normalizeBlockPattern('https://example.com/rss/feed.xml?x=1')).toEqual(domain('example.com'));
    expect(normalizeBlockPattern('http://user:pw@example.com:8443/feed')).toEqual(domain('example.com'));
  });

  it('strips a port, path and userinfo without a scheme present', () => {
    expect(normalizeBlockPattern('example.com:8080/feed')).toEqual(domain('example.com'));
    expect(normalizeBlockPattern('user@example.com')).toEqual(domain('example.com'));
  });

  it('lowercases and trims', () => {
    expect(normalizeBlockPattern('  EXAMPLE.CoM  ')).toEqual(domain('example.com'));
  });

  it('collapses a www. prefix, since the domain rule already covers subdomains', () => {
    expect(normalizeBlockPattern('www.example.com')).toEqual(domain('example.com'));
  });

  it('drops a trailing dot from a fully-qualified name', () => {
    expect(normalizeBlockPattern('example.com.')).toEqual(domain('example.com'));
  });

  it('rejects input that is not a hostname', () => {
    for (const bad of ['', '   ', '.', '..', '*.example.com', 'exa mple.com', 'exam_ple.com', 'ex!ample.com']) {
      expect(normalizeBlockPattern(bad), bad).toBeNull();
    }
  });

  it('rejects a hyphen at a label boundary', () => {
    expect(normalizeBlockPattern('-example.com')).toBeNull();
    expect(normalizeBlockPattern('example-.com')).toBeNull();
  });

  it('rejects IP literals', () => {
    // Not a domain rule, and it would behave surprisingly under the subdomain
    // match. Private space is already refused by the SSRF guard.
    expect(normalizeBlockPattern('192.168.1.1')).toBeNull();
    expect(normalizeBlockPattern('8.8.8.8')).toBeNull();
  });

  it('rejects a pattern longer than a hostname can be', () => {
    expect(normalizeBlockPattern(`${'a'.repeat(250)}.com`)).toBeNull();
  });
});

describe('ruleMatchesHost — domain rules', () => {
  it('matches the host itself and its subdomains', () => {
    expect(ruleMatchesHost(domain('example.com'), 'example.com')).toBe(true);
    expect(ruleMatchesHost(domain('example.com'), 'news.example.com')).toBe(true);
    expect(ruleMatchesHost(domain('example.com'), 'a.b.example.com')).toBe(true);
  });

  it('does not match a host that merely ends with the same characters', () => {
    // The whole reason matching is done on labels: endsWith alone blocks this.
    expect(ruleMatchesHost(domain('example.com'), 'notexample.com')).toBe(false);
    expect(ruleMatchesHost(domain('example.com'), 'myexample.com')).toBe(false);
  });

  it('does not match a different domain that contains the pattern', () => {
    expect(ruleMatchesHost(domain('example.com'), 'example.com.evil.net')).toBe(false);
  });

  it('is case insensitive and tolerates a trailing dot', () => {
    expect(ruleMatchesHost(domain('example.com'), 'News.EXAMPLE.com')).toBe(true);
    expect(ruleMatchesHost(domain('example.com'), 'example.com.')).toBe(true);
  });
});

describe('ruleMatchesHost — suffix rules', () => {
  it('matches every host under the extension', () => {
    expect(ruleMatchesHost(suffix('.xyz'), 'example.xyz')).toBe(true);
    expect(ruleMatchesHost(suffix('.xyz'), 'news.example.xyz')).toBe(true);
  });

  it('does not match a dotless host', () => {
    // ICANN prohibits dotless domains, so nothing is served from one. Matching
    // it is what previously made '.example.com' block 'example.com' as well.
    expect(ruleMatchesHost(suffix('.xyz'), 'xyz')).toBe(false);
  });

  it('does not match on a partial label', () => {
    // ".ru" must not block "peru" or anything ending in those letters mid-label.
    expect(ruleMatchesHost(suffix('.ru'), 'peru')).toBe(false);
    expect(ruleMatchesHost(suffix('.ru'), 'example.peru')).toBe(false);
    expect(ruleMatchesHost(suffix('.ru'), 'example.ru')).toBe(true);
  });

  it('handles multi-label extensions', () => {
    expect(ruleMatchesHost(suffix('.co.uk'), 'bbc.co.uk')).toBe(true);
    expect(ruleMatchesHost(suffix('.co.uk'), 'bbc.co.uk.example.com')).toBe(false);
  });

  it('does not match the parent of the extension', () => {
    expect(ruleMatchesHost(suffix('.example.com'), 'example.com')).toBe(false);
    expect(ruleMatchesHost(suffix('.example.com'), 'news.example.com')).toBe(true);
  });

  it('never matches an empty host', () => {
    expect(ruleMatchesHost(suffix('.xyz'), '')).toBe(false);
    expect(ruleMatchesHost(domain('example.com'), '')).toBe(false);
  });
});

describe('matchRule', () => {
  const rules = [domain('spam.example'), suffix('.xyz'), domain('ads.net')];

  it('returns the first rule that covers the host', () => {
    expect(matchRule(rules, 'feeds.ads.net')).toEqual(domain('ads.net'));
    expect(matchRule(rules, 'anything.xyz')).toEqual(suffix('.xyz'));
  });

  it('returns null when nothing matches', () => {
    expect(matchRule(rules, 'example.com')).toBeNull();
  });

  it('returns null for an empty rule set', () => {
    expect(matchRule([], 'example.com')).toBeNull();
  });
});

describe('hostOf', () => {
  it('extracts and lowercases the host', () => {
    expect(hostOf('https://News.Example.com/feed')).toBe('news.example.com');
  });

  it('rejects non-http(s) schemes', () => {
    // A feed URL is only ever fetched over http(s); anything else is not a thing
    // the blocklist should be asked to reason about.
    expect(hostOf('file:///etc/passwd')).toBeNull();
    expect(hostOf('javascript:alert(1)')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(hostOf('not a url')).toBeNull();
    expect(hostOf('')).toBeNull();
  });
});

describe('blockedMessage', () => {
  it('words a suffix rule as an address class, not a site', () => {
    expect(blockedMessage(suffix('.xyz'))).toContain('.xyz addresses');
    expect(blockedMessage(domain('example.com'))).toContain('from example.com');
  });
});
