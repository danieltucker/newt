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

import { articlePathFor } from './articleUrl';
import { blogPathFor } from './blogUrl';

// Stable, non-hashed classes: they are baked into saved note HTML, so a
// CSS-module hash could change and orphan every embed already written.
export const EMBED_CLASS = 'note-embed';

// 'page' is any URL the writer pasted into the link dialog and asked to render
// as a card, rather than something already in their library. Its title and
// artwork come from the page itself (see utils/pageMeta), so it is the one kind
// whose data is not already on hand when the embed is built.
export type EmbedKind = 'article' | 'post' | 'page';
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
  /**
   * A sentence or two about the target, shown on the large card only. This is
   * what makes that size worth its space: without it a large card was a small
   * card with a bigger picture, which is no reason to give up a screenful of a
   * post. Absent is normal - a saved article carries no summary - and the line
   * is simply omitted.
   */
  description?: string;
}

// What the large card calls itself, so a wall of embeds still says what each
// one is. Keyed by kind - the only place a new kind has to be named.
//
// No entry for 'page': a card headed LINK above a title and a hostname is
// telling the reader something they can already see. The kinds that get a
// kicker are the ones where it says something the card doesn't - that this came
// out of your library, or that it was written here.
const KIND_LABEL: Partial<Record<EmbedKind, string>> = {
  article: 'Saved article',
  post: 'Blog post',
};

const DEFAULT_VARIANT: EmbedVariant = 'small';

// Every thread in the app is keyed on a canonical URL, and every embed carries
// one - so any embed *may* have a conversation, including a link someone pasted
// off the open web. Somebody else saving that article and talking about it is
// exactly how a pasted URL acquires a thread, and the card had no way to say so.
//
// What this list marks is the stronger claim: kinds whose target has a thread
// whether or not anyone has posted in it yet, because it is a page of ours with
// a comment box on it. Those cards rest on a "Comments" invitation. Everything
// else stays silent until a count actually comes back - see the CSS, which hides
// the row until it has something to report, so a card never promises a
// conversation that doesn't exist.
const THREADED_KINDS: EmbedKind[] = ['article', 'post'];

export function hasThread(kind: EmbedKind): boolean {
  return THREADED_KINDS.includes(kind);
}

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

/**
 * Everything an embed needs from an article, which is a subset of what a
 * reading-list row carries - so a ReadingListItem satisfies this as it stands,
 * and so does the looser set of fields the reader happens to know about the
 * article currently open in it.
 */
export interface ArticleRef {
  url: string;
  title?: string | null;
  source?: string | null;
  imageUrl?: string | null;
  readTime?: string | null;
}

/** An article - a saved one, or the one being read - as something to cite. */
export function articleEmbed(item: ArticleRef): EmbedData {
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

/** The same, for a blog post written on this instance. */
export interface PostRef {
  /** Absolute canonical URL - also the key its comment thread hangs on. */
  url: string;
  title: string;
  slug: string;
  heroImage?: string | null;
  publishedAt?: string | null;
  author?: { username: string; displayName: string } | null;
  /** The post's own summary - what its large card says about it. */
  excerpt?: string | null;
}

/**
 * A post as something to cite. Unlike an article it is hosted here, so the card
 * points straight at its page rather than at a reader for it; `url` still holds
 * the canonical form, which is what the live comment count is keyed on.
 */
export function postEmbed(post: PostRef): EmbedData {
  return {
    kind: 'post',
    href: post.author ? blogPathFor(post.author.username, post.slug) : post.url,
    url: post.url,
    title: post.title?.trim() || post.url,
    // The author stands where a publication would: a post's provenance is the
    // person who wrote it, not the host every post here shares.
    source: post.author?.displayName ?? '',
    image: post.heroImage || undefined,
    meta: shortDate(post.publishedAt) || undefined,
    description: post.excerpt?.trim() || undefined,
  };
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? '' : d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeHtml(value)}"` : '';
}

// A favicon identifies a *publication*, which is what an article's source is -
// and a pasted link's, whose source is its hostname. A post's source is a
// person's name, so there is no domain to look one up by; asking anyway would
// fetch a broken image on every card. The gate is therefore "does this kind's
// source name a domain", not "is this an article" - which is what it used to
// say, and why a link card carried a bare hostname with a gap where every other
// card had an icon.
const DOMAIN_SOURCE_KINDS: EmbedKind[] = ['article', 'page'];

function favicon(data: EmbedData): string {
  if (!DOMAIN_SOURCE_KINDS.includes(data.kind) || !data.source) return '';
  return `<img class="note-embed-fav" src="${escapeHtml(faviconFor(data.source))}" alt="">`;
}

function metaLine(data: EmbedData): string {
  const text = [data.source, data.meta].filter(Boolean).join(' · ');
  if (!text) return '';
  return `<span class="note-embed-meta">${favicon(data)}${escapeHtml(text)}</span>`;
}

// The inside of the anchor, per size. The wrapper, the anchor and the data are
// identical across all three - only this changes.
function innerHtml(data: EmbedData, variant: EmbedVariant): string {
  const title = `<span class="note-embed-title">${escapeHtml(data.title)}</span>`;
  const image = safeUrl(data.image);

  if (variant === 'link') {
    return `${favicon(data)}${title}`;
  }

  if (variant === 'large') {
    const cover = image
      ? `<img class="note-embed-cover" src="${escapeHtml(image)}" alt="" loading="lazy">`
      : '';
    const kind = KIND_LABEL[data.kind];
    const kicker = kind ? `<span class="note-embed-kicker">${escapeHtml(kind)}</span>` : '';
    // The one thing this size has that the small card doesn't - the reader gets
    // to decide whether to follow the link without following it first.
    const desc = data.description
      ? `<span class="note-embed-desc">${escapeHtml(data.description)}</span>`
      : '';
    return cover +
      '<span class="note-embed-body">' +
        kicker +
        title +
        desc +
        metaLine(data) +
      '</span>';
  }

  const thumb = image
    ? `<img class="note-embed-thumb" src="${escapeHtml(image)}" alt="" loading="lazy">`
    : '';
  return thumb +
    '<span class="note-embed-body">' + title + metaLine(data) + '</span>';
}

/**
 * Where the comments row goes.
 *
 * An article's card already points at its Newt page and a post's at the post
 * itself; both of those carry the thread, so the row leads where the card does.
 * A pasted link points off-site - following it would take you to the source,
 * not to the conversation - so its row goes to the reader for that URL, which
 * is the page the thread actually lives on. `/a/<id>` needs no server-side
 * mapping, so this works for any URL, saved or not (see utils/articleUrl).
 */
function commentsHref(data: EmbedData): string {
  return data.kind === 'page' ? articlePathFor(data.url) : data.href;
}

/**
 * The comments row: a link of its own, so it can lead somewhere the card
 * doesn't. It is a *sibling* of the card's anchor rather than a child, because
 * an anchor inside an anchor is not markup a browser will keep - which is why
 * this used to be an inert span that only reported a number. The card's box is
 * drawn on the wrapper for the same reason: it has to enclose both.
 *
 * Deliberately empty of text: the count is live and is written in as
 * data-comments by applyCommentCounts. Storing a number would bake in whatever
 * it happened to be the day the embed was written.
 */
function commentsRow(data: EmbedData, variant: EmbedVariant): string {
  if (variant === 'link') return '';
  // Only a real web address has a thread to reach. Anything else - a relative
  // href, a blank - would build a link to a reader that cannot decode it.
  if (!/^https?:\/\//i.test(data.url)) return '';
  const href = safeUrl(commentsHref(data));
  if (!href) return '';
  return `<a class="note-embed-comments" href="${escapeHtml(href)}"></a>`;
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
    attr('data-description', data.description) +
    ' contenteditable="false">' +
      `<a class="note-embed-a" href="${escapeHtml(href || '#')}" target="_blank" rel="noopener noreferrer">` +
        innerHtml(data, variant) +
      '</a>' +
      commentsRow(data, variant) +
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
  return v === 'article' || v === 'post' || v === 'page';
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
    description: el.getAttribute('data-description') || undefined,
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
// A card says how much conversation its target has drawn. That number is the
// one thing about an embed that cannot live in the stored markup: it changes
// after the embed is written, so a saved copy would be wrong within a day. It
// travels as `data-comments` on an otherwise-empty row, written by whoever
// renders the embed and stripped again on the way in - the server's allowlist
// does not carry it either, so it can never be persisted.

const COMMENTS_ATTR = 'data-comments';

const ANY_EMBED = `.${EMBED_CLASS}`;

export function commentLabel(n: number): string {
  if (n <= 0) return 'No comments yet';
  return `${n} comment${n === 1 ? '' : 's'}`;
}

/** Write live counts into every embed under `root`, keyed by source URL. */
export function applyCommentCounts(root: ParentNode, counts: Record<string, number>): void {
  root.querySelectorAll(ANY_EMBED).forEach(el => {
    const row = el.querySelector('.note-embed-comments');
    if (!row) return;
    const kind = el.getAttribute('data-embed') ?? '';
    const n = counts[el.getAttribute('data-url') ?? ''];
    // Two ways to have nothing to say, and both leave the row resting on its
    // CSS default rather than asserting anything:
    //  - the count is unknown, because nobody has asked yet. "No comments yet"
    //    and "not asked yet" are different claims.
    //  - the count is zero on a kind with no comment box of its own. An article
    //    with no replies is still somewhere you can go and reply; an arbitrary
    //    link with none is just a link, and its row stays hidden.
    const silent = n === undefined || (n === 0 && (!isKind(kind) || !hasThread(kind)));
    if (silent) row.removeAttribute(COMMENTS_ATTR);
    else row.setAttribute(COMMENTS_ATTR, commentLabel(n));
  });
}

/**
 * The URLs embedded under `root`, for one batched counts request.
 *
 * Every embed, not only the kinds that are certain to have a thread: a pasted
 * link is the case worth asking about, since the way it acquires a conversation
 * is somebody else saving that same article and talking about it. Asking is one
 * URL added to a request that is already being made.
 */
export function embedUrlsIn(root: ParentNode): string[] {
  const urls = new Set<string>();
  root.querySelectorAll(ANY_EMBED).forEach(el => {
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
