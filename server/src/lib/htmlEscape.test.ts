import { describe, it, expect } from 'vitest';
import {
  escapeHtml, escapeXml, jsonLdScript, safeInNoscript, collapseWhitespace,
} from './htmlEscape';

// The characters these tests are about cannot be written as literals here for
// the same reason they are not literals in the module — see the header comment.
const U2028 = String.fromCharCode(0x2028);
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

describe('escapeHtml', () => {
  it('closes the attribute-breakout route', () => {
    // The classic: a title ending an attribute and opening an event handler.
    const title = '" onload="steal()';
    expect(escapeHtml(title)).toBe('&quot; onload=&quot;steal()');
    expect(`<meta content="${escapeHtml(title)}">`).not.toMatch(/onload="/);
  });

  it('closes the element-breakout route', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes the ampersand first, so an escape cannot be double-decoded', () => {
    // Getting the order wrong yields '&amp;lt;' from a literal '<'.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary prose alone', () => {
    expect(escapeHtml('On rewriting my editor')).toBe('On rewriting my editor');
  });
});

describe('jsonLdScript', () => {
  it('survives a title that tries to close the script element', () => {
    const html = jsonLdScript({ name: '</script><script>alert(1)</script>' });
    // Exactly one closing tag: the one this function wrote.
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(html).not.toMatch(/<script>alert/);
  });

  it('still round-trips to the original string once parsed', () => {
    const name = '</script> & <b>bold</b>';
    const html = jsonLdScript({ name });
    const json = html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    expect(JSON.parse(json).name).toBe(name);
  });

  it('escapes the JavaScript line separators JSON allows raw', () => {
    const html = jsonLdScript({ name: `a${U2028}b` });
    expect(html).toContain('\\u2028');
    expect(html).not.toContain(U2028);
  });
});

describe('escapeXml', () => {
  it('uses the numeric apostrophe XML understands', () => {
    expect(escapeXml(`Dan's post`)).toBe('Dan&apos;s post');
  });

  it('drops control characters XML cannot represent at all', () => {
    expect(escapeXml(`a${NUL}b${BEL}c`)).toBe('abc');
  });

  it('keeps the whitespace XML does allow', () => {
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('safeInNoscript', () => {
  it('breaks a closing noscript tag hidden in a post body', () => {
    expect(safeInNoscript('<p>hi</noscript><img src=x onerror=1>'))
      .toBe('<p>hi&lt;/noscript><img src=x onerror=1>');
  });

  it('is case-insensitive, since HTML tag names are', () => {
    expect(safeInNoscript('</NoScript>')).toBe('&lt;/NoScript>');
  });

  it('leaves an ordinary body untouched', () => {
    expect(safeInNoscript('<p>A paragraph.</p>')).toBe('<p>A paragraph.</p>');
  });
});

describe('collapseWhitespace', () => {
  it('flattens a multi-line excerpt onto one line', () => {
    expect(collapseWhitespace('  one\n\ttwo   three \n')).toBe('one two three');
  });
});
