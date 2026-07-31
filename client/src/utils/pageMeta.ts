// Title and artwork for an arbitrary URL, so a pasted link can be rendered as
// a card instead of a bare anchor.
//
// The fetch happens server-side (/api/v1/util/page-meta): it is an authed
// endpoint because fetching a URL on the user's behalf is an SSRF surface, and
// the browser could not read most pages anyway thanks to CORS.
//
// Never throws. A link whose metadata cannot be read is still a perfectly good
// link - the caller falls back to the host name, which is the one thing about a
// URL that is always true.

import { apiFetch } from '../services/api';
import { EmbedData } from './noteEmbed';

export interface PageMeta {
  title: string | null;
  image: string | null;
  /** og:description and friends, already collapsed and capped server-side. */
  description: string | null;
}

/** Nothing known about the page. What a failed or unattempted fetch yields. */
export const EMPTY_PAGE_META: PageMeta = { title: null, image: null, description: null };

export async function fetchPageMeta(url: string): Promise<PageMeta> {
  try {
    const res = await apiFetch(`/api/v1/util/page-meta?url=${encodeURIComponent(url)}`);
    if (!res.ok) return EMPTY_PAGE_META;
    const data = await res.json();
    return {
      title: data?.title ?? null,
      image: data?.image ?? null,
      description: data?.description ?? null,
    };
  } catch {
    return EMPTY_PAGE_META;
  }
}

/**
 * Whether a pasted string is nothing but a web address, and so is worth turning
 * into a link on the spot.
 *
 * Deliberately narrow. Pasting is how text arrives, and text that merely
 * *contains* a URL - a sentence, a citation, a log line - must paste as what it
 * is. Only an http(s) URL standing entirely on its own qualifies; a bare
 * "example.com" does not, because a pasted word should not silently become a
 * link to somewhere.
 */
export function isBareUrl(text: string): boolean {
  const s = text.trim();
  if (!s || /\s/.test(s)) return false;
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return !!u.hostname && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** The host, without the "www." nobody reads. Falls back to the raw string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

/**
 * Build the embed for a plain URL. `title` is what the writer typed, if
 * anything - their own words beat whatever the page calls itself, so the fetched
 * title is only a fallback, and the host is the fallback for that.
 */
export function pageEmbed(url: string, meta: PageMeta, title?: string): EmbedData {
  const host = hostOf(url);
  return {
    kind: 'page',
    href: url,
    url,
    title: (title || '').trim() || meta.title || host,
    source: host,
    image: meta.image || undefined,
    // Only the large card shows this, and only if the page offered one - see
    // EmbedData.description.
    description: meta.description || undefined,
  };
}
