import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdown';

describe('markdownToHtml', () => {
  it('renders paragraphs, joining wrapped lines', () => {
    expect(markdownToHtml('one\ntwo\n\nthree')).toBe('<p>one two</p>\n<p>three</p>');
  });

  it('demotes H1 to H2 and keeps the rest', () => {
    // The post's title is its own field and renders as the page heading, so an
    // H1 in the body would be a second one.
    expect(markdownToHtml('# Title')).toBe('<h2>Title</h2>');
    expect(markdownToHtml('### Deeper')).toBe('<h3>Deeper</h3>');
  });

  it('renders both kinds of list', () => {
    expect(markdownToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(markdownToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders emphasis, code and links', () => {
    expect(markdownToHtml('**bold** and *italic*')).toBe('<p><strong>bold</strong> and <em>italic</em></p>');
    expect(markdownToHtml('use `npm run dev`')).toBe('<p>use <code>npm run dev</code></p>');
    expect(markdownToHtml('[Newt](https://example.com)')).toBe('<p><a href="https://example.com">Newt</a></p>');
  });

  it('escapes HTML in the source — there is no passthrough path', () => {
    expect(markdownToHtml('<script>alert(1)</script>'))
      .toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('drops a non-http link target but keeps its text', () => {
    expect(markdownToHtml('[click](javascript:alert)')).toBe('<p>click</p>');
    expect(markdownToHtml('[click](/relative/path)')).toBe('<p>click</p>');
  });

  it('still refuses a javascript: target when the URL contains parentheses', () => {
    // The URL pattern stops at the first ')', so a nested one leaves a stray
    // bracket in the text. Ugly, and not the part that matters: no href is
    // emitted, which is the assertion worth pinning.
    const out = markdownToHtml('[click](javascript:alert(1))');
    expect(out).not.toContain('href');
    expect(out).toContain('click');
  });

  it('leaves markdown inside a code span alone', () => {
    // The reason code spans are lifted out before emphasis runs.
    expect(markdownToHtml('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('keeps a fenced block literal', () => {
    const out = markdownToHtml('```\n# not a heading\n- not a list\n```');
    expect(out).toBe('<pre><code># not a heading\n- not a list</code></pre>');
  });

  it('closes an unterminated fence at the end of input', () => {
    expect(markdownToHtml('```\nx')).toBe('<pre><code>x</code></pre>');
  });

  it('reads a rule as a rule, not a bullet', () => {
    expect(markdownToHtml('---')).toBe('<hr>');
  });

  it('joins consecutive quote lines into one blockquote', () => {
    expect(markdownToHtml('> a\n> b')).toBe('<blockquote><p>a b</p></blockquote>');
  });

  it('leaves a stray underscore in prose alone', () => {
    // Emphasis only fires when the delimiters hug non-space, so file names and
    // identifiers survive.
    expect(markdownToHtml('the file_name_here stays')).toBe('<p>the file_name_here stays</p>');
  });

  it('leaves an unpaired backtick as itself', () => {
    expect(markdownToHtml('a ` b')).toBe('<p>a ` b</p>');
  });

  it('returns nothing for empty input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('\n\n  \n')).toBe('');
  });
});
