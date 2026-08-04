import nodeFetch from 'node-fetch';
import sanitizeHtml from 'sanitize-html';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

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

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
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

    if (title && link.trim()) {
      const date = rawDate ? new Date(rawDate.trim()) : null;
      items.push({
        title, link: link.trim(),
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

// ── Feed checker ───────────────────────────────────────────────────────────

export interface FeedCheckResult {
  newCount: number;
  latestAt: Date | null;
}

export async function checkFeed(feedUrl: string, since: Date | null): Promise<FeedCheckResult> {
  const resp = await nodeFetch(feedUrl, {
    timeout: 8000,
    // The URL comes from a bookmark, so it is attacker-choosable. Bound the body
    // by bytes as well as by time — the timeout is an idle-socket timer and never
    // fires on an endless response that trickles steadily. See MAX_FEED_BYTES in
    // feedRefresh for the same reasoning.
    size: 2_000_000,
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Newt/1.0; +Feed)' },
  } as FetchOptions);
  if (!resp.ok) throw new Error(`Feed returned ${resp.status}`);

  const xml = await resp.text();
  const items = parseFeed(xml, 100);

  if (items.length === 0) return { newCount: 0, latestAt: null };

  const dates = items.map(i => i.date).filter(Boolean) as Date[];
  const latestAt = dates.length > 0
    ? new Date(Math.max(...dates.map(d => d.getTime())))
    : null;

  // First check: establish baseline, no unread count yet
  if (!since) return { newCount: 0, latestAt };

  const newCount = dates.filter(d => d > since).length;
  return { newCount, latestAt };
}
