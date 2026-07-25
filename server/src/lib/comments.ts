import sanitizeHtml from 'sanitize-html';

// Comment bodies are rich-editor HTML and — unlike notes — can be read by other
// users once made public, so every body is sanitized on write. The allowlist is
// exactly what RichEditor produces: standard blocks, inline formatting, links,
// its `note-todo` checklist divs and `note-table` tables.
const TODO_CLASS = 'note-todo';
const TABLE_CLASS = 'note-table';

// Two independent caps on a comment body:
//  - MAX_COMMENT_BODY bounds the raw HTML (markup + text) — a hard safety limit
//    against oversized payloads.
//  - MAX_COMMENT_TEXT bounds the *visible* text once tags are stripped, so a
//    comment stays comment-sized (rich formatting can still be verbose in HTML
//    while the readable content is capped).
export const MAX_COMMENT_BODY = 20_000;
export const MAX_COMMENT_TEXT = 5_000;
export const MAX_COMMENT_TITLE = 200;

// Length of the readable text in a comment body, with tags stripped and
// whitespace collapsed. Structural-but-textless content (an image, a divider)
// contributes nothing here — the raw-HTML cap covers those.
export function commentTextLength(html: string): number {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

// The single allowlist for every piece of user-authored rich text in the app —
// comments and blog posts alike. Both come out of the same RichEditor, and both
// end up readable by other users, so they must be sanitized to exactly the same
// shape. Keep one copy: a divergence here is a security bug, not a style issue.
const RICH_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'div', 'span',
    'h1', 'h2', 'h3',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    // rel/target must be allowed here or the transformTags below is silently
    // stripped back off, losing the noopener protection it exists to add
    a: ['href', 'title', 'rel', 'target'],
    // Same applies to loading/referrerpolicy, which transformTags adds below.
    // Intrinsic width/height let the browser reserve layout space; no style
    // attribute, which would be a way to smuggle CSS into someone else's page.
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'referrerpolicy'],
    div: ['class', 'data-checked'],
    table: ['class'],
  },
  // Only real web links — blocks javascript:, data:, vbscript:
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  // An image is loaded automatically, without the click a link needs, so its
  // scheme list is stricter than a link's: https only. Plain http would be
  // blocked as mixed content the moment the app is served over TLS anyway, and
  // data: URLs are excluded so a body can't carry its own inline payload past
  // the size caps. Site-relative srcs — our own /api/v1/images/<id> uploads —
  // have no scheme and are unaffected by this list.
  allowedSchemesByTag: { img: ['https'] },
  // "//host/x.png" inherits the page's scheme and would otherwise slip past the
  // per-tag list above, which only inspects URLs that name a scheme.
  allowProtocolRelative: false,
  transformTags: {
    // Anything user-supplied that opens a new tab must not get window.opener
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
    // Remote images are permitted, so limit what the remote host learns: without
    // this it receives the full URL of the post or thread doing the embedding in
    // the Referer header. Lazy loading also means images below the fold are not
    // fetched at all until scrolled to.
    img: sanitizeHtml.simpleTransform('img', { loading: 'lazy', referrerpolicy: 'no-referrer' }),
  },
  // Keep only the two structural classes the editor relies on
  allowedClasses: {
    div: [TODO_CLASS],
    table: [TABLE_CLASS],
  },
  // Drop the contents of these outright rather than leaving bare text behind
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe'],
};

// Sanitize rich-editor HTML and cap its raw length. `maxLength` differs by
// content type (a comment is not a blog post) but the allowlist never does.
export function sanitizeRichHtml(html: string, maxLength: number): string {
  return sanitizeHtml(html, RICH_HTML_OPTIONS).slice(0, maxLength);
}

export function sanitizeCommentHtml(html: string): string {
  return sanitizeRichHtml(html, MAX_COMMENT_BODY);
}

// True when the body carries no actual content — an empty editor still submits
// markup like "<p><br></p>", which should not count as a comment.
export function isBlankHtml(html: string): boolean {
  const stripped = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .trim();
  if (stripped.length > 0) return false;
  // Text-free but still meaningful blocks (a checked to-do, a table, a divider)
  return !/<(hr|table|img)\b/i.test(html);
}

// Normalises an article URL so the same piece read from a feed, a saved reading
// list entry, or a shared link all resolve to one comment thread. Tracking
// params are dropped so "?utm_source=..." variants don't fork the thread.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_(cid|eid)$|ref$|ref_src$|igshid$|cmpid$|smid$)/i;

export function canonicalArticleKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const search = params.length
      ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}`
      : '';
    return `${host}${path}${search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function isHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  try {
    const p = new URL(raw);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}
