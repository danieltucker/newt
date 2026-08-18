// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from './markdown';
import { sanitizePastedHtml } from './pasteHtml';

// The editor's source view is a round trip: the document is shown as markdown,
// edited, and read back. The property that matters is not that the markdown is
// pretty - it is that going out and back does not lose anything. Every case here
// is a construct the editor can write, and the assertion is on what survives.

/** What the source view does end to end: HTML → markdown → HTML. */
const roundTrip = (html: string) =>
  sanitizePastedHtml(markdownToHtml(htmlToMarkdown(html), { source: true }));

describe('htmlToMarkdown', () => {
  it('writes the constructs markdown has', () => {
    expect(htmlToMarkdown('<h2>Title</h2><p>Some <b>bold</b> and <i>slant</i>.</p>').trim())
      .toBe('## Title\n\nSome **bold** and *slant*.');
  });

  it('writes lists, nesting and numbering included', () => {
    expect(htmlToMarkdown('<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>').trim())
      .toBe('- one\n  - deep\n- two');
    expect(htmlToMarkdown('<ol><li>first</li><li>second</li></ol>').trim())
      .toBe('1. first\n2. second');
  });

  it('writes to-dos with their tick', () => {
    expect(htmlToMarkdown(
      '<div class="note-todo" data-checked="true">done</div>'
      + '<div class="note-todo" data-checked="false">not</div>').trim())
      .toBe('- [x] done\n\n- [ ] not');
  });

  it('writes a quote, a rule and a code block', () => {
    expect(htmlToMarkdown('<blockquote>said</blockquote><hr><pre>one\ntwo</pre>').trim())
      .toBe('> said\n\n---\n\n```\none\ntwo\n```');
  });

  it('writes a table as pipes', () => {
    expect(htmlToMarkdown(
      '<table class="note-table"><thead><tr><th>a</th><th>b</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>').trim())
      .toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('writes a link and a plain image', () => {
    expect(htmlToMarkdown('<p><a href="https://x.test/a">there</a></p>').trim())
      .toBe('[there](https://x.test/a)');
    expect(htmlToMarkdown('<p><img src="/api/v1/images/a" alt="a cat"></p>').trim())
      .toBe('![a cat](/api/v1/images/a)');
  });

  // The whole reason the source view is allowed to contain HTML at all: none of
  // these have a markdown spelling, and dropping them would make the view a
  // trap rather than a tool.
  it('falls back to HTML for what markdown cannot say', () => {
    const md = htmlToMarkdown(
      '<p><span class="note-fg-red">red</span> and <u>under</u></p>'
      + '<span class="note-embed" data-embed="article" data-url="https://x.test/a">card</span>'
      + '<p><img src="/api/v1/images/a" alt="" width="400"></p>');
    expect(md).toContain('<span class="note-fg-red">red</span>');
    expect(md).toContain('<u>under</u>');
    expect(md).toContain('class="note-embed"');
    expect(md).toContain('width="400"');
  });

  it('escapes text that would otherwise read as markdown', () => {
    expect(htmlToMarkdown('<p>2 * 3 and [brackets]</p>').trim())
      .toBe('2 \\* 3 and \\[brackets\\]');
  });
});

describe('the source view round trip', () => {
  it.each([
    ['a heading and prose', '<h2>Title</h2><p>Some <b>bold</b> words.</p>'],
    ['a nested list', '<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>'],
    ['a numbered list', '<ol><li>first</li><li>second</li></ol>'],
    ['a quote', '<blockquote>said so</blockquote>'],
    ['a rule', '<hr>'],
    ['a link', '<p><a href="https://x.test/a">there</a></p>'],
    ['an image', '<p><img src="/api/v1/images/a" alt="a cat"></p>'],
    ['strike and code', '<p><s>gone</s> and <code>fn()</code></p>'],
  ])('keeps %s exactly', (_name, html) => {
    expect(roundTrip(html)).toBe(html);
  });

  it('keeps a code block\'s lines', () => {
    expect(roundTrip('<pre>one\ntwo</pre>')).toBe('<pre><code>one\ntwo</code></pre>');
  });

  it('keeps a table and its class', () => {
    const out = roundTrip(
      '<table class="note-table"><thead><tr><th>a</th></tr></thead>'
      + '<tbody><tr><td>1</td></tr></tbody></table>');
    expect(out).toContain('class="note-table"');
    expect(out).toContain('<th>a</th>');
    expect(out).toContain('<td>1</td>');
  });

  it('keeps a to-do and whether it was ticked', () => {
    const out = roundTrip('<div class="note-todo" data-checked="true">done</div>');
    expect(out).toContain('class="note-todo"');
    expect(out).toContain('data-checked="true"');
    expect(out).toContain('done');
  });

  // Switching to markdown and back must not quietly delete somebody's work.
  it('keeps a reference embed whole', () => {
    const embed = '<span class="note-embed" data-embed="article" data-variant="large" '
      + 'data-url="https://x.test/a" data-title="A headline">'
      + '<a class="note-embed-a" href="/a/abc"><span class="note-embed-title">A headline</span></a></span>';
    const out = roundTrip(embed);
    expect(out).toContain('class="note-embed"');
    expect(out).toContain('data-title="A headline"');
    expect(out).toContain('class="note-embed-title"');
  });

  it('keeps a colour', () => {
    expect(roundTrip('<p><span class="note-fg-red">red</span> words</p>'))
      .toBe('<p><span class="note-fg-red">red</span> words</p>');
  });

  it('keeps the width an author resized a picture to', () => {
    expect(roundTrip('<p><img src="/api/v1/images/a" alt="" width="400" height="300"></p>'))
      .toContain('width="400"');
  });

  it('keeps a line break inside a paragraph', () => {
    expect(roundTrip('<p>one<br>two</p>')).toBe('<p>one<br>two</p>');
  });

  it('does not read the escaping back as formatting', () => {
    expect(roundTrip('<p>2 * 3 and [brackets]</p>')).toBe('<p>2 * 3 and [brackets]</p>');
  });
});

describe('markdownToHtml with source off, which is every other caller', () => {
  // The safety property a pasted clipboard relies on: no tags in the result but
  // the ones this module put there.
  it('still escapes raw HTML', () => {
    const out = markdownToHtml('<span class="note-embed">x</span>\n\nand <b>bold</b>');
    expect(out).not.toContain('<span');
    expect(out).toContain('&lt;span');
    expect(out).toContain('&lt;b&gt;bold');
  });
});
