import nodeFetch from 'node-fetch';
import type { Readable } from 'stream';
import { isSafeUrl } from './isSafeUrl';
import { safeFetch } from './safeFetch';
import { parseFeed, parseFeedTitle } from './feedUtils';
import { platformFeed } from './feedSources';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

// Where feeds hide when a page doesn't advertise one. Ordered by how common
// they are, because each miss is an outbound request.
const FEED_PATHS = ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml', '/index.xml', '/blog/feed', '/feed/rss'];

export function findFeedInHtml(html: string, base: string): string | null {
  for (const [, attrs] of html.matchAll(/<link([^>]+)>/gi)) {
    const isAlternate = /rel=["']alternate["']/i.test(attrs);
    const isFeed = /type=["'](application\/(rss|atom)\+xml)["']/i.test(attrs);
    if (isAlternate && isFeed) {
      const m = attrs.match(/href=["']([^"']+)["']/i);
      if (m) {
        try { return m[1].startsWith('http') ? m[1] : new URL(m[1], base).toString(); }
        catch { return null; }
      }
    }
  }
  return null;
}

// Read at most `maxBytes` of a remote document. The byte budget is the point:
// the URL is attacker-chosen (anyone can add a bookmark, or paste an address
// into the feed manager), so an endless or enormous response must not be
// allowed to buffer into the heap.
//
// Reaching the cap resolves with what we have *and destroys the stream* — without
// that the socket stays open and the origin keeps sending forever, since the 5s
// timeout only fires on an idle socket, not a slow-but-steady one.
export async function fetchXml(url: string, maxBytes = 150_000): Promise<string | null> {
  try {
    // safeFetch rather than a bare nodeFetch. The isSafeUrl call each caller
    // makes first judges the address it was given; it cannot speak for where a
    // redirect leads, nor for what the name resolves to a moment later when the
    // connection is actually opened. Pinning and re-checking per hop covers both.
    const res = await safeFetch(url, { timeout: 5000, size: maxBytes * 2, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Newt/1.0)' } } as FetchOptions);
    // node-fetch v2 hands back a Node Readable at runtime; the ambient DOM lib
    // types it as a web ReadableStream, which has no destroy().
    const body = res.body as unknown as Readable | null;
    if (!res.ok) { body?.destroy(); return null; }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    return await new Promise<string | null>(resolve => {
      const finish = (v: string | null) => {
        if (settled) return;
        settled = true;
        body!.destroy();
        resolve(v);
      };
      res.body!.on('data', (c: Buffer) => { if (settled) return; chunks.push(c); size += c.length; if (size >= maxBytes) finish(Buffer.concat(chunks).toString('utf8')); });
      res.body!.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      res.body!.on('error', () => finish(null));
    });
  } catch { return null; }
}

export function isFeedXml(text: string): boolean {
  const t = text.trimStart();
  return (t.startsWith('<?xml') || t.startsWith('<rss') || t.startsWith('<feed')) &&
    (text.includes('<item') || text.includes('<entry') || text.includes('<channel'));
}

// Finds a domain's feed: the homepage's advertised <link rel="alternate">
// first, then the usual paths.
export async function discoverFeed(domain: string): Promise<string | null> {
  const base = `https://${domain}`;
  if (await isSafeUrl(base)) {
    const html = await fetchXml(base, 500_000);
    if (html) {
      const found = findFeedInHtml(html, base);
      if (found && await isSafeUrl(found)) {
        const xml = await fetchXml(found, 8_000);
        if (xml && isFeedXml(xml)) return found;
      }
    }
  }
  for (const path of FEED_PATHS) {
    const url = `${base}${path}`;
    if (!(await isSafeUrl(url))) continue;
    const xml = await fetchXml(url, 8_000);
    if (xml && isFeedXml(xml)) return url;
  }
  return null;
}

export type ResolvedFeed =
  | { ok: true; url: string; title: string; itemCount: number }
  | { ok: false; error: string };

/**
 * Turns whatever the user typed into a feed, or explains why it isn't one.
 *
 * Accepting only feed URLs would be the easy contract and the wrong one: people
 * paste the address of the *site* they read, not its feed, and being told "that
 * isn't a feed" when the feed is one <link> tag away is a dead end. So a page
 * that isn't itself a feed gets the same discovery a new bookmark does before
 * we give up.
 *
 * Bare hostnames ("npr.org") are allowed and assumed https — a scheme is not
 * something a reader should have to remember.
 *
 * A handful of sites are asked about by name first (see feedSources): YouTube,
 * Bluesky, Reddit and GitHub all publish perfectly good feeds that this general
 * method cannot find, because the address of the feed isn't derivable from the
 * page and isn't advertised where the page can be read cheaply.
 */
export async function resolveFeedUrl(raw: string): Promise<ResolvedFeed> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Enter a site or feed address' };

  let target: URL;
  try {
    target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: "That doesn't look like a web address" };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https addresses work here' };
  }
  // The server is about to fetch this on the user's say-so, so it gets the same
  // SSRF gate every other user-supplied URL does.
  if (!(await isSafeUrl(target.toString()))) {
    return { ok: false, error: "That address can't be reached" };
  }

  // Known platforms first. This is a shortcut, never a gate: anything it can't
  // place — including a youtube.com URL that isn't a channel — falls through to
  // the general method below rather than being rejected.
  const platform = await platformFeed(target, fetchXml);
  if (platform) {
    for (const candidate of platform.candidates) {
      if (!(await isSafeUrl(candidate))) continue;
      const xml = await fetchXml(candidate, 500_000);
      if (!xml || !isFeedXml(xml)) continue;
      const described = describeFeed(xml);
      // An empty candidate is not an answer — a repo with no releases yet should
      // fall through to its commits, not resolve to a feed that never delivers.
      if (described.itemCount > 0) return { ok: true, url: candidate, ...described };
    }
  }

  const body = await fetchXml(target.toString(), 500_000);
  if (body === null) {
    return { ok: false, error: platform
      ? `Couldn't find anything to follow on that ${platform.source} address`
      : "Couldn't load that address — is it up?" };
  }

  // Already a feed: take it as given.
  if (isFeedXml(body)) {
    const parsed = describeFeed(body);
    if (parsed.itemCount === 0) return { ok: false, error: 'That feed is empty' };
    return { ok: true, url: target.toString(), title: parsed.title, itemCount: parsed.itemCount };
  }

  // An HTML page. Ask it where its feed is, then fall back to the usual paths.
  const advertised = findFeedInHtml(body, target.toString());
  if (advertised && await isSafeUrl(advertised)) {
    const xml = await fetchXml(advertised, 500_000);
    if (xml && isFeedXml(xml)) {
      return { ok: true, url: advertised, ...describeFeed(xml) };
    }
  }

  const found = await discoverFeed(target.hostname);
  if (found) {
    const xml = await fetchXml(found, 500_000);
    if (xml && isFeedXml(xml)) {
      return { ok: true, url: found, ...describeFeed(xml) };
    }
  }

  return { ok: false, error: platform
    ? `Couldn't find anything to follow on that ${platform.source} address`
    : `No feed found at ${target.hostname}` };
}

function describeFeed(xml: string): { title: string; itemCount: number } {
  return { title: parseFeedTitle(xml), itemCount: parseFeed(xml, 100).length };
}
