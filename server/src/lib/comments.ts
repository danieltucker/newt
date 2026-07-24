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

export function sanitizeCommentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr', 'div', 'span',
      'h1', 'h2', 'h3',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
      'a',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      // rel/target must be allowed here or the transformTags below is silently
      // stripped back off, losing the noopener protection it exists to add
      a: ['href', 'title', 'rel', 'target'],
      div: ['class', 'data-checked'],
      table: ['class'],
    },
    // Only real web links — blocks javascript:, data:, vbscript:
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    // Anything user-supplied that opens a new tab must not get window.opener
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
    },
    // Keep only the two structural classes the editor relies on
    allowedClasses: {
      div: [TODO_CLASS],
      table: [TABLE_CLASS],
    },
    // Drop the contents of these outright rather than leaving bare text behind
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe'],
  }).slice(0, MAX_COMMENT_BODY);
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
