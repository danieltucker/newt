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

// Images are loaded without any user action, so what an <img src> may point at is
// a tighter question than what an <a href> may. These lock the allowlist down.
describe('sanitizeCommentHtml — images', () => {
  it('keeps our own uploads, which are site-relative and have no scheme', () => {
    const out = sanitizeCommentHtml('<p><img src="/api/v1/images/abc123" alt="a cat"></p>');
    expect(out).toContain('src="/api/v1/images/abc123"');
    expect(out).toContain('alt="a cat"');
  });

  it('keeps remote https images', () => {
    expect(sanitizeCommentHtml('<img src="https://example.com/cat.png">'))
      .toContain('https://example.com/cat.png');
  });

  it('adds no-referrer so the embedding page\'s URL is not leaked to the host', () => {
    const out = sanitizeCommentHtml('<img src="https://example.com/cat.png">');
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(out).toContain('loading="lazy"');
  });

  it('strips a plain http src, which would be blocked as mixed content anyway', () => {
    expect(sanitizeCommentHtml('<img src="http://example.com/cat.png">'))
      .not.toContain('example.com');
  });

  it('strips a protocol-relative src, which names no scheme to check', () => {
    expect(sanitizeCommentHtml('<img src="//evil.com/cat.png">'))
      .not.toContain('evil.com');
  });

  it('strips a data: src, which would smuggle bytes past the size caps', () => {
    expect(sanitizeCommentHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">'))
      .not.toContain('data:');
  });

  it('strips javascript: and event handlers on an image', () => {
    expect(sanitizeCommentHtml('<img src="javascript:alert(1)">')).not.toContain('javascript:');
    const out = sanitizeCommentHtml('<img src="https://e.com/a.png" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
  });

  it('strips a style attribute rather than letting CSS into the host page', () => {
    expect(sanitizeCommentHtml('<img src="https://e.com/a.png" style="position:fixed;inset:0">'))
      .not.toContain('position');
  });

  it('drops an svg entirely — it is a scriptable document, not a raster image', () => {
    const out = sanitizeCommentHtml('<svg><script>alert(1)</script></svg>');
    expect(out).not.toContain('svg');
    expect(out).not.toContain('alert');
  });
});

// The allowlist was widened so /reference embeds survive a save. These pin down
// both halves of that: the markup the editor produces has to come through
// whole, and everything the widening does NOT grant has to stay refused.
describe('sanitizeCommentHtml — reference embeds', () => {
  const embed =
    '<span class="note-embed" data-embed="article" data-variant="large" ' +
    'data-href="/a/aHR0cHM6Ly9leGFtcGxlLmNvbS94" data-url="https://example.com/x" ' +
    'data-title="A title" data-source="example.com" ' +
    'data-image="https://cdn.example.com/hero.jpg" data-meta="6 min" ' +
    'contenteditable="false">' +
    '<a class="note-embed-a" href="/a/aHR0cHM6Ly9leGFtcGxlLmNvbS94">' +
    '<img class="note-embed-cover" src="https://cdn.example.com/hero.jpg" alt="">' +
    '<span class="note-embed-body">' +
    '<span class="note-embed-kicker">Saved article</span>' +
    '<span class="note-embed-title">A title</span>' +
    '<span class="note-embed-comments"></span>' +
    '</span></a></span>';

  it('keeps everything the embed needs to be rebuilt', () => {
    const out = sanitizeCommentHtml(embed);
    for (const attr of [
      'data-embed="article"', 'data-variant="large"', 'data-url="https://example.com/x"',
      'data-title="A title"', 'data-source="example.com"', 'data-meta="6 min"',
      'data-image="https://cdn.example.com/hero.jpg"', 'data-href="/a/aHR0cHM6Ly9leGFtcGxlLmNvbS94"',
    ]) {
      expect(out).toContain(attr);
    }
    expect(out).toContain('class="note-embed"');
    expect(out).toContain('class="note-embed-a"');
    expect(out).toContain('class="note-embed-cover"');
    expect(out).toContain('class="note-embed-title"');
  });

  it('strips contenteditable — the editor re-applies it, readers never need it', () => {
    expect(sanitizeCommentHtml(embed)).not.toContain('contenteditable');
  });

  // The large card's summary. Unlike the live comment count it IS stored: it
  // describes the target rather than reporting on it, so it does not go stale.
  it('keeps the description, attribute and rendered line alike', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-embed" data-embed="page" data-variant="large" ' +
      'data-href="https://example.com/x" data-url="https://example.com/x" ' +
      'data-title="A title" data-source="example.com" ' +
      'data-description="What the page says about itself.">' +
      '<a class="note-embed-a" href="https://example.com/x">' +
      '<span class="note-embed-body">' +
      '<span class="note-embed-title">A title</span>' +
      '<span class="note-embed-desc">What the page says about itself.</span>' +
      '</span></a></span>');
    expect(out).toContain('data-description="What the page says about itself."');
    expect(out).toContain('class="note-embed-desc"');
  });

  // The new slot is a span like the rest of the card, so it grants nothing the
  // allowlist did not already grant: no script attributes, and no reach into
  // the app's other styling. (A plain <img> or <b> nested in there survives, as
  // it does anywhere else in a rich body - that is the existing policy for
  // author HTML, not something this class opened up.)
  it('gives a description no powers the rest of the card lacks', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-embed" data-embed="page" data-url="https://example.com/x">' +
      '<span class="note-embed-desc" onclick="alert(1)">' +
      '<span class="note-todo">smuggled</span></span></span>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('note-todo');
    expect(out).toContain('class="note-embed-desc"');
  });

  it('refuses a live comment count, so a stale one can never be served', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-embed" data-embed="article" data-url="https://example.com/x">' +
      '<span class="note-embed-comments" data-comments="99 comments"></span></span>');
    expect(out).not.toContain('data-comments');
    expect(out).not.toContain('99 comments');
  });

  // A repost is a post whose body opens with one of these, so the allowlist is
  // the difference between a saved repost and a saved blank card. The kind is
  // new; both of its links are site-relative, which the article case above -
  // remote image, /a/ href - does not cover on its own.
  it('keeps a reposted post’s card, links and all', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-embed" data-embed="post" data-variant="large" ' +
      'data-href="/u/ada/on-looms" data-url="https://newt.test/u/ada/on-looms" ' +
      'data-title="On looms" data-source="Ada Lovelace" ' +
      'data-image="/api/v1/images/img1" data-meta="Mar 4, 2026" ' +
      'contenteditable="false">' +
      '<a class="note-embed-a" href="/u/ada/on-looms">' +
      '<img class="note-embed-cover" src="/api/v1/images/img1" alt="">' +
      '<span class="note-embed-body">' +
      '<span class="note-embed-kicker">Blog post</span>' +
      '<span class="note-embed-title">On looms</span>' +
      '<span class="note-embed-comments"></span>' +
      '</span></a></span>');
    for (const attr of [
      'data-embed="post"', 'data-href="/u/ada/on-looms"',
      'data-url="https://newt.test/u/ada/on-looms"', 'data-source="Ada Lovelace"',
      'data-image="/api/v1/images/img1"',
    ]) {
      expect(out).toContain(attr);
    }
    // The uploaded hero is site-relative, so the https-only rule for <img> must
    // not read it as a scheme it dislikes
    expect(out).toContain('<img class="note-embed-cover" src="/api/v1/images/img1"');
    expect(out).toContain('href="/u/ada/on-looms"');
  });

  it('will not let a span reach any other styling in the app', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-todo note-embed evil-class">x</span>');
    expect(out).toContain('note-embed');
    expect(out).not.toContain('note-todo');
    expect(out).not.toContain('evil-class');
  });

  it('will not let an anchor or image borrow a class either', () => {
    const out = sanitizeCommentHtml(
      '<a class="note-todo" href="https://x.com">l</a>' +
      '<img class="note-table" src="https://x.com/i.png">');
    expect(out).not.toContain('note-todo');
    expect(out).not.toContain('note-table');
  });

  it('holds the line on schemes, in the data-* as well as the real attributes', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-embed" data-embed="article" ' +
      'data-href="javascript:alert(1)" data-image="javascript:alert(1)">' +
      '<a class="note-embed-a" href="javascript:alert(1)">x</a></span>');
    expect(out).not.toContain('javascript:');
  });

  it('still refuses every attribute the widening did not name', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-embed" style="position:fixed;inset:0" onclick="alert(1)" ' +
      'data-anything="x" id="hijack">t</span>');
    expect(out).not.toContain('style');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('data-anything');
    expect(out).not.toContain('id=');
  });
});

describe('sanitizeCommentHtml — galleries', () => {
  // What client/src/utils/noteGallery.ts produces, minus the contenteditable the
  // allowlist deliberately drops (the editor stamps it back on load)
  const gallery =
    '<p><span class="note-gallery" data-gallery="4" contenteditable="false">' +
    '<span class="note-gallery-stack">' +
    '<img class="note-gallery-card" src="/api/v1/images/img1" alt="one" loading="lazy">' +
    '<img class="note-gallery-card" src="/api/v1/images/img2" alt="two" loading="lazy">' +
    '<img class="note-gallery-card" src="https://cdn.example.com/three.jpg" alt="" loading="lazy">' +
    '<img class="note-gallery-card" src="/api/v1/images/img4" alt="" loading="lazy">' +
    '</span>' +
    '<span class="note-gallery-more">+1</span>' +
    '</span></p>';

  it('survives with every photograph it was written with', () => {
    const out = sanitizeCommentHtml(gallery);
    expect(out).toContain('class="note-gallery"');
    expect(out).toContain('data-gallery="4"');
    expect(out).toContain('class="note-gallery-stack"');
    expect(out).toContain('>+1<');
    expect(out.match(/class="note-gallery-card"/g)).toHaveLength(4);
    expect(out).toContain('src="/api/v1/images/img1"');
    expect(out).toContain('src="https://cdn.example.com/three.jpg"');
  });

  it('drops contenteditable, exactly as it does on an embed', () => {
    expect(sanitizeCommentHtml(gallery)).not.toContain('contenteditable');
  });

  it('holds every image in a gallery to the same https-only rule as any other', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-gallery" data-gallery="2"><span class="note-gallery-stack">' +
      '<img class="note-gallery-card" src="javascript:alert(1)">' +
      '<img class="note-gallery-card" src="http://insecure.example.com/a.png">' +
      '</span></span>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('http://insecure.example.com');
  });

  it('does not let the gallery classes become a way to reach the rest of the app', () => {
    const out = sanitizeCommentHtml(
      '<span class="note-gallery sidebar-nav">x</span>' +
      '<img class="note-gallery-card note-embed-cover heroImage" src="https://x.com/i.png">');
    expect(out).toContain('note-gallery');
    expect(out).not.toContain('sidebar-nav');
    expect(out).not.toContain('heroImage');
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

  // A reference whose source is unnamed carries no favicon and no meta line, so
  // the <img> test above would not catch it
  it('treats a bare reference as not blank', () => {
    expect(isBlankHtml(
      '<p><span class="note-embed" data-embed="article" data-url="https://x.com/a">' +
      '<a class="note-embed-a" href="/a/x"></a></span></p>')).toBe(false);
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
