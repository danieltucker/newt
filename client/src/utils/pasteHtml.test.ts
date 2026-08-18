// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { sanitizePastedHtml } from './pasteHtml';

// The cases here are the shapes real sources actually put on a clipboard, named
// after where they come from — a regression in this file shows up as "my paste
// came out wrong", which is not something a stack trace ever explains.

describe('sanitizePastedHtml', () => {
  it('keeps the blocks the editor can write', () => {
    const out = sanitizePastedHtml(
      '<h2>A heading</h2><p>Some <b>bold</b> and <i>italic</i>.</p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(out).toContain('<h2>A heading</h2>');
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('<li>One</li>');
  });

  // Google Docs wraps a whole copied selection in a <b> that cancels itself in
  // the style attribute. Drop the attribute and keep the tag, and the entire
  // paste comes out bold - the single most common "wrong paste" there is.
  it('does not bold a whole Google Docs paste', () => {
    const out = sanitizePastedHtml(
      '<b style="font-weight:normal" id="docs-internal-guid-1"><p>Ordinary words.</p></b>',
    );
    expect(out).not.toContain('<b>');
    expect(out).toContain('Ordinary words.');
  });

  // The other half of the same problem: those editors write bold as a style on a
  // span, so dropping style without reading it loses the formatting entirely.
  it('reads the marks out of an inline style before dropping it', () => {
    const out = sanitizePastedHtml(
      '<p><span style="font-weight:700">heavy</span> and '
      + '<span style="font-style:italic">slanted</span> and '
      + '<span style="text-decoration:line-through">gone</span></p>',
    );
    expect(out).toContain('<b>heavy</b>');
    expect(out).toContain('<i>slanted</i>');
    expect(out).toContain('<s>gone</s>');
    expect(out).not.toContain('style=');
  });

  it('drops every style attribute, marks or no marks', () => {
    const out = sanitizePastedHtml('<p style="color:red;margin:40px">Words</p>');
    expect(out).toBe('<p>Words</p>');
  });

  // A page's structure is not the document's structure. Left standing, these are
  // blocks no block command can transform, because the editor has no name
  // for them.
  it('unwraps the containers a web page is built out of', () => {
    const out = sanitizePastedHtml(
      '<div class="post-body"><section><article><p>The actual words.</p></article></section></div>',
    );
    expect(out).toBe('<p>The actual words.</p>');
  });

  it('flattens headings deeper than the editor has', () => {
    const out = sanitizePastedHtml('<h4>Deep</h4><h6>Deeper</h6>');
    expect(out).toBe('<h3>Deep</h3><h3>Deeper</h3>');
  });

  // Unwrapping a <style> leaves its CSS behind as visible text, which is the
  // wall of selectors people get pasting from a page that inlines its sheet.
  it('drops non-prose elements with their contents', () => {
    const out = sanitizePastedHtml(
      '<style>.x{color:red}</style><p>Kept</p><script>alert(1)</script><iframe></iframe>',
    );
    expect(out).toBe('<p>Kept</p>');
  });

  it('keeps a class only when it is one of ours', () => {
    const out = sanitizePastedHtml('<p class="prose lead">Words</p><p class="note-fg-red">Red</p>');
    expect(out).toContain('<p>Words</p>');
    expect(out).toContain('class="note-fg-red"');
  });

  // Copying an embed out of one post and into another has to survive: it is a
  // span full of spans, which is otherwise exactly the shape this file dismantles.
  it('carries a Newt embed across whole', () => {
    const out = sanitizePastedHtml(
      '<p><span class="note-embed" data-embed="article" data-variant="large" '
      + 'data-url="https://example.com/x" data-title="A headline" data-image="https://cdn.example.com/i.jpg" '
      + 'contenteditable="false"><a class="note-embed-a" href="/a/abc">'
      + '<span class="note-embed-title">A headline</span></a></span></p>',
    );
    expect(out).toContain('class="note-embed"');
    expect(out).toContain('data-embed="article"');
    expect(out).toContain('data-title="A headline"');
    expect(out).toContain('class="note-embed-title"');
    // Stamped back on at hydration; a stored embed never carries it.
    expect(out).not.toContain('contenteditable');
  });

  it('refuses a link or an image that does not go anywhere real', () => {
    const out = sanitizePastedHtml(
      '<p><a href="javascript:alert(1)">click</a> <img src="data:image/png;base64,AAA" alt="x"></p>',
    );
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<img');
    // The words of a link that lost its href are still words.
    expect(out).toContain('click');
  });

  it('keeps a real link and a real image', () => {
    const out = sanitizePastedHtml(
      '<p><a href="https://example.com/x" target="_blank" onclick="x()">there</a>'
      + '<img src="/api/v1/images/abc" alt="a" width="800" height="600"></p>',
    );
    expect(out).toContain('href="https://example.com/x"');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('target=');
    expect(out).toContain('src="/api/v1/images/abc"');
    expect(out).toContain('width="800"');
  });

  // Loose text at the top level is the shape that makes clear-formatting and
  // every block command silently do nothing. See normalizeBlocks.
  it('leaves nothing loose at the top level', () => {
    const out = sanitizePastedHtml('Bare words<p>A block</p>and more <b>after</b>');
    expect(out).toBe('<p>Bare words</p><p>A block</p><p>and more <b>after</b></p>');
  });

  it('gives an orphaned list item a list to live in', () => {
    const out = sanitizePastedHtml('<li>Adrift</li>');
    expect(out).toBe('<ul><li>Adrift</li></ul>');
  });

  it('drops the pretty-printing between blocks', () => {
    const out = sanitizePastedHtml('<p>One</p>\n\n   \n<p>Two</p>');
    expect(out).toBe('<p>One</p><p>Two</p>');
  });

  it('drops empty inline wrappers left behind by a page\'s markup', () => {
    const out = sanitizePastedHtml('<p>Words<span class="icon"></span><em></em></p>');
    expect(out).toBe('<p>Words</p>');
  });

  // A clipboard holding only a stylesheet is a real thing to be handed. The
  // caller reads "" as "insert nothing", not as "fall back to the browser".
  it('answers empty for a clipboard with nothing in it worth pasting', () => {
    expect(sanitizePastedHtml('<style>.x{}</style>')).toBe('');
    expect(sanitizePastedHtml('   ')).toBe('');
  });

  it('parses a whole document, which is what a clipboard usually holds', () => {
    const out = sanitizePastedHtml(
      '<html><head><meta charset="utf-8"><title>A page</title></head><body><p>The body</p></body></html>',
    );
    expect(out).toBe('<p>The body</p>');
    expect(out).not.toContain('A page');
  });

  // Word writes its own metadata into conditional comments, and a stray
  // unclosed one can otherwise swallow the paste that follows it.
  it('drops comments, including Word\'s conditionals', () => {
    const out = sanitizePastedHtml('<!--[if gte mso 9]><xml><o:p/></xml><![endif]--><p>Words</p>');
    expect(out).toBe('<p>Words</p>');
  });

  it('keeps a table, which is a shape the editor has', () => {
    const out = sanitizePastedHtml(
      '<table class="note-table"><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    expect(out).toContain('<table class="note-table">');
    expect(out).toContain('<td>a</td>');
  });

  it('keeps the line breaks inside a code block', () => {
    const out = sanitizePastedHtml('<pre><code>one\ntwo</code></pre>');
    expect(out).toBe('<pre><code>one\ntwo</code></pre>');
  });
});
