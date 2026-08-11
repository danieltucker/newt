import { describe, it, expect } from 'vitest';
import { extractReadable, articleBodyFromJsonLd } from './articleFetch';

/**
 * The extractor, on the shapes real pages actually come in.
 *
 * Nothing here touches the network — `fetchArticleText` is the half that does,
 * and it is the half whose behaviour is "return '' on anything unexpected".
 * What is worth testing is the judgement call: given a page, which part of it
 * is the article.
 */

/** ~40 characters a go, so a handful of these clears the 600-char floor. */
function para(n: number, word = 'sentence'): string {
  return Array.from({ length: n }, (_, i) => `<p>This is body ${word} number ${i} of the article.</p>`).join('');
}

describe('extractReadable', () => {
  it('takes the <article> over the page around it', () => {
    const html = `
      <html><body>
        <nav><a href="/a">Home</a><a href="/b">Politics</a><a href="/c">Sport</a></nav>
        <article>${para(20)}</article>
        <footer><p>Copyright somebody, all rights reserved.</p></footer>
      </body></html>`;
    const text = extractReadable(html);
    expect(text).toContain('body sentence number 0');
    expect(text).not.toContain('Politics');
    expect(text).not.toContain('Copyright');
  });

  it('does not stop at the first nested close tag', () => {
    // The bug a lazy <div>...</div> regex has: it closes on the inner div and
    // returns the byline, which on a real page is about nine words.
    const html = `<div class="post-content"><div class="byline"><p>By A Reporter</p></div>${para(20)}</div>`;
    const text = extractReadable(html);
    expect(text).toContain('body sentence number 19');
  });

  it('prefers the content div over a longer navigation column', () => {
    // The rail is far longer in characters and has almost no paragraphs, which
    // is exactly why the score counts <p> text rather than everything.
    const rail = `<div class="rail"><ul>${
      Array.from({ length: 200 }, (_, i) => `<li><a href="/x${i}">Some other headline ${i}</a></li>`).join('')
    }</ul></div>`;
    const html = `<body>${rail}<div id="article-body">${para(20)}</div></body>`;
    const text = extractReadable(html);
    expect(text).toContain('body sentence number 3');
    expect(text).not.toContain('Some other headline');
  });

  it('drops scripts, styles and comment markup rather than reading them', () => {
    const html = `
      <body>
        <script>var tracking = "This is body sentence number 999 of the article";</script>
        <style>.x { content: "buy now"; }</style>
        <!-- <p>A commented-out draft paragraph.</p> -->
        <article>${para(20)}</article>
      </body>`;
    const text = extractReadable(html);
    expect(text).not.toContain('tracking');
    expect(text).not.toContain('buy now');
    expect(text).not.toContain('commented-out');
    expect(text).toContain('body sentence number 1');
  });

  it('returns nothing for a page with no article in it', () => {
    // A consent wall or a paywall stub. Reporting '' rather than the chrome is
    // the point: the caller falls back to the feed's copy, which is better.
    const html = '<body><div id="content"><p>Please accept cookies to continue.</p></div></body>';
    expect(extractReadable(html)).toBe('');
  });

  it('survives an unclosed tag without hanging or throwing', () => {
    const html = `<body><article>${para(20)}`;
    expect(() => extractReadable(html)).not.toThrow();
  });

  it('keeps paragraph breaks so the prose does not run together', () => {
    const html = `<article>${para(20)}</article>`;
    expect(extractReadable(html)).toContain('\n');
  });
});

describe('articleBodyFromJsonLd', () => {
  const body = `A real article body. ${'Words and words and words. '.repeat(40)}`;

  it('reads articleBody from a bare object', () => {
    const html = `<script type="application/ld+json">${
      JSON.stringify({ '@type': 'NewsArticle', articleBody: body })
    }</script>`;
    expect(articleBodyFromJsonLd(html)).toContain('A real article body.');
  });

  it('finds it inside @graph', () => {
    const html = `<script type="application/ld+json">${
      JSON.stringify({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'NewsArticle', articleBody: body }] })
    }</script>`;
    expect(articleBodyFromJsonLd(html)).toContain('A real article body.');
  });

  it('skips a malformed block to reach a good one', () => {
    // Four LD+JSON blocks on a page is normal, and one of them being invalid
    // must not cost us the one that parses.
    const html =
      '<script type="application/ld+json">{ not json </script>' +
      `<script type="application/ld+json">${JSON.stringify({ articleBody: body })}</script>`;
    expect(articleBodyFromJsonLd(html)).toContain('A real article body.');
  });

  it('ignores a stub too short to be the article', () => {
    const html = `<script type="application/ld+json">${
      JSON.stringify({ articleBody: 'Subscribe to read.' })
    }</script>`;
    expect(articleBodyFromJsonLd(html)).toBeNull();
  });

  it('is null when the page publishes no JSON-LD at all', () => {
    expect(articleBodyFromJsonLd('<body><p>Nothing structured here.</p></body>')).toBeNull();
  });

  it('wins over the markup, since it is the publisher saying which part is the piece', () => {
    const html =
      `<script type="application/ld+json">${JSON.stringify({ articleBody: body })}</script>` +
      `<article>${para(20, 'markup')}</article>`;
    const text = extractReadable(html);
    expect(text).toContain('A real article body.');
    expect(text).not.toContain('body markup number');
  });
});
