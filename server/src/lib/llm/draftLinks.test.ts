import { describe, it, expect } from 'vitest';
import { draftLinks } from './draftLinks';

describe('draftLinks', () => {
  it('finds ordinary anchors', () => {
    const html = '<p>See <a href="https://example.com/one">this</a> and ' +
      '<a href="https://other.test/two">that</a>.</p>';
    expect(draftLinks(html, 5)).toEqual(['https://example.com/one', 'https://other.test/two']);
  });

  // The card's href points at Newt's own reader for the article, so the source
  // it actually cites is only on data-url. Reading hrefs alone found the reader.
  it('reads the source off a reference card, not its href', () => {
    const html = '<span class="note-embed" data-embed="article" data-href="/a/abc" ' +
      'data-url="https://example.com/piece" data-title="A piece"></span>';
    expect(draftLinks(html, 5)).toEqual(['https://example.com/piece']);
  });

  it('drops anything that is not an absolute http(s) URL', () => {
    const html = '<a href="/a/local">x</a><a href="mailto:me@example.com">y</a>' +
      '<a href="javascript:alert(1)">z</a><img src="https://example.com/pic.png">';
    expect(draftLinks(html, 5)).toEqual([]);
  });

  it('deduplicates on the canonical key, keeping the first form seen', () => {
    const html = '<a href="https://example.com/one?utm_source=rss">a</a>' +
      '<a href="https://www.example.com/one">b</a>';
    expect(draftLinks(html, 5)).toEqual(['https://example.com/one?utm_source=rss']);
  });

  it('stops at the cap, keeping the draft\'s own order', () => {
    const html = ['a', 'b', 'c', 'd']
      .map(p => `<a href="https://example.com/${p}">${p}</a>`).join('');
    expect(draftLinks(html, 2)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  // Stored markup escapes the query separator, and a URL fetched with a
  // parameter called "amp;b" is a different URL.
  it('unescapes the entities a sanitizer writes into attributes', () => {
    const html = '<a href="https://example.com/x?a=1&amp;b=2">x</a>';
    expect(draftLinks(html, 5)).toEqual(['https://example.com/x?a=1&b=2']);
  });

  it('handles single-quoted attributes and an empty body', () => {
    expect(draftLinks("<a href='https://example.com/q'>q</a>", 5))
      .toEqual(['https://example.com/q']);
    expect(draftLinks('', 5)).toEqual([]);
  });
});
