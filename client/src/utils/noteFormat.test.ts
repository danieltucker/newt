// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  COLOR_CLASSES, PALETTE, applyBlockTag, applyColor, clearFormatting, colorCaret, colorClass, colorsAt, normalizeBlocks,
} from './noteFormat';

const editor = (html: string): HTMLElement => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
};

/** A range over the first occurrence of `needle`, within one text node. */
function over(root: HTMLElement, needle: string): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = (n.nodeValue ?? '').indexOf(needle);
    if (at < 0) continue;
    const r = document.createRange();
    r.setStart(n, at);
    r.setEnd(n, at + needle.length);
    return r;
  }
  throw new Error(`no text node holds "${needle}"`);
}

/** A collapsed range just after the first occurrence of `needle`. */
function caretAfter(root: HTMLElement, needle: string): Range {
  const r = over(root, needle);
  r.collapse(false);
  return r;
}

/** A range from the start of one string to the end of another. */
function across(root: HTMLElement, from: string, to: string): Range {
  const a = over(root, from);
  const b = over(root, to);
  const r = document.createRange();
  r.setStart(a.startContainer, a.startOffset);
  r.setEnd(b.endContainer, b.endOffset);
  return r;
}

describe('the palette', () => {
  it('names two classes per hue, and nothing else', () => {
    expect(COLOR_CLASSES).toHaveLength(PALETTE.length * 2);
    expect(COLOR_CLASSES).toContain('note-fg-red');
    expect(COLOR_CLASSES).toContain('note-bg-yellow');
  });

  it('builds the class a stylesheet has to match', () => {
    expect(colorClass('fg', 'blue')).toBe('note-fg-blue');
    expect(colorClass('bg', 'blue')).toBe('note-bg-blue');
  });
});

describe('applyColor', () => {
  it('wraps the selected words and nothing either side', () => {
    const el = editor('<p>one two three</p>');
    applyColor(over(el, 'two'), el, 'fg', 'red');
    expect(el.innerHTML).toBe('<p>one <span class="note-fg-red">two</span> three</p>');
  });

  it('cuts a run open when only part of it is selected', () => {
    const el = editor('<p>hello</p>');
    applyColor(over(el, 'ell'), el, 'fg', 'blue');
    expect(el.innerHTML).toBe('<p>h<span class="note-fg-blue">ell</span>o</p>');
  });

  it('replaces a colour rather than nesting a second one', () => {
    const el = editor('<p>one <span class="note-fg-red">two</span> three</p>');
    applyColor(over(el, 'two'), el, 'fg', 'green');
    expect(el.innerHTML).toBe('<p>one <span class="note-fg-green">two</span> three</p>');
  });

  it('takes a colour off again, leaving no span behind', () => {
    const el = editor('<p>one <span class="note-fg-red">two</span> three</p>');
    applyColor(over(el, 'two'), el, 'fg', null);
    expect(el.innerHTML).toBe('<p>one two three</p>');
  });

  it('takes a colour off the middle of a coloured run', () => {
    const el = editor('<p><span class="note-fg-red">hello</span></p>');
    applyColor(over(el, 'ell'), el, 'fg', null);
    expect(el.innerHTML).toBe(
      '<p><span class="note-fg-red">h</span>ell<span class="note-fg-red">o</span></p>');
  });

  it('keeps a highlight when the text colour changes', () => {
    const el = editor('<p><span class="note-bg-yellow">lit</span></p>');
    applyColor(over(el, 'lit'), el, 'fg', 'purple');
    expect(el.innerHTML).toBe(
      '<p><span class="note-bg-yellow"><span class="note-fg-purple">lit</span></span></p>');
  });

  it('keeps the marks it crosses', () => {
    const el = editor('<p>a <b>bold</b> word</p>');
    applyColor(across(el, 'a ', 'word'), el, 'fg', 'red');
    expect(el.querySelector('b')).not.toBeNull();
    expect(el.textContent).toBe('a bold word');
    expect(el.querySelectorAll('.note-fg-red').length).toBeGreaterThan(0);
  });

  it('joins the spans a crossed mark would otherwise leave behind', () => {
    const el = editor('<p>a <b>b</b> c</p>');
    applyColor(across(el, 'a ', ' c'), el, 'fg', 'red');
    // One span per run either side of the <b>, plus the one inside it - but no
    // two adjacent spans saying the same thing.
    expect(el.innerHTML).toBe(
      '<p><span class="note-fg-red">a </span><b><span class="note-fg-red">b</span></b>'
      + '<span class="note-fg-red"> c</span></p>');
  });

  it('leaves a reference embed alone', () => {
    const el = editor(
      '<p>see <span class="note-embed" contenteditable="false" data-embed="1">'
      + '<span class="note-embed-title">A post</span></span> now</p>');
    applyColor(across(el, 'see', 'now'), el, 'fg', 'red');
    const embed = el.querySelector('.note-embed')!;
    expect(embed.innerHTML).toBe('<span class="note-embed-title">A post</span>');
  });

  it('does nothing to a collapsed range', () => {
    const el = editor('<p>hello</p>');
    expect(applyColor(caretAfter(el, 'hel'), el, 'fg', 'red')).toBeNull();
    expect(el.innerHTML).toBe('<p>hello</p>');
  });

  it('reports the words it coloured, so they stay selected', () => {
    const el = editor('<p>one two three</p>');
    const out = applyColor(over(el, 'two'), el, 'fg', 'red');
    const painted = el.querySelector('.note-fg-red')!.firstChild;
    expect(out?.startContainer).toBe(painted);
    expect(out?.endContainer).toBe(painted);
    expect(out?.endOffset).toBe(3);
  });
});

describe('colorCaret', () => {
  it('opens an empty span to type inside', () => {
    const el = editor('<p>red: </p>');
    const out = colorCaret(caretAfter(el, 'red: '), el, 'fg', 'red');
    expect(el.querySelector('span')?.className).toBe('note-fg-red');
    expect(out?.collapsed).toBe(true);
  });

  it('steps out of a colour when one is turned off', () => {
    const el = editor('<p><span class="note-fg-red">red</span></p>');
    colorCaret(caretAfter(el, 'red'), el, 'fg', null);
    const p = el.firstElementChild!;
    expect(p.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(p.querySelector('.note-fg-red')?.textContent).toBe('red');
  });

  it('has nothing to step out of when no colour is on', () => {
    const el = editor('<p>plain</p>');
    expect(colorCaret(caretAfter(el, 'plain'), el, 'fg', null)).toBeNull();
    expect(el.innerHTML).toBe('<p>plain</p>');
  });
});

describe('colorsAt', () => {
  it('reads both kinds off the ancestors', () => {
    const el = editor('<p><span class="note-bg-yellow"><span class="note-fg-red">x</span></span></p>');
    const node = el.querySelector('.note-fg-red')!.firstChild;
    expect(colorsAt(node, el)).toEqual({ fg: 'red', bg: 'yellow' });
  });

  it('reports nothing for plain text', () => {
    const el = editor('<p>plain</p>');
    expect(colorsAt(el.firstChild!.firstChild, el)).toEqual({ fg: null, bg: null });
  });

  it('ignores a class that isn\'t in the palette', () => {
    const el = editor('<p><span class="note-fg-chartreuse">x</span></p>');
    expect(colorsAt(el.querySelector('span')!.firstChild, el)).toEqual({ fg: null, bg: null });
  });
});

describe('clearFormatting', () => {
  it('unwraps every inline mark, colours included', () => {
    const el = editor(
      '<p><b>bold</b> <i>it</i> <code>c</code> <span class="note-fg-red">red</span>'
      + ' <span class="note-bg-blue">lit</span> <u>u</u> <s>s</s></p>');
    clearFormatting(across(el, 'bold', 's'), el);
    expect(el.innerHTML).toBe('<p>bold it c red lit u s</p>');
  });

  it('unlinks, keeping the words', () => {
    const el = editor('<p>go <a href="https://example.com">there</a> now</p>');
    clearFormatting(across(el, 'go ', ' now'), el);
    expect(el.innerHTML).toBe('<p>go there now</p>');
  });

  it('turns a heading into body text', () => {
    const el = editor('<h2>A <b>title</b></h2>');
    clearFormatting(across(el, 'A ', 'title'), el);
    expect(el.innerHTML).toBe('<p>A title</p>');
  });

  it('resets the block even when only one word is selected', () => {
    const el = editor('<h2>one <b>two</b> three</h2>');
    clearFormatting(over(el, 'two'), el);
    // The block is a property of the whole line, so it goes; the words either
    // side of the selection keep whatever they had.
    expect(el.innerHTML).toBe('<p>one two three</p>');
  });

  it('leaves marks outside the selection alone', () => {
    const el = editor('<p>one <b>two</b> <i>three</i></p>');
    clearFormatting(over(el, 'three'), el);
    expect(el.innerHTML).toBe('<p>one <b>two</b> three</p>');
  });

  it('flattens a list, nested items and all', () => {
    const el = editor('<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>');
    const r = document.createRange();
    r.selectNodeContents(el);
    clearFormatting(r, el);
    expect(el.innerHTML).toBe('<p>one</p><p>deep</p><p>two</p>');
  });

  it('keeps a code block\'s lines as line breaks', () => {
    const el = editor('<pre>one\ntwo</pre>');
    const r = document.createRange();
    r.selectNodeContents(el);
    clearFormatting(r, el);
    expect(el.innerHTML).toBe('<p>one<br>two</p>');
  });

  it('turns a to-do back into a paragraph and forgets it was ticked', () => {
    const el = editor('<div class="note-todo" data-checked="true">done</div>');
    const r = document.createRange();
    r.selectNodeContents(el);
    clearFormatting(r, el);
    expect(el.innerHTML).toBe('<p>done</p>');
  });

  it('drops indentation', () => {
    const el = editor('<p data-indent="2">over there</p>');
    const r = document.createRange();
    r.selectNodeContents(el);
    clearFormatting(r, el);
    expect(el.innerHTML).toBe('<p>over there</p>');
  });

  it('clears a table\'s cells without unmaking the table', () => {
    const el = editor(
      '<table class="note-table"><tbody><tr><td><b>cell</b></td></tr></tbody></table>');
    const r = document.createRange();
    r.selectNodeContents(el);
    clearFormatting(r, el);
    expect(el.innerHTML).toBe(
      '<table class="note-table"><tbody><tr><td>cell</td></tr></tbody></table>');
  });

  it('leaves a reference embed standing', () => {
    const el = editor(
      '<p><b>see</b> <span class="note-embed" contenteditable="false" data-embed="1">'
      + '<span class="note-embed-title">A post</span></span></p>');
    const r = document.createRange();
    r.selectNodeContents(el);
    clearFormatting(r, el);
    expect(el.querySelector('.note-embed .note-embed-title')?.textContent).toBe('A post');
    expect(el.querySelector('b')).toBeNull();
  });

  it('leaves a gallery standing on its own alone', () => {
    const el = editor(
      '<span class="note-gallery" contenteditable="false" data-gallery="2">'
      + '<span class="note-gallery-stack"></span></span>');
    const r = document.createRange();
    r.selectNodeContents(el);
    clearFormatting(r, el);
    expect(el.querySelector('.note-gallery')).not.toBeNull();
    expect(el.querySelector('.note-gallery-stack')).not.toBeNull();
  });

  it('clears the whole line when nothing is selected', () => {
    const el = editor('<h3>a <b>whole</b> line</h3>');
    clearFormatting(caretAfter(el, 'a '), el);
    expect(el.innerHTML).toBe('<p>a whole line</p>');
  });

  it('spans every block a selection crosses', () => {
    const el = editor('<h1>first</h1><p><b>second</b></p><h3>third</h3>');
    clearFormatting(across(el, 'first', 'third'), el);
    expect(el.innerHTML).toBe('<p>first</p><p>second</p><p>third</p>');
  });
});

describe('normalizeBlocks', () => {
  it('gathers a loose run into a paragraph', () => {
    const el = editor('Bare words<p>A block</p>');
    expect(normalizeBlocks(el)).toBe(true);
    expect(el.innerHTML).toBe('<p>Bare words</p><p>A block</p>');
  });

  it('keeps one paragraph per run rather than one per node', () => {
    const el = editor('one <b>two</b> three<p>block</p>four <i>five</i>');
    normalizeBlocks(el);
    expect(el.innerHTML).toBe('<p>one <b>two</b> three</p><p>block</p><p>four <i>five</i></p>');
  });

  it('leaves a document that is already blocks alone', () => {
    const el = editor('<h2>Title</h2><p>Words</p><ul><li>item</li></ul>');
    expect(normalizeBlocks(el)).toBe(false);
    expect(el.innerHTML).toBe('<h2>Title</h2><p>Words</p><ul><li>item</li></ul>');
  });

  // Wrapping one would rewrite the stored markup of every post that has one.
  it('leaves an embed standing on its own where it is', () => {
    const el = editor(
      '<span class="note-embed" contenteditable="false" data-embed="1">x</span><p>after</p>');
    expect(normalizeBlocks(el)).toBe(false);
    expect(el.firstElementChild?.className).toBe('note-embed');
  });

  it('drops the pretty-printing between blocks', () => {
    const el = editor('<p>one</p>\n  \n<p>two</p>');
    normalizeBlocks(el);
    expect(el.innerHTML).toBe('<p>one</p><p>two</p>');
  });

  it('keeps the whitespace that is part of a run', () => {
    const el = editor('one <b>two</b>');
    normalizeBlocks(el);
    expect(el.innerHTML).toBe('<p>one <b>two</b></p>');
  });
});

// The report this was written for: "the clear styling button is not working,
// and it struggles when I paste content in". Both are one shape - a selection
// sitting in a node that is not a child block of the root, which blocksIn
// cannot name, so the whole command returned having done nothing.
describe('clearFormatting on a document that was pasted into', () => {
  it('clears a bare run at the top level', () => {
    const el = editor('loose <b>bold</b> words');
    clearFormatting(across(el, 'loose ', ' words'), el);
    expect(el.innerHTML).toBe('<p>loose bold words</p>');
  });

  it('clears a selection that starts loose and ends in a block', () => {
    const el = editor('loose <b>bold</b><h2>and a <i>heading</i></h2>');
    clearFormatting(across(el, 'loose ', 'heading'), el);
    expect(el.innerHTML).toBe('<p>loose bold</p><p>and a heading</p>');
  });

  it('clears with the caret in a loose run and nothing selected', () => {
    const el = editor('just <b>words</b>');
    clearFormatting(caretAfter(el, 'just '), el);
    expect(el.innerHTML).toBe('<p>just words</p>');
  });
});

// The report this was written for, in the reporter's words: "where it says 'The
// project faded as...' it's supposed to be regular text, but I can't get rid of
// the H2 with the editor buttons." Every case here is a block that
// execCommand('formatBlock') declined to touch while reporting success.
describe('applyBlockTag', () => {
  it('turns a heading into a paragraph', () => {
    const el = editor('<h2>The project faded as I ran into hurdles</h2>');
    applyBlockTag(over(el, 'faded'), el, 'P');
    expect(el.innerHTML).toBe('<p>The project faded as I ran into hurdles</p>');
  });

  it('turns a paragraph into a heading and back', () => {
    const el = editor('<p>Words</p>');
    applyBlockTag(over(el, 'Words'), el, 'H2');
    expect(el.innerHTML).toBe('<h2>Words</h2>');
    applyBlockTag(over(el, 'Words'), el, 'P');
    expect(el.innerHTML).toBe('<p>Words</p>');
  });

  // A picture that got swallowed into a heading by an earlier paste - the shape
  // that made formatBlock give up without saying so.
  it('frees a heading that is wrapped around a picture', () => {
    const el = editor('<h1><img src="/api/v1/images/a" alt=""><b>and words</b></h1>');
    applyBlockTag(over(el, 'and words'), el, 'P');
    expect(el.innerHTML).toBe('<p><img src="/api/v1/images/a" alt=""><b>and words</b></p>');
  });

  it('frees a heading wrapped around a gallery, leaving the gallery whole', () => {
    const el = editor(
      '<h1><span class="note-gallery" contenteditable="false" data-gallery="2">'
      + '<img src="/api/v1/images/a" alt=""></span></h1>');
    // No text to point at - a gallery is pictures. The caret is simply in the
    // heading, which is what clicking beside one gives you.
    const r = document.createRange();
    r.selectNodeContents(el.firstElementChild!);
    applyBlockTag(r, el, 'P');
    expect(el.firstElementChild?.nodeName).toBe('P');
    expect(el.querySelector('.note-gallery')?.getAttribute('data-gallery')).toBe('2');
  });

  it('retags every block a selection crosses', () => {
    const el = editor('<h2>one</h2><h2>two</h2><h2>three</h2>');
    applyBlockTag(across(el, 'one', 'two'), el, 'P');
    expect(el.innerHTML).toBe('<p>one</p><p>two</p><h2>three</h2>');
  });

  it('works with the caret in a loose run, which is where a paste leaves it', () => {
    const el = editor('loose words');
    applyBlockTag(caretAfter(el, 'loose '), el, 'H2');
    expect(el.innerHTML).toBe('<h2>loose words</h2>');
  });

  it('turns a to-do into a paragraph and forgets it was ticked', () => {
    const el = editor('<div class="note-todo" data-checked="true">done</div>');
    applyBlockTag(over(el, 'done'), el, 'P');
    expect(el.innerHTML).toBe('<p>done</p>');
  });

  it('keeps how far a block was indented', () => {
    const el = editor('<p data-indent="2">over there</p>');
    applyBlockTag(over(el, 'over'), el, 'BLOCKQUOTE');
    expect(el.innerHTML).toBe('<blockquote data-indent="2">over there</blockquote>');
  });

  // Shapes, not levels of text. The list buttons own the list transform.
  it.each([
    ['a list', '<ul><li>one</li></ul>'],
    ['a table', '<table class="note-table"><tbody><tr><td>a</td></tr></tbody></table>'],
  ])('leaves %s alone', (_name, html) => {
    const el = editor(html);
    const r = document.createRange();
    r.selectNodeContents(el);
    applyBlockTag(r, el, 'P');
    expect(el.innerHTML).toBe(html);
  });

  it('leaves an embed standing on its own alone', () => {
    const html = '<span class="note-embed" contenteditable="false" data-embed="1">x</span>';
    const el = editor(html);
    const r = document.createRange();
    r.selectNodeContents(el);
    applyBlockTag(r, el, 'P');
    expect(el.innerHTML).toBe(html);
  });

  it('gives a block that ends up empty something to hold the caret', () => {
    const el = editor('<h2></h2>');
    const r = document.createRange();
    r.selectNodeContents(el);
    applyBlockTag(r, el, 'P');
    expect(el.innerHTML).toBe('<p><br></p>');
  });

  // The reported symptom: "when I press enter the text area is deselected".
  // Asking for a heading on a blank line - /h2 and Enter, or "## " - leaves the
  // caret on the block itself rather than in a text node inside it, because
  // there is no text yet. Replacing the block used to strand the selection on
  // the node that had just been taken out of the document, so the line stopped
  // looking focused and the next keystroke went nowhere.
  it('keeps the caret in the document when a blank line becomes a heading', () => {
    const el = editor('<p><br></p>');
    document.body.appendChild(el);
    try {
      const r = document.createRange();
      r.setStart(el.firstElementChild!, 0);
      r.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);

      applyBlockTag(r, el, 'H2');

      expect(el.innerHTML).toBe('<h2><br></h2>');
      const anchor = window.getSelection()?.anchorNode ?? null;
      expect(anchor && el.contains(anchor)).toBe(true);
    } finally {
      el.remove();
    }
  });
});
