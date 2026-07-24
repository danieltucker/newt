import { describe, it, expect } from 'vitest';
import {
  sanitizeCommentHtml,
  isBlankHtml,
  canonicalArticleKey,
  isHttpUrl,
  commentTextLength,
  MAX_COMMENT_BODY,
} from './comments';

describe('commentTextLength', () => {
  it('counts only the visible text, ignoring tags', () => {
    expect(commentTextLength('<p>hello</p>')).toBe(5);
    expect(commentTextLength('<p><strong>hi</strong> there</p>')).toBe(8); // "hi there"
  });
  it('collapses whitespace and decodes &nbsp;', () => {
    expect(commentTextLength('<p>a\n\n  b</p>')).toBe(3);      // "a b"
    expect(commentTextLength('<p>a&nbsp;&nbsp;b</p>')).toBe(3); // "a b"
  });
  it('does not count markup toward the length', () => {
    const heavyMarkup = '<p>' + '<em></em>'.repeat(1000) + 'hi</p>';
    expect(commentTextLength(heavyMarkup)).toBe(2);
  });
  it('is zero for a textless body', () => {
    expect(commentTextLength('<p><br></p>')).toBe(0);
    expect(commentTextLength('<hr>')).toBe(0);
  });
});

describe('sanitizeCommentHtml', () => {
  it('keeps allowed formatting', () => {
    expect(sanitizeCommentHtml('<p>hi <em>there</em></p>')).toContain('<em>there</em>');
  });

  it('removes <script> and its contents', () => {
    const out = sanitizeCommentHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toContain('alert');
  });

  it('blocks javascript: URLs and hardens external links', () => {
    expect(sanitizeCommentHtml('<a href="javascript:evil()">x</a>')).not.toContain('javascript:');
    const link = sanitizeCommentHtml('<a href="https://x.com">y</a>');
    expect(link).toContain('noopener');
    expect(link).toContain('nofollow');
  });

  it('keeps only the editor structural classes', () => {
    expect(sanitizeCommentHtml('<div class="note-todo">todo</div>')).toContain('note-todo');
    expect(sanitizeCommentHtml('<div class="evil">x</div>')).not.toContain('evil');
  });

  it('caps the body length', () => {
    const out = sanitizeCommentHtml('a'.repeat(MAX_COMMENT_BODY + 5000));
    expect(out.length).toBeLessThanOrEqual(MAX_COMMENT_BODY);
  });
});

describe('isBlankHtml', () => {
  it('treats an empty editor as blank', () => {
    expect(isBlankHtml('')).toBe(true);
    expect(isBlankHtml('<p><br></p>')).toBe(true);
    expect(isBlankHtml('<p>&nbsp;</p>')).toBe(true);
  });

  it('treats real text as not blank', () => {
    expect(isBlankHtml('<p>hello</p>')).toBe(false);
  });

  it('treats structural-but-textless blocks as not blank', () => {
    expect(isBlankHtml('<hr>')).toBe(false);
    expect(isBlankHtml('<p></p><table><tr><td></td></tr></table>')).toBe(false);
  });
});

describe('canonicalArticleKey', () => {
  it('lowercases host, strips www and trailing slash', () => {
    expect(canonicalArticleKey('https://www.Example.com/article/')).toBe('example.com/article');
  });

  it('drops tracking params but keeps real ones', () => {
    expect(canonicalArticleKey('https://example.com/a?utm_source=x&id=5')).toBe('example.com/a?id=5');
    expect(canonicalArticleKey('https://example.com/a?fbclid=xyz')).toBe('example.com/a');
    expect(canonicalArticleKey('https://example.com/a?ref=twitter')).toBe('example.com/a');
  });

  it('sorts params so order does not fork the thread', () => {
    expect(canonicalArticleKey('https://example.com/a?b=2&a=1')).toBe('example.com/a?a=1&b=2');
  });

  it('maps feed / reading-list / shared variants of a URL to one key', () => {
    const a = canonicalArticleKey('https://www.example.com/post?utm_medium=rss');
    const b = canonicalArticleKey('http://example.com/post/');
    expect(a).toBe(b);
  });

  it('falls back to trimmed lowercase for invalid input', () => {
    expect(canonicalArticleKey('  Nonsense  ')).toBe('nonsense');
  });
});

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://x.com')).toBe(true);
    expect(isHttpUrl('http://x.com/path')).toBe(true);
  });

  it('rejects other schemes and non-URLs', () => {
    expect(isHttpUrl('ftp://x.com')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });

  it('rejects non-string and oversized input', () => {
    expect(isHttpUrl(123)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl('https://x.com/' + 'a'.repeat(2048))).toBe(false);
  });
});
