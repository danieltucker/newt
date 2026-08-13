import { describe, it, expect } from 'vitest';
import { parseDomain, parseLink, bookmarkHref, faviconUrl, deriveName, deriveColor } from './color';

describe('parseDomain (host only)', () => {
  it('returns a bare host', () => {
    expect(parseDomain('github.com')).toBe('github.com');
  });

  it('strips protocol and www', () => {
    expect(parseDomain('https://github.com')).toBe('github.com');
    expect(parseDomain('http://www.github.com')).toBe('github.com');
  });

  it('drops any path - host only', () => {
    expect(parseDomain('github.com/danieltucker')).toBe('github.com');
    expect(parseDomain('https://www.github.com/a/b?q=1')).toBe('github.com');
  });

  it('lowercases', () => {
    expect(parseDomain('GitHub.COM')).toBe('github.com');
  });

  it('rejects things that are not a host', () => {
    expect(parseDomain('')).toBeNull();
    expect(parseDomain('ab')).toBeNull();       // too short / no dot
    expect(parseDomain('localhost')).toBeNull(); // no dot
  });
});

describe('parseLink (host + path)', () => {
  it('keeps a bare host unchanged', () => {
    expect(parseLink('github.com')).toBe('github.com');
  });

  // Regression: editing a bookmark from "github.com" to "github.com/danieltucker"
  // used to silently drop the path (parseDomain split on "/"), so the change
  // looked like it never saved. parseLink must preserve it.
  it('preserves the path (regression: github.com/danieltucker)', () => {
    expect(parseLink('github.com/danieltucker')).toBe('github.com/danieltucker');
    expect(parseLink('https://www.github.com/danieltucker')).toBe('github.com/danieltucker');
  });

  it('lowercases the host but preserves path case', () => {
    expect(parseLink('GitHub.com/DanielTucker')).toBe('github.com/DanielTucker');
  });

  it('keeps query strings and deeper paths', () => {
    expect(parseLink('example.com/a/b?x=1')).toBe('example.com/a/b?x=1');
    expect(parseLink('sub.example.com/path')).toBe('sub.example.com/path');
  });

  it('trims a trailing slash', () => {
    expect(parseLink('github.com/')).toBe('github.com');
    expect(parseLink('github.com/danieltucker/')).toBe('github.com/danieltucker');
  });

  it('rejects things without a valid host', () => {
    expect(parseLink('')).toBeNull();
    expect(parseLink('ab')).toBeNull();
    expect(parseLink('localhost/foo')).toBeNull(); // host has no dot
  });

  // Regression: a LAN address saved scheme-less, and bookmarkHref reads that as
  // https - so a router or NAS on plain http was unreachable, and typing the
  // http:// back in did nothing because it was stripped on the way to the save.
  it('keeps an explicit http:// scheme', () => {
    expect(parseLink('http://192.168.1.15')).toBe('http://192.168.1.15');
    expect(parseLink('http://192.168.1.15:8096/web')).toBe('http://192.168.1.15:8096/web');
    expect(parseLink('HTTP://192.168.1.15')).toBe('http://192.168.1.15');
  });

  // https is what a scheme-less bookmark already means, so keeping it would only
  // put "https://" in front of every tile's subtitle.
  it('drops https://, which is the default', () => {
    expect(parseLink('https://github.com')).toBe('github.com');
  });

  it('round-trips, so re-editing a saved link does not change it', () => {
    expect(parseLink(parseLink('http://192.168.1.15')!)).toBe('http://192.168.1.15');
    expect(parseLink(parseLink('github.com/danieltucker')!)).toBe('github.com/danieltucker');
  });
});

describe('bookmarkHref', () => {
  it('prepends https to a scheme-less bookmark', () => {
    expect(bookmarkHref('github.com')).toBe('https://github.com');
    expect(bookmarkHref('github.com/danieltucker')).toBe('https://github.com/danieltucker');
  });

  // Following a blog stores a full profile URL in `domain`. Prefixing that
  // produced https://http//localhost:5173/u/name, which resolves nowhere.
  it('leaves an absolute URL alone', () => {
    expect(bookmarkHref('http://localhost:5173/u/ellis')).toBe('http://localhost:5173/u/ellis');
    expect(bookmarkHref('https://example.com/u/ellis')).toBe('https://example.com/u/ellis');
    // The form parseLink now stores for a link typed with http://.
    expect(bookmarkHref('http://192.168.1.15')).toBe('http://192.168.1.15');
  });
});

describe('faviconUrl', () => {
  it('builds a favicon URL from a bare host', () => {
    expect(faviconUrl('github.com')).toBe('/api/v1/util/favicon?domain=github.com');
  });

  // The favicon service only wants the host, so a stored link with a path must
  // still resolve the correct favicon.
  it('strips a path down to the host', () => {
    expect(faviconUrl('github.com/danieltucker')).toBe('/api/v1/util/favicon?domain=github.com');
    expect(faviconUrl('https://github.com/a/b?q=1')).toBe('/api/v1/util/favicon?domain=github.com');
  });
});

describe('deriveName', () => {
  it('capitalizes the first label of the host', () => {
    expect(deriveName('github.com')).toBe('Github');
    expect(deriveName('sub.example.com')).toBe('Sub');
    expect(deriveName('example.co.uk')).toBe('Example');
  });

  // "192" is not a name for anything.
  it('names an address after itself', () => {
    expect(deriveName('192.168.1.15')).toBe('192.168.1.15');
    expect(deriveName('192.168.1.15:8096')).toBe('192.168.1.15:8096');
  });
});

describe('deriveColor', () => {
  it('is deterministic for a given input', () => {
    expect(deriveColor('github.com')).toBe(deriveColor('github.com'));
  });

  it('returns a hex colour', () => {
    expect(deriveColor('github.com')).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
