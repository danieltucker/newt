import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './noteMigrate';

describe('markdownToHtml - block types', () => {
  it('empty input yields a single empty paragraph', () => {
    expect(markdownToHtml('')).toBe('<p><br></p>');
  });

  it('converts headings h1–h3 (but not deeper)', () => {
    expect(markdownToHtml('# One')).toBe('<h1>One</h1>');
    expect(markdownToHtml('## Two')).toBe('<h2>Two</h2>');
    expect(markdownToHtml('### Three')).toBe('<h3>Three</h3>');
    // 4+ hashes are not a heading - falls through to a paragraph
    expect(markdownToHtml('#### Four')).toBe('<p>#### Four</p>');
  });

  it('wraps plain lines as paragraphs', () => {
    expect(markdownToHtml('just text')).toBe('<p>just text</p>');
  });

  it('groups consecutive bullets into one list ( - and * )', () => {
    expect(markdownToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(markdownToHtml('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('groups ordered items into an ol', () => {
    expect(markdownToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('flushes the current list when the marker type changes', () => {
    expect(markdownToHtml('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('a blank line ends a list', () => {
    expect(markdownToHtml('- a\n\n- b')).toBe('<ul><li>a</li></ul><ul><li>b</li></ul>');
  });

  it('converts to-do items with checked state', () => {
    expect(markdownToHtml('- [ ] open')).toBe('<div class="note-todo" data-checked="false">open</div>');
    expect(markdownToHtml('- [x] done')).toBe('<div class="note-todo" data-checked="true">done</div>');
    expect(markdownToHtml('- [X] done')).toBe('<div class="note-todo" data-checked="true">done</div>');
  });

  it('gives an empty to-do a <br> placeholder', () => {
    expect(markdownToHtml('- [ ] ')).toBe('<div class="note-todo" data-checked="false"><br></div>');
  });

  it('converts blockquotes and horizontal rules', () => {
    expect(markdownToHtml('> quoted')).toBe('<blockquote>quoted</blockquote>');
    expect(markdownToHtml('---')).toBe('<hr>');
  });

  it('converts a fenced code block, escaping its contents', () => {
    expect(markdownToHtml('```\nlet x = a < b;\n```')).toBe('<pre>let x = a &lt; b;</pre>');
  });

  it('keeps multiple code lines with newlines and gives an empty block a <br>', () => {
    expect(markdownToHtml('```\none\ntwo\n```')).toBe('<pre>one\ntwo</pre>');
    expect(markdownToHtml('```\n```')).toBe('<pre><br></pre>');
  });
});

describe('markdownToHtml - escaping', () => {
  it('escapes &, < and > in paragraph text', () => {
    expect(markdownToHtml('a < b & c > d')).toBe('<p>a &lt; b &amp; c &gt; d</p>');
  });

  it('escapes inside headings and list items too', () => {
    expect(markdownToHtml('# <b>hi</b>')).toBe('<h1>&lt;b&gt;hi&lt;/b&gt;</h1>');
    expect(markdownToHtml('- a & b')).toBe('<ul><li>a &amp; b</li></ul>');
  });
});

describe('markdownToHtml - mixed document', () => {
  it('preserves block order across a mixed note', () => {
    const md = '# Title\n\nintro line\n\n- one\n- two\n\n> note';
    expect(markdownToHtml(md)).toBe(
      '<h1>Title</h1><p>intro line</p><ul><li>one</li><li>two</li></ul><blockquote>note</blockquote>',
    );
  });
});
