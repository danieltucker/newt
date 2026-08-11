import { describe, it, expect } from 'vitest';
import { renderContext, ArticleContext } from './articleContext';

/**
 * What the model is told about the material it was handed.
 *
 * `articleContextFor` needs a database and is covered by the route tests; this
 * is the pure half, and it is the half that decides whether a model summarises
 * an article it never read.
 */

function ctx(over: Partial<ArticleContext> = {}): ArticleContext {
  return {
    title: 'A Headline',
    url: 'https://example.test/a',
    text: 'The body of the piece.',
    source: 'stored',
    comments: [],
    ...over,
  };
}

describe('renderContext', () => {
  it('labels a full stored article and adds no caveat', () => {
    const out = renderContext(ctx());
    expect(out).toContain('content="full"');
    expect(out).not.toContain('NOTE:');
  });

  it('labels text read off the page', () => {
    expect(renderContext(ctx({ source: 'fetched' }))).toContain('content="full-page"');
  });

  it('warns, in so many words, when all it has is the feed summary', () => {
    const out = renderContext(ctx({ source: 'summary', text: 'Two sentences of teaser.' }));
    expect(out).toContain('content="summary"');
    expect(out).toMatch(/only the summary/i);
    // The caveat has to precede the material. Inside the block it would be
    // indistinguishable from something the article itself said.
    expect(out.indexOf('NOTE:')).toBeLessThan(out.indexOf('<article'));
  });

  it('warns harder when there is no text at all', () => {
    const out = renderContext(ctx({ source: 'none', text: '' }));
    expect(out).toContain('content="none"');
    expect(out).toMatch(/none of this article.s text could be retrieved/i);
    expect(out).toMatch(/do not describe or summarise its contents/i);
    expect(out).toContain('[no article text could be retrieved');
  });

  it('fences the comments separately from the article', () => {
    const out = renderContext(ctx({ comments: [{ author: 'ana', body: 'Good piece.' }] }));
    expect(out).toContain('<comments>');
    expect(out).toContain('ana: Good piece.');
    expect(out.indexOf('</article>')).toBeLessThan(out.indexOf('<comments>'));
  });

  it('leaves the comments block out entirely when there are none', () => {
    expect(renderContext(ctx())).not.toContain('<comments>');
  });

  it('does not let a quote in the title break out of the attribute', () => {
    // A headline containing a double quote would otherwise close the attribute
    // early and turn the rest of the title into markup the model has to guess at.
    const out = renderContext(ctx({ title: 'The "Best" Thing' }));
    expect(out).toContain(`title="The 'Best' Thing"`);
    expect(out).not.toContain('title="The "Best" Thing"');
  });
});
