import { describe, it, expect } from 'vitest';
import { markdownToHtml, inlineMarkdown, looksLikeMarkdown } from './markdown';

describe('looksLikeMarkdown', () => {
  it('spots block constructs', () => {
    expect(looksLikeMarkdown('# Heading')).toBe(true);
    expect(looksLikeMarkdown('- one\n- two')).toBe(true);
    expect(looksLikeMarkdown('1. one')).toBe(true);
    expect(looksLikeMarkdown('> quoted')).toBe(true);
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n|---|---|')).toBe(true);
  });

  it('spots paired inline markers', () => {
    expect(looksLikeMarkdown('this is **bold** text')).toBe(true);
    expect(looksLikeMarkdown('call `run()` first')).toBe(true);
  });

  // The whole point of the guard: ordinary prose must paste as ordinary prose.
  it('leaves plain text alone', () => {
    expect(looksLikeMarkdown('Just a sentence.')).toBe(false);
    expect(looksLikeMarkdown('')).toBe(false);
    expect(looksLikeMarkdown('   ')).toBe(false);
    expect(looksLikeMarkdown('3 * 4 * 5')).toBe(false);
    expect(looksLikeMarkdown('a file_name_here in prose')).toBe(false);
    expect(looksLikeMarkdown('a hyphen - mid sentence')).toBe(false);
  });
});

describe('inlineMarkdown', () => {
  it('handles the emphasis markers', () => {
    expect(inlineMarkdown('**bold**')).toBe('<b>bold</b>');
    expect(inlineMarkdown('*italic*')).toBe('<i>italic</i>');
    expect(inlineMarkdown('***both***')).toBe('<b><i>both</i></b>');
    expect(inlineMarkdown('~~gone~~')).toBe('<s>gone</s>');
    expect(inlineMarkdown('`code`')).toBe('<code>code</code>');
  });

  it('does not read emphasis inside code', () => {
    expect(inlineMarkdown('`a ** b`')).toBe('<code>a ** b</code>');
    expect(inlineMarkdown('`_x_`')).toBe('<code>_x_</code>');
  });

  // Single underscores inside a word are how identifiers are spelled and how
  // nobody spells emphasis, so they are left alone. Doubled underscores are
  // strong emphasis in every markdown implementation there is, so those are
  // honoured even though it means a pasted `__init__` comes out bold - the
  // alternative is disagreeing with the format we claim to be reading.
  it('leaves underscores inside words alone', () => {
    expect(inlineMarkdown('some_file_name')).toBe('some_file_name');
    expect(inlineMarkdown('a_b and c_d')).toBe('a_b and c_d');
    expect(inlineMarkdown('__strong__')).toBe('<b>strong</b>');
  });

  it('escapes html in the source', () => {
    expect(inlineMarkdown('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
    expect(inlineMarkdown('**<b>**')).toBe('<b>&lt;b&gt;</b>');
  });

  it('writes links', () => {
    expect(inlineMarkdown('[a](https://x.com)')).toBe('<a href="https://x.com">a</a>');
    expect(inlineMarkdown('[a](/rel)')).toBe('<a href="/rel">a</a>');
    expect(inlineMarkdown('[a](example.com)')).toBe('<a href="https://example.com">a</a>');
  });

  // A pasted document is somebody else's text; its URLs do not get to run.
  it('refuses script urls, keeping the text', () => {
    expect(inlineMarkdown('[a](javascript:alert(1))')).toContain('javascript');
    expect(inlineMarkdown('[a](javascript:alert(1))')).not.toContain('<a');
    expect(inlineMarkdown('[a](data:text/html,x)')).not.toContain('<a');
  });
});

describe('markdownToHtml', () => {
  it('converts headings, flattening past h3', () => {
    expect(markdownToHtml('# One')).toBe('<h1>One</h1>');
    expect(markdownToHtml('## Two')).toBe('<h2>Two</h2>');
    expect(markdownToHtml('###### Six')).toBe('<h3>Six</h3>');
  });

  it('converts setext headings', () => {
    expect(markdownToHtml('Title\n=====')).toBe('<h1>Title</h1>');
    expect(markdownToHtml('Title\n-----')).toBe('<h2>Title</h2>');
  });

  it('converts both kinds of list', () => {
    expect(markdownToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(markdownToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('nests lists by indent', () => {
    expect(markdownToHtml('- a\n  - b\n- c'))
      .toBe('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  });

  // A to-do is a block in this editor, not a list item, so a run of them has to
  // come out of the list - otherwise they paste as bullets with no checkbox.
  it('converts to-dos to blocks, carrying the checked state', () => {
    expect(markdownToHtml('- [ ] open\n- [x] done'))
      .toBe('<div class="note-todo" data-checked="false">open</div>'
          + '<div class="note-todo" data-checked="true">done</div>');
  });

  it('carries to-do depth on data-indent', () => {
    expect(markdownToHtml('- [ ] top\n  - [ ] under'))
      .toBe('<div class="note-todo" data-checked="false">top</div>'
          + '<div class="note-todo" data-checked="false" data-indent="1">under</div>');
  });

  it('splits a run that mixes bullets and to-dos', () => {
    expect(markdownToHtml('- plain\n- [ ] task\n- plain again'))
      .toBe('<ul><li>plain</li></ul>'
          + '<div class="note-todo" data-checked="false">task</div>'
          + '<ul><li>plain again</li></ul>');
  });

  it('converts quotes, joining consecutive lines', () => {
    expect(markdownToHtml('> one\n> two')).toBe('<blockquote>one two</blockquote>');
  });

  it('converts fenced code without interpreting it', () => {
    expect(markdownToHtml('```\nconst a = **b**;\n```'))
      .toBe('<pre><code>const a = **b**;</code></pre>');
  });

  it('closes an unterminated fence at the end of the document', () => {
    expect(markdownToHtml('```\nabc')).toBe('<pre><code>abc</code></pre>');
  });

  it('converts rules', () => {
    expect(markdownToHtml('---')).toBe('<hr>');
    expect(markdownToHtml('***')).toBe('<hr>');
  });

  it('converts tables', () => {
    expect(markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |'))
      .toBe('<table class="note-table"><thead><tr><th>a</th><th>b</th></tr></thead>'
          + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  });

  it('joins a paragraph run and splits on blank lines', () => {
    expect(markdownToHtml('one\ntwo\n\nthree')).toBe('<p>one two</p><p>three</p>');
  });

  it('ends a paragraph when a block construct starts', () => {
    expect(markdownToHtml('text\n- a')).toBe('<p>text</p><ul><li>a</li></ul>');
    expect(markdownToHtml('text\n## H')).toBe('<p>text</p><h2>H</h2>');
  });

  // The property that matters most: a paste never eats words.
  it('keeps unrecognised text as a paragraph', () => {
    expect(markdownToHtml('just words')).toBe('<p>just words</p>');
    expect(markdownToHtml('!!! ??? ***x')).toContain('!!! ??? ***x');
  });

  it('never returns empty', () => {
    expect(markdownToHtml('')).toBe('<p><br></p>');
    expect(markdownToHtml('\n\n\n')).toBe('<p><br></p>');
  });

  it('handles a mixed document', () => {
    const html = markdownToHtml([
      '# Title',
      '',
      'Some **bold** prose.',
      '',
      '- one',
      '- two',
      '',
      '> a quote',
    ].join('\n'));
    expect(html).toBe(
      '<h1>Title</h1><p>Some <b>bold</b> prose.</p>'
      + '<ul><li>one</li><li>two</li></ul><blockquote>a quote</blockquote>'
    );
  });
});
