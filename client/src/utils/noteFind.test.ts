// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  findMatches, findRanges, flattenText, rangeOf, replaceAll,
} from './noteFind';

function editor(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('flattenText', () => {
  it('joins runs split by inline formatting', () => {
    const el = editor('<p>the <b>quick</b> fox</p>');
    expect(flattenText(el).text).toBe('the quick fox');
  });

  it('records where each text node landed', () => {
    const el = editor('<p>ab<b>cd</b></p>');
    const { spans } = flattenText(el);
    expect(spans.map(s => [s.node.data, s.start, s.end])).toEqual([
      ['ab', 0, 2],
      ['cd', 2, 4],
    ]);
  });

  it('separates blocks so text cannot run together across them', () => {
    const el = editor('<p>one</p><p>two</p>');
    expect(flattenText(el).text).toBe('one\ntwo');
  });

  it('separates lines broken by <br>', () => {
    const el = editor('<p>one<br>two</p>');
    expect(flattenText(el).text).toBe('one\ntwo');
  });

  it('separates list items and table cells', () => {
    expect(flattenText(editor('<ul><li>a</li><li>b</li></ul>')).text).toBe('a\nb');
    expect(flattenText(editor('<table><tr><td>a</td><td>b</td></tr></table>')).text).toBe('a\nb');
  });

  it('skips embeds entirely - their text is markup, not prose', () => {
    const el = editor('<p>before</p><span class="note-embed"><a>Some Article</a></span><p>after</p>');
    const flat = flattenText(el);
    expect(flat.text).toBe('before\nafter');
    expect(flat.text).not.toContain('Some Article');
  });

  it('leaves no leading separator when the first block is reached', () => {
    expect(flattenText(editor('<p>only</p>')).text).toBe('only');
  });
});

describe('findMatches', () => {
  it('finds every non-overlapping occurrence', () => {
    expect(findMatches('a cat and a cat', 'cat')).toEqual([
      { start: 2, end: 5 },
      { start: 12, end: 15 },
    ]);
  });

  it('does not overlap itself', () => {
    // "aaaa" holds two "aa", not three
    expect(findMatches('aaaa', 'aa')).toHaveLength(2);
  });

  it('ignores case by default', () => {
    expect(findMatches('Cat cat CAT', 'cat')).toHaveLength(3);
  });

  it('respects caseSensitive', () => {
    expect(findMatches('Cat cat CAT', 'cat', { caseSensitive: true })).toEqual([
      { start: 4, end: 7 },
    ]);
  });

  it('respects wholeWord', () => {
    const text = 'cat concat cats cat.';
    expect(findMatches(text, 'cat', { wholeWord: true })).toEqual([
      { start: 0, end: 3 },
      { start: 16, end: 19 },
    ]);
  });

  it('treats digits and underscores as word characters', () => {
    expect(findMatches('a1 a', 'a', { wholeWord: true })).toEqual([{ start: 3, end: 4 }]);
    expect(findMatches('a_b a', 'a', { wholeWord: true })).toEqual([{ start: 4, end: 5 }]);
  });

  it('matches nothing for an empty query', () => {
    expect(findMatches('anything', '')).toEqual([]);
  });

  it('never matches across a line separator', () => {
    // The flat text of "<p>one</p><p>two</p>" - "onetwo" is not really there
    expect(findMatches('one\ntwo', 'onetwo')).toEqual([]);
  });
});

describe('rangeOf', () => {
  it('maps a match spanning two text nodes back to a Range', () => {
    const el = editor('<p>the <b>quick</b> fox</p>');
    const flat = flattenText(el);
    const [m] = findMatches(flat.text, 'quick fox');
    const range = rangeOf(flat, m)!;
    expect(range.toString()).toBe('quick fox');
  });

  it('ends a match on the node that owns its last character', () => {
    const el = editor('<p>ab<b>cd</b></p>');
    const flat = flattenText(el);
    const range = rangeOf(flat, { start: 0, end: 2 })!;
    expect(range.endContainer.textContent).toBe('ab');
    expect(range.endOffset).toBe(2);
  });

  it('returns ranges in document order', () => {
    const el = editor('<p>x</p><p>hit</p><p>hit</p>');
    const ranges = findRanges(el, 'hit');
    expect(ranges).toHaveLength(2);
    expect(
      ranges[0].compareBoundaryPoints(Range.START_TO_START, ranges[1]),
    ).toBeLessThan(0);
  });
});

describe('findRanges', () => {
  it('finds a match hidden by inline markup', () => {
    const el = editor('<p>the <b>qu</b><i>ick</i> fox</p>');
    expect(findRanges(el, 'quick')).toHaveLength(1);
  });

  it('does not find text inside an embed', () => {
    const el = editor('<p>keep</p><span class="note-embed"><a>keep</a></span>');
    expect(findRanges(el, 'keep')).toHaveLength(1);
  });
});

describe('replaceAll', () => {
  it('replaces every occurrence and reports the count', () => {
    const el = editor('<p>a cat and a cat</p>');
    expect(replaceAll(el, 'cat', 'dog')).toBe(2);
    expect(el.textContent).toBe('a dog and a dog');
  });

  it('replaces a match that spans inline formatting', () => {
    const el = editor('<p>the <b>quick</b> fox</p>');
    expect(replaceAll(el, 'quick fox', 'slow dog')).toBe(1);
    expect(el.textContent).toBe('the slow dog');
  });

  it('works back to front, so every hit lands even when lengths differ', () => {
    const el = editor('<p>x x x x</p>');
    expect(replaceAll(el, 'x', 'yyyy')).toBe(4);
    expect(el.textContent).toBe('yyyy yyyy yyyy yyyy');
  });

  it('replaces across separate blocks', () => {
    const el = editor('<p>cat</p><p>cat</p>');
    expect(replaceAll(el, 'cat', 'dog')).toBe(2);
    expect(el.querySelectorAll('p')).toHaveLength(2);
    expect(el.textContent).toBe('dogdog');
  });

  it('leaves embeds untouched', () => {
    const el = editor('<p>cat</p><span class="note-embed"><a>cat</a></span>');
    expect(replaceAll(el, 'cat', 'dog')).toBe(1);
    expect(el.querySelector('.note-embed')!.textContent).toBe('cat');
  });

  it('honours caseSensitive', () => {
    const el = editor('<p>Cat cat</p>');
    expect(replaceAll(el, 'cat', 'dog', { caseSensitive: true })).toBe(1);
    expect(el.textContent).toBe('Cat dog');
  });

  it('honours wholeWord', () => {
    const el = editor('<p>cat concat</p>');
    expect(replaceAll(el, 'cat', 'dog', { wholeWord: true })).toBe(1);
    expect(el.textContent).toBe('dog concat');
  });

  it('changes nothing when there is no match', () => {
    const el = editor('<p>untouched</p>');
    const before = el.innerHTML;
    expect(replaceAll(el, 'zzz', 'yyy')).toBe(0);
    expect(el.innerHTML).toBe(before);
  });

  it('can delete matches by replacing with nothing', () => {
    const el = editor('<p>a-b-c</p>');
    expect(replaceAll(el, '-', '')).toBe(2);
    expect(el.textContent).toBe('abc');
  });
});
