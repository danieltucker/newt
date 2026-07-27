// ── Note embeds ───────────────────────────────────────────────────────
// A reference dropped into a note by /reference. The stored form is plain
// markup living in the note's HTML - no hydration step, no registry: a note
// written today still renders years from now off its own attributes.
//
// Everything the card shows is carried on the wrapper as data-*, so switching
// between the three sizes is a re-render from the same data rather than a
// lossy transform. That is also what makes this reusable: a tweet or an
// external link is another `kind` with another body renderer, and the wrapper,
// the sizes, the picker and the editor plumbing stay exactly as they are.
//
// The markup is inline-only (span / a / img). An embed usually sits inside a
// <p>, and a block element there would be split back out by the HTML parser
// the next time the note is loaded - the sizes come from CSS display instead.

import { ReadingListItem } from '../types';
import { articlePathFor } from './articleUrl';

// Stable, non-hashed classes: they are baked into saved note HTML, so a
// CSS-module hash could change and orphan every embed already written.
export const EMBED_CLASS = 'note-embed';

export type EmbedKind = 'article';
export type EmbedVariant = 'link' | 'small' | 'large';

export const VARIANTS: EmbedVariant[] = ['link', 'small', 'large'];

export interface EmbedData {
  kind: EmbedKind;
  /** Where selecting the embed goes - for an article, its Newt page. */
  href: string;
  /** The source the reference points at, shown as provenance. */
  url: string;
  title: string;
  /** Host or publication, and what the favicon is looked up by. */
  source: string;
  image?: string;
  /** One extra line the kind wants to show (read time, date, author). */
  meta?: string;
}

// What the large card calls itself, so a wall of embeds still says what each
// one is. Keyed by kind - the only place a new kind has to be named.
const KIND_LABEL: Record<EmbedKind, string> = {
  article: 'Saved article',
};

const DEFAULT_VARIANT: EmbedVariant = 'small';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Attribute values reach an <img src> and an <a href>, so anything that could
// carry script is dropped rather than rewritten. Everything we generate
// ourselves (the /a/ path, the favicon service) passes; a hostile reading-list
// row cannot smuggle a scheme through.
function safeUrl(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  if (/^(https?:)?\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s;
  return '';
}

export function faviconFor(source: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(source)}&sz=64`;
}

/** A reading-list row as something /reference can offer and embed. */
export function articleEmbed(item: ReadingListItem): EmbedData {
  return {
    kind: 'article',
    href: articlePathFor(item.url),
    url: item.url,
    title: item.title?.trim() || item.url,
    source: item.source ?? '',
    image: item.imageUrl || undefined,
    meta: item.readTime || undefined,
  };
}

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeHtml(value)}"` : '';
}

function favicon(source: string): string {
  return source ? `<img class="note-embed-fav" src="${escapeHtml(faviconFor(source))}" alt="">` : '';
}

function metaLine(data: EmbedData): string {
  const text = [data.source, data.meta].filter(Boolean).join(' · ');
  if (!text) return '';
  return `<span class="note-embed-meta">${favicon(data.source)}${escapeHtml(text)}</span>`;
}

// The inside of the anchor, per size. The wrapper, the anchor and the data are
// identical across all three - only this changes.
function innerHtml(data: EmbedData, variant: EmbedVariant): string {
  const title = `<span class="note-embed-title">${escapeHtml(data.title)}</span>`;
  const image = safeUrl(data.image);

  if (variant === 'link') {
    return `${favicon(data.source)}${title}`;
  }

  if (variant === 'large') {
    const cover = image
      ? `<img class="note-embed-cover" src="${escapeHtml(image)}" alt="" loading="lazy">`
      : '';
    return cover +
      '<span class="note-embed-body">' +
        `<span class="note-embed-kicker">${escapeHtml(KIND_LABEL[data.kind])}</span>` +
        title +
        metaLine(data) +
        // Deliberately empty: the count is live, and is written in as
        // data-comments by applyCommentCounts. Storing a number here would bake
        // in whatever it happened to be the day the embed was made.
        '<span class="note-embed-comments"></span>' +
      '</span>';
  }

  const thumb = image
    ? `<img class="note-embed-thumb" src="${escapeHtml(image)}" alt="" loading="lazy">`
    : '';
  return thumb +
    '<span class="note-embed-body">' + title + metaLine(data) + '</span>';
}

/** The stored markup for an embed, ready for insertion into a note. */
export function buildEmbedHtml(data: EmbedData, variant: EmbedVariant = DEFAULT_VARIANT): string {
  const href = safeUrl(data.href);
  return (
    `<span class="${EMBED_CLASS}"` +
    ` data-embed="${escapeHtml(data.kind)}"` +
    ` data-variant="${escapeHtml(variant)}"` +
    attr('data-href', href) +
    attr('data-url', data.url) +
    attr('data-title', data.title) +
    attr('data-source', data.source) +
    attr('data-image', safeUrl(data.image)) +
    attr('data-meta', data.meta) +
    ' contenteditable="false">' +
      `<a class="note-embed-a" href="${escapeHtml(href || '#')}" target="_blank" rel="noopener noreferrer">` +
        innerHtml(data, variant) +
      '</a>' +
    '</span>'
  );
}

/** The same, as a detached element - for swapping one embed's size in place. */
export function createEmbed(data: EmbedData, variant: EmbedVariant): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = buildEmbedHtml(data, variant);
  return t.content.firstElementChild as HTMLElement;
}

function isKind(v: string): v is EmbedKind {
  return v === 'article';
}

export function isVariant(v: string): v is EmbedVariant {
  return (VARIANTS as string[]).includes(v);
}

/** Recover the data an embed was built from. Null if `el` isn't one of ours. */
export function readEmbed(el: Element | null): EmbedData | null {
  if (!el || !el.classList.contains(EMBED_CLASS)) return null;
  const kind = el.getAttribute('data-embed') ?? '';
  if (!isKind(kind)) return null;
  return {
    kind,
    href: el.getAttribute('data-href') ?? '',
    url: el.getAttribute('data-url') ?? '',
    title: el.getAttribute('data-title') ?? '',
    source: el.getAttribute('data-source') ?? '',
    image: el.getAttribute('data-image') || undefined,
    meta: el.getAttribute('data-meta') || undefined,
  };
}

/** The size an embed is currently rendered at. */
export function variantOf(el: Element): EmbedVariant {
  const v = el.getAttribute('data-variant') ?? '';
  return isVariant(v) ? v : DEFAULT_VARIANT;
}

/** The embed containing `node`, if it lies inside one within `root`. */
export function embedAt(node: Node | null, root: HTMLElement): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const embed = el?.closest(`.${EMBED_CLASS}`) as HTMLElement | null;
  return embed && root.contains(embed) ? embed : null;
}

// ── Live comment counts ───────────────────────────────────────────────
// The large card says how much conversation an article has drawn. That number
// is the one thing about an embed that cannot live in the stored markup: it
// changes after the embed is written, so a saved copy would be wrong within a
// day. It travels as `data-comments` on an otherwise-empty slot, written by
// whoever renders the embed and stripped again on the way in - the server's
// allowlist does not carry it either, so it can never be persisted.

const COMMENTS_ATTR = 'data-comments';

export function commentLabel(n: number): string {
  if (n <= 0) return 'No comments yet';
  return `${n} comment${n === 1 ? '' : 's'}`;
}

/** Write live counts into every article embed under `root`, keyed by source URL. */
export function applyCommentCounts(root: ParentNode, counts: Record<string, number>): void {
  root.querySelectorAll(`.${EMBED_CLASS}[data-embed="article"]`).forEach(el => {
    const slot = el.querySelector('.note-embed-comments');
    if (!slot) return;
    const n = counts[el.getAttribute('data-url') ?? ''];
    // An unknown count leaves the slot resting on its CSS default rather than
    // asserting zero - "no comments yet" and "not asked yet" are different.
    if (n === undefined) slot.removeAttribute(COMMENTS_ATTR);
    else slot.setAttribute(COMMENTS_ATTR, commentLabel(n));
  });
}

/** The article URLs embedded under `root`, for one batched counts request. */
export function embedUrlsIn(root: ParentNode): string[] {
  const urls = new Set<string>();
  root.querySelectorAll(`.${EMBED_CLASS}[data-embed="article"]`).forEach(el => {
    const url = el.getAttribute('data-url');
    if (url && /^https?:\/\//i.test(url)) urls.add(url);
  });
  return [...urls];
}

/** The same, from stored HTML that isn't mounted anywhere. */
export function embeddedUrls(html: string): string[] {
  if (!html || !html.includes(EMBED_CLASS)) return [];
  return embedUrlsIn(new DOMParser().parseFromString(html, 'text/html'));
}

/**
 * Put loaded embeds back into the shape the editor needs.
 *
 * Blog bodies come back from the server sanitizer without `contenteditable`
 * (deliberately - see RICH_HTML_OPTIONS), which would leave the caret free to
 * wander into a card and edit text that its data-* no longer matches. Any live
 * count that made it into storage is dropped here too, so a stale number is
 * never the first thing on screen.
 */
export function hydrateEmbeds(root: ParentNode): void {
  root.querySelectorAll(`.${EMBED_CLASS}`).forEach(el => {
    el.setAttribute('contenteditable', 'false');
    el.querySelector(`[${COMMENTS_ATTR}]`)?.removeAttribute(COMMENTS_ATTR);
  });
}

/** Free-text match over everything an embed shows, for the /reference picker. */
export function embedMatches(data: EmbedData, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [data.title, data.source, data.url, data.meta]
    .some(f => (f ?? '').toLowerCase().includes(q));
}
