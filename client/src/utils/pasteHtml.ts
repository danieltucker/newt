// HTML on the clipboard, rewritten into the editor's own vocabulary.
//
// ── Why this exists ──
// Until now a paste carrying `text/html` was handed straight to the browser:
// handlePaste looked for images, looked for a bare URL, looked for markdown, and
// otherwise let contentEditable do whatever it does. What contentEditable does
// is insert the source's markup nearly verbatim — a Google Docs paste arrives
// wrapped in `<b style="font-weight:normal">`, a web page arrives as nested
// `<div>`s and `<section>`s carrying their own stylesheet's class names, and
// Word arrives with `<o:p>` and a kilobyte of conditional comments.
//
// The visible result was a document that looked one way in the editor, a second
// way after a reload, and a third way once the server's sanitizer had been over
// it — headings where there were none, everything bold, whole paragraphs that
// were really a `<div>` and so could not be turned into anything else.
//
// ── The rule this file follows ──
// **Paste what a save would keep, and nothing else.** The allowlist below is the
// client-side twin of RICH_HTML_OPTIONS in server/src/lib/comments.ts, which is
// the thing that actually decides what survives being written down. Sanitizing
// on the way *in* rather than only on the way out is what makes the editor
// honest: what you see the moment you paste is what the post will be.
//
// A divergence between the two lists is a bug, and the direction that matters is
// this one being *wider* — anything permitted here and refused there is markup
// the writer can see and then lose. Narrower is merely conservative.
//
// ── What it is not ──
// Not a security boundary. The server sanitizes every body on write and that is
// where the guarantee lives; this runs in the author's own browser on their own
// clipboard. It is a fidelity tool, and it is written as one.

import { EMBED_CLASS } from './noteEmbed';
import { GALLERY_CLASS } from './noteGallery';
import { COLOR_CLASSES } from './noteFormat';

// Duplicated from RichEditor for the reason markdown.ts duplicates them: they
// are part of the saved document format rather than of the component.
const TODO_CLASS = 'note-todo';
const TABLE_CLASS = 'note-table';

/** Blocks the editor writes for itself, and so the only blocks a paste may become. */
const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);

/** Inline marks that survive. `SPAN` is here but only keeps its place if it is one of ours — see keepClasses. */
const INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'CODE', 'A', 'SPAN', 'BR', 'IMG']);

/**
 * Dropped with their contents, rather than unwrapped.
 *
 * The distinction matters: unwrapping a `<style>` leaves its CSS behind as
 * visible text in the post, which is the failure people notice when they paste
 * from a page that inlines its stylesheet. Everything here has contents that are
 * not prose.
 */
const DROP_WHOLE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'OPTION', 'TEXTAREA', 'HEAD', 'META', 'LINK', 'TITLE', 'AUDIO', 'VIDEO', 'MAP', 'AREA', 'TEMPLATE']);

/** A deeper heading is still a heading. The same flattening markdownToHtml does. */
const HEADING_DOWN: Record<string, string> = { H4: 'H3', H5: 'H3', H6: 'H3' };

/** Attributes kept, by tag. Everything absent from this map goes, `style` above all. */
const KEEP_ATTRS: Record<string, Set<string>> = {
  A: new Set(['href']),
  IMG: new Set(['src', 'alt', 'width', 'height']),
};

/**
 * Classes a pasted element may keep.
 *
 * Only the app's own structural classes, never a wildcard — a class from
 * somebody else's stylesheet means nothing here, and a class from *ours* that
 * the paste did not earn (note-todo on a random div) is markup pretending to be
 * a feature. The list is the same one the server's allowedClasses map holds.
 */
const KEEP_CLASSES = new Set<string>([
  EMBED_CLASS, 'note-embed-body', 'note-embed-title', 'note-embed-meta',
  'note-embed-kicker', 'note-embed-comments', 'note-embed-desc',
  'note-embed-a', 'note-embed-thumb', 'note-embed-cover', 'note-embed-fav',
  GALLERY_CLASS, 'note-gallery-stack', 'note-gallery-more', 'note-gallery-card',
  TODO_CLASS, TABLE_CLASS,
  ...COLOR_CLASSES,
]);

/** The embed data-* the server keeps, and so the ones a Newt-to-Newt paste may carry. */
const KEEP_DATA = new Set([
  'data-embed', 'data-variant', 'data-href', 'data-url', 'data-title',
  'data-source', 'data-image', 'data-meta', 'data-description',
  'data-gallery', 'data-checked',
]);

/** Only real web links. Mirrors safeHref in markdown.ts and the server's allowedSchemes. */
function safeUrl(raw: string | null, imageOnly = false): string | null {
  const href = (raw ?? '').trim();
  if (!href) return null;
  if (/^https?:/i.test(href)) return href;
  if (!imageOnly && /^mailto:/i.test(href)) return href;
  // Site-relative — our own /api/v1/images/<id> uploads, and the /a/ and /u/
  // paths a Newt-to-Newt paste carries.
  if (/^\//.test(href) && !/^\/\//.test(href)) return href;
  return null;
}

// ── Inline style, read once and then thrown away ─────────────────────────────
//
// `style` never survives: it is refused outright by the server, and an author
// restyling a reader's page is not a thing a paste gets to do. But throwing it
// away silently loses the formatting it was *expressing* — and for the two
// editors people paste from most, that is where the formatting lives. Word and
// Google Docs both emit bold as `style="font-weight:700"` on a span rather than
// as a `<b>`.
//
// So each style is read for the marks it implies, those marks are written as
// real elements, and the attribute goes. Everything else in it — colour, font,
// margins, the whole of somebody else's design — is dropped.
//
// The `font-weight:normal` case is the one worth naming: Google Docs wraps an
// entire copied selection in `<b style="font-weight:normal">`, and a sanitizer
// that drops the attribute and keeps the tag turns every paste from Docs
// entirely bold. That is the single most common "my paste came out wrong".
interface Marks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Set when the style explicitly cancels a mark its tag would otherwise imply. */
  unbold: boolean;
}

function marksFromStyle(style: string): Marks {
  const s = style.toLowerCase();
  const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(s)?.[1];
  const numeric = weight && /^\d+$/.test(weight) ? Number(weight) : null;
  const decoration = /text-decoration[a-z-]*\s*:\s*([^;]+)/.exec(s)?.[1] ?? '';
  return {
    bold: weight === 'bold' || weight === 'bolder' || (numeric !== null && numeric >= 600),
    italic: /font-style\s*:\s*italic/.test(s),
    underline: /\bunderline\b/.test(decoration),
    strike: /\bline-through\b/.test(decoration),
    unbold: weight === 'normal' || weight === 'lighter' || (numeric !== null && numeric < 600),
  };
}

/** Wrap a node in the mark elements a style asked for, innermost first. */
function wrapInMarks(node: Node, marks: Marks): Node {
  let out = node;
  for (const [on, tag] of [[marks.strike, 's'], [marks.underline, 'u'], [marks.italic, 'i'], [marks.bold, 'b']] as const) {
    if (!on) continue;
    const el = document.createElement(tag);
    el.appendChild(out);
    out = el;
  }
  return out;
}

/**
 * Whether this element is one of ours, arriving whole.
 *
 * A Newt-to-Newt paste — copying an embed or a gallery out of one post and into
 * another — carries markup this file would otherwise take apart, because an
 * embed is a `<span>` full of `<span>`s and a gallery is a span full of images.
 * Recognised by class, and then walked with the same allowlist as everything
 * else rather than trusted: the classes and the data-* survive, and anything
 * that is not on the list still does not.
 */
function isOwnMarkup(el: Element): boolean {
  return el.classList.contains(EMBED_CLASS) || el.classList.contains(GALLERY_CLASS);
}

/** Strip an element back to the attributes it is allowed to keep. */
function cleanAttrs(el: Element): void {
  const keep = KEEP_ATTRS[el.nodeName] ?? new Set<string>();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (keep.has(name)) continue;
    if (name === 'class') {
      const kept = Array.from(el.classList).filter(c => KEEP_CLASSES.has(c));
      if (kept.length) el.className = kept.join(' ');
      else el.removeAttribute('class');
      continue;
    }
    if (KEEP_DATA.has(name)) continue;
    el.removeAttribute(attr.name);
  }
  // Scheme checks last, so an attribute that survived the list above still has
  // to be a URL we would follow.
  if (el.nodeName === 'A') {
    const href = safeUrl(el.getAttribute('href'));
    if (href) el.setAttribute('href', href); else el.removeAttribute('href');
  }
  if (el.nodeName === 'IMG') {
    const src = safeUrl(el.getAttribute('src'), true);
    // Only cleaned here; an image with nowhere to load from is dropped by the
    // caller, which is the one that holds it. Removing it from here would be a
    // no-op — at this point it has not been given a parent yet.
    if (src) el.setAttribute('src', src); else el.removeAttribute('src');
  }
  for (const name of ['data-href', 'data-image']) {
    if (!el.hasAttribute(name)) continue;
    const url = safeUrl(el.getAttribute(name));
    if (url) el.setAttribute(name, url); else el.removeAttribute(name);
  }
}

/**
 * One node, cleaned, as the list of nodes that should stand in its place.
 *
 * A list rather than a node because the two interesting cases both produce
 * something other than one-for-one: a dropped element contributes nothing, and
 * an unwrapped one contributes its children.
 */
function clean(node: Node, inherited: Marks | null): Node[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? '';
    if (!text) return [];
    const fresh = document.createTextNode(text);
    return [inherited ? wrapInMarks(fresh, inherited) : fresh];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];   // comments, MSO conditionals

  const el = node as Element;
  if (DROP_WHOLE.has(el.nodeName)) return [];

  const style = el.getAttribute('style') ?? '';
  const marks = style ? marksFromStyle(style) : null;

  // Ours, and kept whole — with its own attributes filtered, and its children
  // left alone so an embed's structure survives the trip intact.
  if (isOwnMarkup(el)) {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('*').forEach(cleanAttrs);
    cleanAttrs(copy);
    // The editor stamps contenteditable back on at hydration; a stored embed
    // never carries it, and neither should a pasted one.
    copy.removeAttribute('contenteditable');
    return [copy];
  }

  const children: Node[] = [];
  // A style's marks flow down to the text inside it, since the element carrying
  // them is usually a span that is about to be unwrapped.
  const pass = marks && (marks.bold || marks.italic || marks.underline || marks.strike) ? marks : inherited;
  for (const child of Array.from(el.childNodes)) children.push(...clean(child, pass));

  const mapped = HEADING_DOWN[el.nodeName];
  const name = mapped ?? el.nodeName;

  // `<b style="font-weight:normal">` and friends: the tag says one thing, the
  // style says the opposite, and the style is the one the source meant.
  if ((name === 'B' || name === 'STRONG') && marks?.unbold) return children;

  // A checklist item is the one <div> the editor writes, and it carries its
  // ticked state in an attribute — unwrap it and the to-do becomes a paragraph
  // that has forgotten it was ever ticked. Everything else spelled as a div is
  // somebody's page furniture.
  const isTodoDiv = el.nodeName === 'DIV' && el.classList.contains(TODO_CLASS);

  if (!isTodoDiv && !BLOCKS.has(name) && !INLINE.has(name)) return children;   // unwrapped: div, section, font, mark…
  // A span earns its place only by being one of ours; an anonymous one is a
  // hook for a stylesheet that is not here.
  if (name === 'SPAN' && !Array.from(el.classList).some(c => KEEP_CLASSES.has(c))) return children;

  const out = mapped ? document.createElement(mapped) : el.cloneNode(false) as Element;
  if (mapped) for (const attr of Array.from(el.attributes)) out.setAttribute(attr.name, attr.value);
  children.forEach(c => out.appendChild(c));
  cleanAttrs(out);

  // An anchor with nowhere to go is text, and an empty inline wrapper is
  // nothing at all — both are what is left when a page's markup was structure
  // rather than formatting.
  if (out.nodeName === 'A' && !out.getAttribute('href')) return Array.from(out.childNodes);
  // A `data:` image is the whole picture inlined into the markup: it would blow
  // past the body size cap on its own and the server refuses the scheme anyway.
  // Everything else with no src left is an image cleanAttrs could not keep.
  if (out.nodeName === 'IMG' && !out.getAttribute('src')) return [];
  if (INLINE.has(out.nodeName) && out.nodeName !== 'BR' && out.nodeName !== 'IMG'
      && !out.firstChild && !isOwnMarkup(out)) return [];

  return [out];
}

/**
 * Lift the result into a flat run of blocks.
 *
 * contentEditable copes badly with bare text and stray inline runs at the top
 * level of a document — and so does the editor: `clearFormatting` finds the
 * block a selection is in by looking for a direct *element* child of the root,
 * and a loose text node is not one, which is a clear-formatting button that
 * silently does nothing. Wrapping here means a pasted document is the same shape
 * as a typed one.
 */
function toBlocks(nodes: Node[]): Node[] {
  const out: Node[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (!run.length) return;
    const hasText = run.some(n => (n.textContent ?? '').trim() || n.nodeName === 'IMG' || n.nodeName === 'BR');
    if (hasText) {
      const p = document.createElement('p');
      run.forEach(n => p.appendChild(n));
      out.push(p);
    }
    run = [];
  };
  for (const node of nodes) {
    const isBlock = node.nodeType === Node.ELEMENT_NODE
      && (BLOCKS.has(node.nodeName) || (node as Element).classList?.contains(TODO_CLASS))
      && node.nodeName !== 'LI'
      && !['THEAD', 'TBODY', 'TR', 'TH', 'TD'].includes(node.nodeName);
    if (isBlock) { flush(); out.push(node); continue; }
    // An <li> that lost its list still holds a line of the document.
    if (node.nodeName === 'LI') {
      flush();
      const ul = document.createElement('ul');
      ul.appendChild(node);
      out.push(ul);
      continue;
    }
    run.push(node);
  }
  flush();
  return out;
}

/**
 * Clipboard HTML as markup the editor could have written itself.
 *
 * Returns an empty string when the paste carried no content worth inserting,
 * which the caller should treat as "there is nothing to paste" rather than as a
 * failure — a clipboard holding only a stylesheet and a tracking pixel is a real
 * thing to be handed, and it should insert nothing rather than a blank line.
 */
export function sanitizePastedHtml(html: string): string {
  if (!html.trim()) return '';

  // Parsed as a whole document rather than assigned to an element's innerHTML:
  // clipboard HTML usually *is* a whole document (`<html><head>…`), and the
  // fragment parser drops the parts of it that are not phrasing content,
  // sometimes including the body. DOMParser keeps everything and runs no
  // scripts and loads no resources while doing it.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body) return '';

  const cleaned: Node[] = [];
  for (const child of Array.from(body.childNodes)) cleaned.push(...clean(child, null));

  const container = document.createElement('div');
  toBlocks(cleaned).forEach(n => container.appendChild(n));

  // Whitespace-only text between blocks is the pretty-printing of whatever
  // wrote the markup, and it becomes a stray blank line in the document.
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !(node.nodeValue ?? '').trim()) node.remove();
  }

  return container.innerHTML;
}

/**
 * Whether a clipboard's HTML is worth taking apart at all.
 *
 * Copying inside one editor puts markup on the clipboard that is already in the
 * right shape, and running it through the rewrite would be work for nothing —
 * but it costs a DOM parse to find that out, and the check would have to be
 * exactly as careful as the rewrite to be safe. So: everything goes through.
 * This exists for the one case that genuinely has no HTML in it.
 */
export function hasHtml(clipboard: DataTransfer | null | undefined): boolean {
  return !!clipboard?.getData('text/html')?.trim();
}
