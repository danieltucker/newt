import sanitizeHtml from 'sanitize-html';

// Comment bodies are rich-editor HTML and — unlike notes — can be read by other
// users once made public, so every body is sanitized on write. The allowlist is
// exactly what RichEditor produces: standard blocks, inline formatting, links,
// its `note-todo` checklist divs, `note-table` tables and `note-embed`
// references.
const TODO_CLASS = 'note-todo';
const TABLE_CLASS = 'note-table';

// ── Reference embeds ──────────────────────────────────────────────────
// Mirrors client/src/utils/noteEmbed.ts, which is what produces this markup —
// the two lists are duplicated across the client/server boundary exactly as
// TODO_CLASS and TABLE_CLASS already are. An embed is a span carrying its whole
// rendered state in data-*, so these have to survive the sanitizer or a saved
// post comes back as a bare link.
//
// Why this is safe to allow:
//  - The data-* are inert. Nothing renders them; the <a href> and <img src>
//    that *do* render stay under the scheme rules below, so no new capability
//    is reachable. data-href/data-image get the same scheme check anyway, in
//    allowedSchemesAppliedToAttributes — belt and braces, since the client
//    re-renders an embed from them.
//  - The classes are an explicit list, never a wildcard: an author cannot
//    reach for note-todo, or any other styling in the app, from a span.
//  - `contenteditable` is deliberately NOT allowed. Rendered posts have no use
//    for it, and letting an author make part of a reader's page editable is a
//    pointless oddity. The editor stamps it back on load (hydrateEmbeds).
//  - `data-comments` is likewise absent: the live comment count is written at
//    render time and must never be persisted, or it would be served stale.
//
// The residual, which the markup cannot fix: an embed's displayed source is
// author-supplied text that need not match where its link goes. That is the
// same trust model as link text ("<a href=evil>nytimes.com</a>") and the
// nofollow/noopener transform below still applies.
const EMBED_CLASS = 'note-embed';

// note-embed-comments stays listed for spans as well as anchors: embeds written
// before the row became a link still carry it on a span, and their saved markup
// has to keep rendering.
const EMBED_SPAN_CLASSES = [
  EMBED_CLASS,
  'note-embed-body', 'note-embed-title', 'note-embed-meta',
  'note-embed-kicker', 'note-embed-comments', 'note-embed-desc',
];

const EMBED_DATA_ATTRS = [
  'data-embed', 'data-variant', 'data-href', 'data-url',
  'data-title', 'data-source', 'data-image', 'data-meta',
  // The large card's summary. Text only, and rendered as text — it is escaped
  // into the markup by buildEmbedHtml and read back out with getAttribute, so
  // it is never a path to markup the way a class or a URL would be.
  'data-description',
];

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
    a: ['href', 'title', 'rel', 'target', 'class'],
    // Same applies to loading/referrerpolicy, which transformTags adds below.
    // Intrinsic width/height let the browser reserve layout space; no style
    // attribute, which would be a way to smuggle CSS into someone else's page.
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'referrerpolicy', 'class'],
    div: ['class', 'data-checked'],
    table: ['class'],
    span: ['class', ...EMBED_DATA_ATTRS],
  },
  // Only real web links — blocks javascript:, data:, vbscript:
  allowedSchemes: ['http', 'https', 'mailto'],
  // data-href/data-image are inert in a rendered post, but the client rebuilds
  // an embed from them, so they get the same scheme check as the real thing.
  allowedSchemesAppliedToAttributes: ['href', 'src', 'data-href', 'data-image'],
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
  // Keep only the structural classes the editor relies on. Every tag that
  // allows `class` above must appear here — a tag missing from this map keeps
  // its class attribute unfiltered, which is how an author would reach the
  // rest of the app's styling.
  allowedClasses: {
    div: [TODO_CLASS],
    table: [TABLE_CLASS],
    span: EMBED_SPAN_CLASSES,
    // note-embed-comments is an anchor now, not a span: it links to the thread,
    // which for a pasted link is somewhere the card itself does not go. Its
    // href gets the same scheme check and rel/target transform as any other
    // link in a body, so it grants nothing a plain <a> wouldn't.
    a: ['note-embed-a', 'note-embed-comments'],
    img: ['note-embed-thumb', 'note-embed-cover', 'note-embed-fav'],
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
  // Text-free but still meaningful blocks (a checked to-do, a table, a divider,
  // a reference — which can carry no text of its own if its source is unnamed)
  return !/<(hr|table|img)\b/i.test(html) && !new RegExp(`\\b${EMBED_CLASS}\\b`).test(html);
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

/**
 * Just the host an article URL points at, normalised the same way
 * canonicalArticleKey normalises its host half: lowercased, `www.` stripped.
 *
 * This is the site-page key (/s/<domain>). It lives beside the key above rather
 * than in the sites route because it is written on ingest, by the feed
 * refresher — the two must normalise identically or a stored FeedItem.linkHost
 * would never match a request for the domain printed on its own card.
 *
 * Returns '' for anything that isn't a URL, which is a value no lookup matches.
 */
export function articleHost(raw: string): string {
  try {
    return new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
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
