import { publicOrigin } from './blog';
import { escapeHtml, jsonLdScript, collapseWhitespace, safeInNoscript } from './htmlEscape';

// Builds the <head> a crawler and a link unfurler read.
//
// Everything the app serves is one static index.html, so until this existed
// every Newt URL on the internet carried the same title and no description at
// all: a shared post previewed as a blank card in Slack, and a search engine
// that does not run JavaScript saw an empty <div id="root">. This module is what
// makes a URL describe itself.
//
// It renders a string rather than returning a structure, because the consumer is
// a template with a marker in it, not a DOM. Every value that reaches a tag goes
// through htmlEscape on the way — see that module for why that matters more here
// than anywhere else in the app.

/** How much of a description a search result or an unfurl will actually show. */
const MAX_DESCRIPTION = 200;

export interface SeoFeed {
  href: string;
  title: string;
}

export interface SeoPage {
  /** The <title>, without any site suffix — this adds it. */
  title: string;
  description?: string;
  /** Absolute URL this page should be credited as. Always set it. */
  canonical: string;
  /** Site-relative (/api/v1/images/x) or absolute; absolutized here. */
  image?: string | null;
  ogType?: 'website' | 'article' | 'profile';
  /**
   * The robots directive. Omitted means indexable, which is the default for a
   * public page — see the note on `/a/` pages in routes/html.ts for the one
   * place that is deliberately not true.
   */
  robots?: string;
  publishedTime?: Date;
  modifiedTime?: Date;
  /** Shown as the article's author in unfurls and structured data. */
  authorName?: string;
  feeds?: SeoFeed[];
  /** schema.org structured data. Rendered through jsonLdScript, never inline. */
  jsonLd?: unknown;
}

const SITE_NAME = 'Newt';

/** A site-relative path made absolute, or null if there is nothing to absolutize. */
export function absoluteUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!pathOrUrl.startsWith('/')) return null;
  return `${publicOrigin()}${pathOrUrl}`;
}

/**
 * An avatar is only usable as an og:image if it is one of our stored images.
 *
 * Avatars may also be data: URLs (see the Image model's note on why bytes live
 * in the database), and a data: URL in og:image is fetched by nobody — every
 * unfurler wants an address it can GET. Better no image than a broken one.
 */
export function ogImageFrom(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  return absoluteUrl(raw);
}

function tag(name: string, content: string | null | undefined): string {
  if (!content) return '';
  return `<meta name="${name}" content="${escapeHtml(content)}">`;
}

function og(property: string, content: string | null | undefined): string {
  if (!content) return '';
  return `<meta property="${property}" content="${escapeHtml(content)}">`;
}

function truncate(text: string, max: number): string {
  const flat = collapseWhitespace(text);
  if (flat.length <= max) return flat;
  // Cut on a word boundary so the tail is not a severed word — same rule
  // excerptOf uses, for the same reason.
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The whole injected <head> fragment for a page.
 *
 * Order is not arbitrary: <title> comes first because it is what a human sees in
 * a tab, canonical before the og: block because that is the one a deduplicating
 * crawler acts on first, and the JSON-LD last because it is the longest and the
 * least interesting to read when debugging a response by eye.
 */
export function renderHead(page: SeoPage): string {
  const description = page.description ? truncate(page.description, MAX_DESCRIPTION) : '';
  const image = absoluteUrl(page.image);
  const title = `${page.title} · ${SITE_NAME}`;

  const parts = [
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(page.canonical)}">`,
    tag('description', description),
    page.robots ? tag('robots', page.robots) : '',

    og('og:type', page.ogType ?? 'website'),
    og('og:site_name', SITE_NAME),
    og('og:title', title),
    og('og:description', description),
    og('og:url', page.canonical),
    og('og:image', image),

    // summary_large_image only renders large if there *is* an image; without one
    // it degrades to the small card, which is what we want anyway.
    tag('twitter:card', image ? 'summary_large_image' : 'summary'),
    tag('twitter:title', title),
    tag('twitter:description', description),
    tag('twitter:image', image),

    page.publishedTime ? og('article:published_time', page.publishedTime.toISOString()) : '',
    page.modifiedTime ? og('article:modified_time', page.modifiedTime.toISOString()) : '',
    page.authorName ? og('article:author', page.authorName) : '',

    ...(page.feeds ?? []).map(f =>
      `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(f.title)}" href="${escapeHtml(f.href)}">`),

    page.jsonLd ? jsonLdScript(page.jsonLd) : '',
  ];

  return parts.filter(Boolean).join('\n    ');
}

/**
 * The crawlable copy of the page's content, for the <body> marker.
 *
 * Wrapped in <noscript> on purpose, and the choice is worth stating because the
 * obvious alternative is worse. Rendering into <div id="root"> would put the
 * text in front of every crawler *and* every human — but React clears that
 * container when it mounts and only fills it once its fetch returns, so a real
 * visitor would watch the article appear, vanish, and come back. <noscript> is
 * read as ordinary content by exactly the agents that need it (a parser that
 * does not run scripts — Bing, Slack, every unfurler) and skipped by the one
 * that does not (Google, which renders the React page and sees the same content
 * that way). Nobody sees a flash.
 *
 * `html` is expected to be sanitizer output. It is passed through
 * safeInNoscript regardless, because "expected to be" is not a guarantee.
 */
export function renderNoscript(html: string): string {
  return `<noscript>\n${safeInNoscript(html)}\n</noscript>`;
}
