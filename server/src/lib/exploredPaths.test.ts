import { describe, it, expect } from 'vitest';
import { referencedUrlsIn } from './exploredPaths';
import { canonicalArticleKey } from './comments';

// What a post is *about*. This is the half of explored paths that can be tested
// without a database: given a stored post body, which articles does it cite.
//
// The input is always markup that has already been through sanitizeBlogHtml, so
// these fixtures are written the way it emits - double-quoted attributes, no
// contenteditable, entities escaped.
describe('referencedUrlsIn', () => {
  const embed = (url: string) =>
    `<span class="note-embed" data-embed="article" data-variant="large" ` +
    `data-href="/a/abc" data-url="${url}" data-title="A piece"></span>`;

  it('finds the article an embed points at', () => {
    expect(referencedUrlsIn(`<p>${embed('https://example.com/a')}</p>`))
      .toEqual(['https://example.com/a']);
  });

  it('returns nothing for a body with no embeds', () => {
    expect(referencedUrlsIn('<p>Just some writing.</p>')).toEqual([]);
    expect(referencedUrlsIn('')).toEqual([]);
  });

  // The attribute is stored HTML-escaped, so a URL carrying a query string
  // comes back with &amp; in it. Left alone, every multi-parameter link would
  // canonicalise to a different key than the one the comment thread uses.
  it('unescapes &amp; back into &', () => {
    expect(referencedUrlsIn(embed('https://example.com/a?x=1&amp;y=2')))
      .toEqual(['https://example.com/a?x=1&y=2']);
  });

  // One post about one article is one entry, however many times it says so.
  // Two spellings of the same URL collapse for the same reason threads do.
  it('lists an article once even when cited repeatedly', () => {
    const html = embed('https://example.com/a') + embed('https://example.com/a?utm_source=x');
    expect(referencedUrlsIn(html)).toEqual(['https://example.com/a']);
  });

  it('keeps genuinely different articles apart', () => {
    const html = embed('https://example.com/a') + embed('https://example.com/b');
    expect(referencedUrlsIn(html)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  // A relative href is how an embed points at something hosted here, and a
  // javascript: URL is what an attacker would try. Neither is an article on the
  // open web and neither may become a row.
  it('ignores anything that is not an http(s) address', () => {
    expect(referencedUrlsIn(embed('/a/abc'))).toEqual([]);
    expect(referencedUrlsIn(embed('javascript:alert(1)'))).toEqual([]);
    expect(referencedUrlsIn(embed('mailto:a@b.c'))).toEqual([]);
  });

  // The cap exists so one link-dump post cannot plant itself on the page of
  // every article it names.
  it('stops at twelve references', () => {
    const html = Array.from({ length: 40 }, (_, i) => embed(`https://example.com/${i}`)).join('');
    expect(referencedUrlsIn(html)).toHaveLength(12);
  });

  // The rows are keyed on the canonical form, which is what makes a post found
  // from the clean URL after being written against a tracked one.
  it('produces urls whose canonical key matches the comment thread key', () => {
    const [url] = referencedUrlsIn(embed('https://www.example.com/a/?utm_campaign=x'));
    expect(canonicalArticleKey(url)).toBe(canonicalArticleKey('https://example.com/a'));
  });
});
