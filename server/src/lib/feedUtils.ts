import sanitizeHtml from 'sanitize-html';

// Feed bodies are third-party HTML rendered straight into the reader, so they
// get a tighter allowlist than user comments: no forms, no media embeds, no
// inline styles, and images only over https (an http image would downgrade the
// page and leak the reader's IP to the publisher over plaintext).
const MAX_CONTENT_CHARS = 120_000;

export function sanitizeFeedHtml(raw: string): string | null {
  const html = cleanContent(raw);
  if (!html.trim()) return null;
  const clean = sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr', 'div', 'span', 'section', 'article',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'blockquote', 'pre', 'code', 'kbd', 'samp',
      'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark',
      'sub', 'sup', 'small', 'abbr', 'cite', 'q',
      'a', 'img', 'figure', 'figcaption', 'picture', 'source',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    ],
    allowedAttributes: {
      // rel/target and loading/referrerpolicy must be allowed here or the
      // transformTags below are silently stripped back off
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height', 'srcset', 'sizes', 'loading', 'referrerpolicy'],
      source: ['srcset', 'sizes', 'type'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
      img: sanitizeHtml.simpleTransform('img', { loading: 'lazy', referrerpolicy: 'no-referrer' }),
    },
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe', 'form', 'button'],
    // Drop <img> whose src was stripped for being http/data — a broken icon is
    // worse than no image
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs?.src,
  }).trim();
  if (!clean) return null;
  return clean.length > MAX_CONTENT_CHARS ? clean.slice(0, MAX_CONTENT_CHARS) : clean;
}

// ── RSS / Atom parser ──────────────────────────────────────────────────────

// Numeric character references come in both bases and feeds use both. Hex was
// missing here, which is how "&#xA;" - a plain line break, and what Bluesky
// writes for every one of them - ended up printed literally in article titles.
// Anything outside the Unicode range is left as written rather than thrown over:
// a malformed entity in someone's feed is not worth failing an ingest for.
function decodeCodePoint(raw: string, base: number): string {
  const n = parseInt(raw, base);
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => decodeCodePoint(n, 16) || m)
    .replace(/&#(\d+);/g, (m, n) => decodeCodePoint(n, 10) || m)
    // Named entities last: &amp;#60; is an escaped "&#60;", not a "<". Decoding
    // &amp; first would turn it into &#60; and the numeric pass would then
    // finish the job, producing a character the feed deliberately escaped.
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function cleanContent(s: string): string {
  return decodeXmlEntities(s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim());
}

export interface FeedItem {
  title: string;
  link: string;
  date: Date | null;
  readTime: number | null;
  snippet: string | null;
  content: string | null;
  imageUrl: string | null;
  categories: string[];
}

function extractSnippet(raw: string, maxChars = 200): string | null {
  const text = stripHtml(cleanContent(raw)).replace(/\s+/g, ' ').trim();
  if (!text || text.length < 20) return null;
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(' ', maxChars);
  return (cut > 80 ? text.slice(0, cut) : text.slice(0, maxChars)) + '…';
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Longest a derived title runs before it is cut at a word boundary.
const DERIVED_TITLE_CHARS = 90;

/**
 * A headline for an item that has no <title>.
 *
 * Microblogs publish posts, not articles, so their feeds legitimately carry
 * none: a Bluesky item is a <link>, a <description> and a <pubDate>, full stop.
 * Requiring a title dropped every one of them — the feed fetched fine, parsed
 * fine, and delivered nothing, which is the worst way for this to fail. So the
 * first line of the post becomes the headline, the way every other reader shows
 * them.
 *
 * Deliberately not a fallback to the feed's own title: fifty cards all called
 * "@someone - Bluesky" are less use than fifty first lines, and the byline
 * already says who wrote it.
 */
export function titleFromContent(raw: string): string {
  // Tags out but line breaks kept, because the break is the signal: a post's
  // first line is its headline. stripHtml would flatten them into spaces, so
  // the split has to happen before the collapse, not after.
  const text = cleanContent(raw).replace(/<[^>]+>/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').trim();
  if (!text) return '';
  const firstLine = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  if (!firstLine) return '';
  if (firstLine.length <= DERIVED_TITLE_CHARS) return firstLine;
  const cut = firstLine.lastIndexOf(' ', DERIVED_TITLE_CHARS);
  return `${firstLine.slice(0, cut > 40 ? cut : DERIVED_TITLE_CHARS).trim()}…`;
}

function estimateReadTime(raw: string): number | null {
  const text = stripHtml(cleanContent(raw));
  if (!text) return null;
  const words = text.split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}

function sanitizeImageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const url = decodeXmlEntities(raw.trim());
  return /^https:\/\//i.test(url) && url.length <= 2048 ? url : null;
}

// Article image, in preference order: Media RSS thumbnail, media:content
// (when it declares an image or nothing at all — it can also carry video),
// image enclosure, first <img> in the content HTML.
function extractImage(entry: string, contentRaw: string): string | null {
  const thumb = entry.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1];
  if (thumb) return sanitizeImageUrl(thumb);

  const mediaRe = /<media:content\b([^>]*)>/gi;
  let mm;
  while ((mm = mediaRe.exec(entry)) !== null) {
    const attrs = mm[1];
    const isImage = /medium=["']image["']/i.test(attrs) || /type=["']image\//i.test(attrs)
      || (!/medium=/i.test(attrs) && !/type=/i.test(attrs));
    if (!isImage) continue;
    const url = sanitizeImageUrl(attrs.match(/url=["']([^"']+)["']/i)?.[1]);
    if (url) return url;
  }

  const encRe = /<enclosure\b([^>]*)>/gi;
  let em;
  while ((em = encRe.exec(entry)) !== null) {
    const attrs = em[1];
    if (!/type=["']image\//i.test(attrs)) continue;
    const url = sanitizeImageUrl(attrs.match(/url=["']([^"']+)["']/i)?.[1]);
    if (url) return url;
  }

  return sanitizeImageUrl(cleanContent(contentRaw).match(/<img[^>]+src=["']([^"']+)["']/i)?.[1]);
}

export function parseFeed(xml: string, limit = 100): FeedItem[] {
  const items: FeedItem[] = [];
  const isAtom = xml.includes('<feed') && (xml.includes('<entry>') || xml.includes('<entry '));
  const itemRe = isAtom
    ? /<entry[\s>]([\s\S]*?)<\/entry>/gi
    : /<item[\s>]([\s\S]*?)<\/item>/gi;

  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const e = m[1];
    const rawTitle = e.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
    const title = cleanContent(rawTitle);
    // Entity-decoded: feeds write query separators as &amp;, which would
    // otherwise be stored literally and turn "?a=1&b=2" into a bogus "amp;b"
    // param on every outbound link
    const link = decodeXmlEntities(isAtom
      ? (e.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? e.match(/<link>([^<]+)<\/link>/i)?.[1] ?? '')
      : (e.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1] ?? ''));
    const rawDate = isAtom
      ? (e.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ?? e.match(/<published>([\s\S]*?)<\/published>/i)?.[1])
      : (e.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? e.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)?.[1]);

    // Read time from content:encoded → description/summary (prefer longer)
    const contentRaw = e.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)?.[1]
      ?? e.match(/<content[^>]*type=["'](?:html|text)["'][^>]*>([\s\S]*?)<\/content>/i)?.[1]
      ?? e.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]
      ?? e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1]
      ?? '';
    const readTime = estimateReadTime(contentRaw);
    const snippet = extractSnippet(contentRaw);
    const content = sanitizeFeedHtml(contentRaw);
    const imageUrl = extractImage(e, contentRaw);

    // Categories
    const categories: string[] = [];
    if (isAtom) {
      const catRe = /<category[^>]+(?:term|label)=["']([^"']+)["']/gi;
      let cm;
      while ((cm = catRe.exec(e)) !== null) {
        const c = cleanContent(cm[1]).trim();
        if (c && !categories.includes(c)) categories.push(c);
      }
    } else {
      const catRe = /<category[^>]*>([^<]+)<\/category>/gi;
      let cm;
      while ((cm = catRe.exec(e)) !== null) {
        const c = cleanContent(cm[1]).trim();
        if (c && !categories.includes(c)) categories.push(c);
      }
    }

    // A titleless item is still an item — see titleFromContent. An item with
    // neither a title nor anything to make one out of is still dropped, which
    // is what the original title check was really guarding against.
    const headline = title || titleFromContent(contentRaw);

    if (headline && link.trim()) {
      const date = rawDate ? new Date(rawDate.trim()) : null;
      items.push({
        title: headline, link: link.trim(),
        date: date && !isNaN(date.getTime()) ? date : null,
        readTime, snippet, content, imageUrl,
        categories: categories.slice(0, 5),
      });
    }
  }
  return items;
}

export function parseFeedTitle(xml: string): string {
  const m = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanContent(m[1]) : '';
}

// Normalises a feed URL so permutations (http/https, www., trailing slash,
// hash fragments) map to the same shared Feed row.
export function canonicalFeedKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

// The unread-count checker that used to live here is gone. Nothing had called
// it since badges started being counted from ReadFeedItem/DismissedFeedItem
// state (see lib/unread) rather than from a fresh fetch, and it was the last
// thing in the server still fetching a user-supplied URL with `redirect:
// 'follow'` and no address check - so it would have had to be rewritten onto
// lib/safeFetch to survive, for a caller that does not exist.
