import { describe, it, expect } from 'vitest';
import { encodeArticleId, decodeArticleId, articlePathFor, parseArticlePath } from './articleUrl';
import { canonicalArticleKey } from './articleKey';

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

  // The readable form drops a trailing slash and a fragment, so a path is not
  // required to give back a byte-identical URL - it is required to give back the
  // same *article*, which is what canonicalArticleKey answers and what every
  // comment thread and reading-list row is keyed on.
  it('parses a path back to the same article', () => {
    for (const u of urls) {
      const back = parseArticlePath(articlePathFor(u));
      expect(back).not.toBeNull();
      expect(canonicalArticleKey(back!)).toBe(canonicalArticleKey(u));
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

describe('the readable form: /s/<host>/<path>', () => {
  it('is what a plain https article gets', () => {
    expect(articlePathFor('https://www.cascadiadaily.com/2026/sep/05/fairhaven-taphouse/'))
      .toBe('/s/www.cascadiadaily.com/2026/sep/05/fairhaven-taphouse');
  });

  it('strips the tracking tail that made the old links enormous', () => {
    const long = 'https://www.cascadiadaily.com/2026/sep/05/fairhaven-taphouse/'
      + '?utm_source=rss&utm_medium=rss&utm_campaign=fairhaven-taphouse';
    expect(articlePathFor(long)).toBe('/s/www.cascadiadaily.com/2026/sep/05/fairhaven-taphouse');
  });

  it('keeps www, because the path is fetched and not just compared', () => {
    // canonicalArticleKey drops it; this must not, or an apex with no
    // certificate of its own becomes an article that will not load.
    expect(articlePathFor('https://www.theverge.com/a/b')).toBe('/s/www.theverge.com/a/b');
    expect(parseArticlePath('/s/www.theverge.com/a/b')).toBe('https://www.theverge.com/a/b');
  });

  it('reads a nested path back whole', () => {
    expect(parseArticlePath('/s/example.com/2026/07/24/a-slug'))
      .toBe('https://example.com/2026/07/24/a-slug');
  });

  it('leaves /s/<domain> alone - that is the publisher page', () => {
    expect(parseArticlePath('/s/example.com')).toBeNull();
    expect(parseArticlePath('/s/example.com/')).toBeNull();
    expect(parseArticlePath('/s/')).toBeNull();
  });

  it('rejects a first segment that is not a hostname', () => {
    expect(parseArticlePath('/s/not a host/x')).toBeNull();
    expect(parseArticlePath('/s/localhost/x')).toBeNull();
    expect(parseArticlePath('/s/../../etc/passwd')).toBeNull();
  });

  it('falls back to /a/ for the URLs it cannot carry losslessly', () => {
    // http: the scheme is not in the path, so it cannot be assumed back
    expect(articlePathFor('http://plain.example/a')).toMatch(/^\/a\//);
    // a real query: ?c= is the reader's own, so an article query would collide
    expect(articlePathFor('https://example.com/?p=1234')).toMatch(/^\/a\//);
    // the site's front page has no path to put below the host
    expect(articlePathFor('https://example.com/')).toMatch(/^\/a\//);
    // a port is not part of the /s/<domain> shape
    expect(articlePathFor('https://example.com:8443/a')).toMatch(/^\/a\//);
  });

  it('still parses links minted before it existed', () => {
    const old = '/a/' + encodeArticleId('https://example.com/old-link?utm_source=x');
    expect(parseArticlePath(old)).toBe('https://example.com/old-link?utm_source=x');
  });
});
