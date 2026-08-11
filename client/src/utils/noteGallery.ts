// ── Note galleries ────────────────────────────────────────────────────
// A stack of images dropped into a note, post or comment: a fan of cards, the
// top one face on and the ones behind it peeking out at an angle. Clicking any
// card opens the lightbox on that image and you page through the set from there.
//
// Built the same way a reference embed is (see noteEmbed.ts), and for the same
// reasons:
//
//  - The stored form is plain markup living in the document's HTML. There is no
//    registry and no hydration step that has to find the pictures again: a note
//    written today still renders years from now off its own attributes.
//  - The markup is inline-only (span / img). A gallery usually sits inside a
//    <p>, and a block element there would be split back out by the HTML parser
//    the next time the note is loaded - so the fan comes from CSS, not markup.
//  - The wrapper is contenteditable="false", making it an atomic island: the
//    caret cannot wander inside and edit half a photo stack.
//
// Every image in the set is written out, not just the three the fan shows. The
// rest are hidden by CSS (nth-child(n+4)) rather than dropped, because they are
// the gallery's content - the lightbox pages through all of them, and a set that
// only stored what was visible could not.

export const GALLERY_CLASS = 'note-gallery';
export const GALLERY_STACK_CLASS = 'note-gallery-stack';
export const GALLERY_CARD_CLASS = 'note-gallery-card';
export const GALLERY_MORE_CLASS = 'note-gallery-more';

/** How many cards the fan shows. The rest are stored but not drawn. */
export const GALLERY_FAN = 3;

/** More than this in one gallery and the markup starts to weigh on a document. */
export const MAX_GALLERY_IMAGES = 24;

export interface GalleryImage {
  src: string;
  alt?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Same rule the embeds use: an attribute value that reaches an <img src> is
// dropped rather than rewritten if it could carry script. Our own uploads are
// site-relative (/api/v1/images/<id>) and pass; so does a plain https URL.
function safeUrl(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  if (/^(https?:)?\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s;
  return '';
}

/** Drop anything we would refuse to render, and cap the set. */
export function cleanGalleryImages(images: GalleryImage[]): GalleryImage[] {
  return images
    .map(img => ({ src: safeUrl(img.src), alt: img.alt ?? '' }))
    .filter(img => !!img.src)
    .slice(0, MAX_GALLERY_IMAGES);
}

/**
 * The stored markup for a gallery, ready for insertion.
 *
 * The "+N" badge is written out as text rather than derived at render time.
 * Unlike an embed's comment count it is a fact about the stored content, not
 * about the world, so it cannot go stale while the markup it describes is
 * unchanged - and every edit rebuilds the gallery anyway.
 */
export function buildGalleryHtml(images: GalleryImage[]): string {
  const set = cleanGalleryImages(images);
  if (set.length === 0) return '';

  const cards = set.map(img =>
    `<img class="${GALLERY_CARD_CLASS}" src="${escapeHtml(img.src)}"` +
    ` alt="${escapeHtml(img.alt ?? '')}" loading="lazy">`,
  ).join('');

  const hidden = set.length - GALLERY_FAN;
  const badge = hidden > 0
    ? `<span class="${GALLERY_MORE_CLASS}">+${hidden}</span>`
    : '';

  return (
    `<span class="${GALLERY_CLASS}" data-gallery="${set.length}" contenteditable="false">` +
      `<span class="${GALLERY_STACK_CLASS}">${cards}</span>` +
      badge +
    '</span>'
  );
}

/** The same, as a detached element - for rebuilding a gallery in place. */
export function createGallery(images: GalleryImage[]): HTMLElement | null {
  const html = buildGalleryHtml(images);
  if (!html) return null;
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
}

/** True if `el` is a gallery wrapper. */
export function isGallery(el: Element | null): el is HTMLElement {
  return !!el && el.classList.contains(GALLERY_CLASS);
}

/**
 * The images a gallery holds, read back off its cards.
 *
 * The cards *are* the storage - there is no parallel data-* copy to drift from
 * them - so adding or removing one is an ordinary DOM edit and this keeps
 * reporting the truth without anything having to be kept in step.
 */
export function galleryImages(el: Element | null): GalleryImage[] {
  if (!isGallery(el)) return [];
  return Array.from(el.querySelectorAll(`img.${GALLERY_CARD_CLASS}`)).map(img => ({
    src: img.getAttribute('src') ?? '',
    alt: img.getAttribute('alt') ?? '',
  })).filter(img => !!img.src);
}

/** The gallery containing `node`, if it lies inside one within `root`. */
export function galleryAt(node: Node | null, root: ParentNode): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const gallery = el?.closest(`.${GALLERY_CLASS}`) as HTMLElement | null;
  if (!gallery) return null;
  // `root` may be a document fragment or a document, neither of which is an
  // HTMLElement - contains() is on Node, so this works for all of them.
  return (root as Node).contains(gallery) ? gallery : null;
}

/** Which card in its gallery a click landed on. 0 when it landed elsewhere. */
export function galleryIndexOf(gallery: HTMLElement, target: Node | null): number {
  const el = target && target.nodeType === Node.ELEMENT_NODE
    ? (target as HTMLElement)
    : target?.parentElement ?? null;
  const card = el?.closest(`img.${GALLERY_CARD_CLASS}`);
  if (!card) return 0;
  const cards = Array.from(gallery.querySelectorAll(`img.${GALLERY_CARD_CLASS}`));
  return Math.max(0, cards.indexOf(card as HTMLImageElement));
}

/**
 * Put loaded galleries back into the shape the editor needs.
 *
 * Blog and comment bodies come back from the server sanitizer without
 * `contenteditable` (deliberately - see RICH_HTML_OPTIONS), which would leave
 * the caret free to wander into the stack and type between two photographs.
 * The same fix hydrateEmbeds applies, for the same reason.
 */
export function hydrateGalleries(root: ParentNode): void {
  root.querySelectorAll(`.${GALLERY_CLASS}`).forEach(el => {
    el.setAttribute('contenteditable', 'false');
  });
}
