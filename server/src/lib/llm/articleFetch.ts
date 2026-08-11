import nodeFetch from 'node-fetch';
import type { Readable } from 'stream';
import { makeSafeAgent } from '../isSafeUrl';
import { htmlToText } from './htmlText';

/**
 * Reading the page itself, when what Newt stored isn't enough to answer about.
 *
 * Most feeds do not publish full text. A great many publish two sentences and a
 * "read more" link, and until now that was the entire body a question about the
 * article was answered from — which is why the answers read as though the model
 * were guessing. It was: the model had a headline, a teaser, and a strong
 * instruction to treat them as the subject.
 *
 * So this goes and reads the page. That is a real change to what the server
 * does, and it is only safe because of the two things wrapped around it:
 *
 *  - **Every hop goes through the SSRF gate.** `makeSafeAgent` resolves the
 *    hostname, refuses private addresses and pins the connection to the address
 *    it checked. Redirects are followed by hand rather than by node-fetch
 *    precisely so each hop is re-checked — an open redirect on a site somebody
 *    subscribed to is otherwise a way to point this at 169.254.169.254.
 *  - **The response is capped and the socket is destroyed at the cap.** The URL
 *    is effectively attacker-chosen, since anyone can add a feed.
 *
 * Nothing here is ever rendered. The extracted text goes into a prompt as text
 * and into the cache as text, so the markup is thrown away rather than trusted.
 */

/** Enough for a long feature; past this a page is mostly framework. */
const MAX_HTML_BYTES = 800_000;
/** Article bodies past this are being padded by something that isn't prose. */
const MAX_TEXT_CHARS = 60_000;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 4;
const USER_AGENT = 'Mozilla/5.0 (compatible; Newt/1.0)';

/**
 * Below this, the extraction did not find an article — it found navigation, a
 * consent wall, or a teaser. Reported as a miss so the caller falls back to
 * whatever the feed gave rather than replacing prose with chrome.
 */
const MIN_ARTICLE_CHARS = 600;

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

/** Wrappers whose content is never the article. */
const STRIP_TAGS = [
  'script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'header',
  'footer', 'aside', 'template', 'button', 'select', 'video', 'audio', 'canvas',
];

/** id/class words that mark a div as the body of the piece. */
const CONTENT_HINT = /(?:^|[-_\s"'])(?:article|articlebody|content|post|story|entry|main|body|text)(?:[-_\s"']|$)/i;

/**
 * Read at most `MAX_HTML_BYTES` of a page, re-validating every redirect.
 *
 * Returns null for anything that isn't HTML we could read — a non-HTML type, a
 * non-OK status, a hop that fails the gate, a timeout. The caller treats all of
 * those the same way, because from the reader's point of view they are: the
 * article's text could not be had.
 */
async function fetchHtml(startUrl: string): Promise<string | null> {
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const agent = await makeSafeAgent(url);
    if (!agent) return null;

    let res;
    try {
      res = await nodeFetch(url, {
        agent,
        timeout: TIMEOUT_MS,
        // Followed by hand — see the note at the top of the file. node-fetch
        // would reuse this agent for the next hop, and this agent's DNS is
        // pinned to the *previous* host's address.
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      } as FetchOptions);
    } catch {
      return null;
    }

    const body = res.body as unknown as Readable | null;

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      body?.destroy();
      if (!location) return null;
      try { url = new URL(location, url).toString(); } catch { return null; }
      continue;
    }

    if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) {
      body?.destroy();
      return null;
    }
    if (!body) return null;

    return await new Promise<string | null>(resolve => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      // Resolving alone is not enough: the timeout above is an idle timer, so a
      // page that trickles bytes forever would hold the socket open with nobody
      // waiting on it. Destroying tells the origin to stop.
      const finish = (v: string | null) => {
        if (settled) return;
        settled = true;
        body.destroy();
        resolve(v);
      };
      body.on('data', (c: Buffer) => {
        if (settled) return;
        chunks.push(c);
        size += c.length;
        if (size >= MAX_HTML_BYTES) finish(Buffer.concat(chunks).toString('utf8'));
      });
      body.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      body.on('error', () => finish(null));
    });
  }

  return null;
}

/** Where a tag opened at `from` closes, counting nested opens of the same tag. */
function matchingClose(html: string, tag: string, from: number): number {
  const scan = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, 'gi');
  scan.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return -1;
}

/**
 * The inner HTML of each top-level `<tag>` in the document.
 *
 * Depth-counted rather than matched with a lazy regex, because `<div>` nests
 * about eight deep on a real page and `<div[^>]*>[\s\S]*?<\/div>` closes on the
 * first inner one — which on a news site reliably returns the byline and
 * nothing else. `lastIndex` skips past each block that is taken, so a nested
 * candidate is never returned alongside its own parent.
 */
function blocksOf(
  html: string,
  tag: string,
  attrTest?: (attrs: string) => boolean,
  limit = 12,
): string[] {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = open.exec(html))) {
    if (attrTest && !attrTest(m[1] ?? '')) continue;
    const end = matchingClose(html, tag, m.index + m[0].length);
    if (end === -1) continue;
    out.push(html.slice(m.index + m[0].length, end));
    open.lastIndex = end;
  }
  return out;
}

/**
 * How much of a block is prose.
 *
 * Counted from `<p>` elements only, which is the whole trick: a navigation
 * column, a related-articles rail and a comment thread are all mostly link text
 * in list items, and they beat the article on raw character count while
 * containing almost no paragraphs.
 */
function proseLength(html: string): number {
  let total = 0;
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    total += m[1].replace(/<[^>]+>/g, '').trim().length;
  }
  return total;
}

/**
 * The body a news site put in its JSON-LD, if it did.
 *
 * Worth trying first: where it exists it is the publisher's own answer to
 * "which of this page is the article", with no markup and no furniture. Parsed
 * leniently — one malformed block on a page that has four of them should not
 * cost us the one that parses.
 */
export function articleBodyFromJsonLd(html: string): string | null {
  for (const m of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }

    // The shape is wildly inconsistent in the wild: a bare object, an array of
    // them, or one wrapped in @graph. Walk whatever came back.
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (typeof node !== 'object' || node === null) continue;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj['@graph'])) queue.push(...obj['@graph']);
      const body = obj.articleBody;
      if (typeof body === 'string' && body.trim().length >= MIN_ARTICLE_CHARS) {
        return body.trim();
      }
    }
  }
  return null;
}

/**
 * The readable part of a page, as plain text.
 *
 * A deliberately small readability: strip the furniture, collect the candidate
 * containers most likely to hold the piece, and keep whichever has the most
 * prose in it. It gets the body of an ordinary article page, and it does not
 * try to be clever about anything else — a miss returns '' and the caller falls
 * back to what the feed gave, which is the same place it started.
 *
 * Exported for its tests; nothing else calls it directly.
 */
export function extractReadable(html: string): string {
  const fromJsonLd = articleBodyFromJsonLd(html);
  if (fromJsonLd) return fromJsonLd.slice(0, MAX_TEXT_CHARS);

  let cleaned = html;
  for (const tag of STRIP_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  // Comment markup routinely carries whole paragraphs of hidden or templated
  // text, which would otherwise win the scoring outright.
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, ' ');

  const candidates = [
    ...blocksOf(cleaned, 'article'),
    ...blocksOf(cleaned, 'main'),
    ...blocksOf(cleaned, 'div', attrs => CONTENT_HINT.test(attrs)),
    ...blocksOf(cleaned, 'body', undefined, 1),
  ];

  let best = '';
  let bestScore = 0;
  for (const block of candidates) {
    const score = proseLength(block);
    if (score > bestScore) { best = block; bestScore = score; }
  }

  if (bestScore < MIN_ARTICLE_CHARS) return '';
  return htmlToText(best).slice(0, MAX_TEXT_CHARS);
}

/**
 * The text of the page at `url`, or '' if it could not be read.
 *
 * Never throws and never rejects: a question about an article has to be
 * answerable when the site is down, behind a paywall, or serving a consent
 * interstitial. All of those come back as '' and the caller carries on with the
 * feed's copy.
 */
export async function fetchArticleText(url: string): Promise<string> {
  const html = await fetchHtml(url).catch(() => null);
  if (!html) return '';
  try {
    return extractReadable(html);
  } catch {
    return '';
  }
}
