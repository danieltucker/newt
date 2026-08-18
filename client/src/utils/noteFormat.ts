import { EMBED_CLASS } from './noteEmbed';
import { GALLERY_CLASS } from './noteGallery';

// ── Inline formatting: colour, highlight, and stripping it all back off ──
//
// Two things the browser cannot be asked to do for us:
//
//  * Colour. `execCommand('foreColor')` writes a `style` attribute (or a <font>
//    tag, depending on styleWithCSS), and neither survives storage: the
//    server's allowlist refuses `style` outright - it would be a way to smuggle
//    CSS into a reader's page, see RICH_HTML_OPTIONS in server/src/lib/comments
//    - and drops <font> with it. A colour therefore has to be a class from a
//    fixed palette, mirrored in that allowlist. That is not only a
//    security-driven compromise: a class follows the theme, so a word written
//    in red in the light theme is still readable red at midnight, which an
//    inline hex never could be.
//
//  * Clearing. `execCommand('removeFormat')` leaves links and code spans alone,
//    and - since the colours above are classes rather than styles - leaves
//    every colour in place too. That is exactly the formatting the button
//    exists to remove.
//
// Both work the same way: cut the DOM at the two ends of the selection first,
// so every element the selection touches is afterwards either wholly inside it
// or wholly outside. Everything past that point is a flat walk over text nodes,
// with no partial-overlap cases left to reason about.
//
// The class names here are baked into saved note, post and comment HTML, so
// they are part of the stored document format: they must never be hashed (see
// styles/noteColor.css) and never renamed.

export type ColorKind = 'fg' | 'bg';

export interface ColorChoice {
  id: string;
  label: string;
}

// One set of hues, used as both text colours and highlights. Deliberately a
// short list of *named* choices rather than a colour wheel: every one of them
// has to stay legible on paper in both themes, which is a promise a free hex
// picker cannot make. See styles/noteColor.css for the two sets of values.
export const PALETTE: ColorChoice[] = [
  { id: 'grey',   label: 'Grey' },
  { id: 'red',    label: 'Red' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green',  label: 'Green' },
  { id: 'blue',   label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink',   label: 'Pink' },
];

export function colorClass(kind: ColorKind, id: string): string {
  return `note-${kind}-${id}`;
}

/** Every class this module can write. The server's allowlist mirrors this. */
export const COLOR_CLASSES: string[] = PALETTE
  .flatMap(c => [colorClass('fg', c.id), colorClass('bg', c.id)]);

/** The palette id an element carries for one kind, if any. */
export function colorIdOf(el: Element, kind: ColorKind): string | null {
  const prefix = `note-${kind}-`;
  for (const cls of Array.from(el.classList)) {
    if (!cls.startsWith(prefix)) continue;
    const id = cls.slice(prefix.length);
    if (PALETTE.some(c => c.id === id)) return id;
  }
  return null;
}

// Everything that can wrap a run of words without being a block of its own.
// Wider than what this editor writes, because a paste can bring any of them in
// and "clear formatting" has to mean all of it.
const INLINE_TAGS = new Set([
  'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS',
  'CODE', 'A', 'SUB', 'SUP', 'SMALL', 'BIG', 'MARK', 'FONT', 'TT',
  'Q', 'ABBR', 'CITE', 'KBD', 'SAMP', 'VAR', 'BDI', 'BDO', 'DFN', 'TIME',
]);

/**
 * An object the caret cannot go inside: a reference embed or a gallery. These
 * are single things, not runs of text - colouring "half" of one is meaningless
 * and unwrapping one destroys it - so both operations here stop at the edge.
 *
 * `contenteditable="false"` is the general marker (both kinds are hydrated with
 * it on load); the class checks are the belt to its braces, for markup that has
 * been parsed but not yet hydrated.
 */
function isAtomic(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return el.getAttribute('contenteditable') === 'false'
    || el.classList.contains(EMBED_CLASS)
    || el.classList.contains(GALLERY_CLASS);
}

/** An inline wrapper that may be cut in two, or unwrapped. */
function splittable(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE
    && INLINE_TAGS.has(node.nodeName)
    && !isAtomic(node);
}

function indexIn(parent: Node, child: Node): number {
  return Array.prototype.indexOf.call(parent.childNodes, child);
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;   // already lifted out by an earlier pass
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/**
 * Cut every inline element between a boundary point and `top` so the point
 * becomes a gap *between* siblings rather than a position inside a run.
 * Returns the boundary as a [parent, index] pair. `top` itself is never split.
 *
 * This is what makes the rest of the file simple. Without it, "colour these
 * three words" has to cope with a selection that starts halfway through a bold
 * run and ends halfway through a link; with it, the bold run and the link have
 * already been divided at those two points and every element left inside the
 * selection belongs to the selection entirely.
 */
function splitBoundary(container: Node, offset: number, top: Node): [Node, number] {
  let node: Node = container;
  let index = offset;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const parent = text.parentNode;
    if (!parent) return [node, index];
    if (index > 0 && index < text.length) text.splitText(index);
    index = indexIn(parent, text) + (index > 0 ? 1 : 0);
    node = parent;
  }

  while (node !== top && splittable(node) && node.parentNode) {
    const el = node as Element;
    const parent: Node = node.parentNode;
    if (index > 0 && index < el.childNodes.length) {
      const tail = el.cloneNode(false);
      while (el.childNodes[index]) tail.appendChild(el.childNodes[index]);
      parent.insertBefore(tail, el.nextSibling);
    }
    index = indexIn(parent, el) + (index > 0 ? 1 : 0);
    node = parent;
  }

  return [node, index];
}

/** An empty text node parked at a boundary, to find it again after surgery. */
function mark([parent, index]: [Node, number]): Text {
  const marker = document.createTextNode('');
  parent.insertBefore(marker, parent.childNodes[index] ?? null);
  return marker;
}

/**
 * Split the DOM at both ends of a range and leave a marker at each end.
 *
 * The end is cut before the start, and the start's boundary is read off the
 * range *first*: cutting the end can move the nodes the start was expressed in
 * terms of, and a Range that has been invalidated reports nonsense rather than
 * failing loudly.
 */
function bracket(range: Range, top: Node): { start: Text; end: Text } {
  const startContainer = range.startContainer;
  const startOffset = range.startOffset;
  const end = mark(splitBoundary(range.endContainer, range.endOffset, top));
  const start = mark(splitBoundary(startContainer, startOffset, top));
  return { start, end };
}

/** Every text node lying between two markers, in document order. */
function textNodesBetween(top: Node, start: Node, end: Node): Text[] {
  const walker = document.createTreeWalker(top, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    // Whole atomic islands are stepped over rather than descended into.
    acceptNode: node => node.nodeType === Node.ELEMENT_NODE
      ? (isAtomic(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
      : NodeFilter.FILTER_ACCEPT,
  });
  const out: Text[] = [];
  let inside = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === start) { inside = true; continue; }
    if (node === end) break;
    if (inside && node.nodeValue) out.push(node as Text);
  }
  return out;
}

/** The inline wrappers between a text node and its block, innermost first. */
function inlineChain(text: Text, root: Node): Element[] {
  const chain: Element[] = [];
  for (let el = text.parentElement; el && el !== root && splittable(el); el = el.parentElement) {
    chain.push(el);
  }
  return chain;
}

/** Drop one kind of colour from an element, and the element too if that was all it was. */
function stripKind(el: Element, kind: ColorKind): void {
  const id = colorIdOf(el, kind);
  if (id === null) return;
  el.classList.remove(colorClass(kind, id));
  if (el.classList.length === 0) el.removeAttribute('class');
  if (el.nodeName === 'SPAN' && el.attributes.length === 0) unwrap(el);
}

/** A span this module wrote: nothing on it but the one class. */
function isColorSpan(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE
    && node.nodeName === 'SPAN'
    && !isAtomic(node)
    && (node as Element).attributes.length === 1
    && (node as Element).hasAttribute('class');
}

/**
 * Join neighbouring spans that say the same thing. Colouring a run that already
 * contains formatting produces one span per text node in it; left alone they
 * accumulate every time the colour is changed.
 */
function mergeSpans(parent: Node): void {
  let child = parent.firstChild;
  while (child) {
    const next = child.nextSibling;
    if (next && isColorSpan(child) && isColorSpan(next)
        && (child as Element).className === (next as Element).className) {
      while (next.firstChild) child.appendChild(next.firstChild);
      parent.removeChild(next);
      continue;   // the one after that may join too
    }
    child = next;
  }
}

/**
 * Paint (or, with a null id, unpaint) one kind of colour over a selection.
 *
 * Returns the range to leave selected - the same words, so the bubble stays up
 * and a second colour can be tried straight away - or null if the selection
 * held no text to colour.
 */
export function applyColor(range: Range, root: HTMLElement, kind: ColorKind, id: string | null): Range | null {
  if (range.collapsed) return null;

  const { start, end } = bracket(range, root);
  const nodes = textNodesBetween(root, start, end);
  start.remove();
  end.remove();
  if (nodes.length === 0) return null;

  const cls = id ? colorClass(kind, id) : null;
  const touched = new Set<Node>();

  for (const text of nodes) {
    // Anything already carrying this kind of colour above the run lies wholly
    // inside the selection now, so its class can simply go - which is what
    // makes re-colouring a re-colour rather than a second layer.
    for (const el of inlineChain(text, root)) stripKind(el, kind);
    if (!cls) continue;
    const parent = text.parentNode;
    if (!parent) continue;
    const span = document.createElement('span');
    span.className = cls;
    parent.insertBefore(span, text);
    span.appendChild(text);
    touched.add(parent);
  }

  touched.forEach(mergeSpans);

  return rangeOver(nodes, root);
}

/**
 * The range covering a run of text nodes, for the caller to leave selected.
 * Null if either end was lifted out of the editor by the surgery - nothing to
 * put a selection on, and a range pointing outside the document is worse than
 * none.
 */
function rangeOver(nodes: Text[], root: HTMLElement): Range | null {
  const last = nodes[nodes.length - 1];
  if (!last || !root.contains(nodes[0]) || !root.contains(last)) return null;
  const out = document.createRange();
  out.setStart(nodes[0], 0);
  out.setEnd(last, last.length);
  return out;
}

// An empty span is not reachable by the caret and not selectable, so one is
// given a zero-width space to hold. emit() strips these on the way out, exactly
// as it does for the empty code span the same trick produces.
const ZWSP = '​';

/**
 * Colour with nothing selected, which means "type in this colour from here":
 * an empty span with the caret parked inside it.
 *
 * Turning a colour *off* this way splits out of the span instead and leaves the
 * caret in the gap. That also splits any bold or italic the caret was inside,
 * so typing after it comes out unformatted - the alternative is rebuilding the
 * surviving marks around a caret nobody can see, for a case the toolbar's own
 * buttons fix in one press.
 */
export function colorCaret(range: Range, root: HTMLElement, kind: ColorKind, id: string | null): Range | null {
  const out = document.createRange();

  if (id) {
    const span = document.createElement('span');
    span.className = colorClass(kind, id);
    const text = document.createTextNode(ZWSP);
    span.appendChild(text);
    range.insertNode(span);
    out.setStart(text, 1);
    out.collapse(true);
    return out;
  }

  const host = colorAncestor(range.startContainer, root, kind);
  if (!host) return null;
  const [parent, index] = splitBoundary(
    range.startContainer, range.startOffset, host.parentNode ?? root);
  const text = document.createTextNode(ZWSP);
  parent.insertBefore(text, parent.childNodes[index] ?? null);
  out.setStart(text, 1);
  out.collapse(true);
  return out;
}

/** The nearest element above `node` carrying a colour of this kind. */
function colorAncestor(node: Node, root: HTMLElement, kind: ColorKind): Element | null {
  let el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  while (el && el !== root && root.contains(el)) {
    if (colorIdOf(el, kind)) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * What the caret is standing in, so the picker can show it. Read on open
 * rather than on every selection change: it is a walk up the ancestor chain,
 * and nothing renders it until the panel is up.
 */
export function colorsAt(node: Node | null, root: HTMLElement): { fg: string | null; bg: string | null } {
  let fg: string | null = null;
  let bg: string | null = null;
  let el = node === null ? null
    : node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  while (el && el !== root && root.contains(el)) {
    if (fg === null) fg = colorIdOf(el, 'fg');
    if (bg === null) bg = colorIdOf(el, 'bg');
    el = el.parentElement;
  }
  return { fg, bg };
}

// ── Clear formatting ──────────────────────────────────────────────────
// Back to plain text, and it means it: every inline wrapper over the selected
// words is unwrapped - marks, colours, code spans and links alike - and every
// block the selection touches is reset to a paragraph.
//
// The two halves have different scopes on purpose, which is what every word
// processor does and the only shape that isn't surprising: selecting one word
// in a heading unformats that word, but the heading is a property of the whole
// line and there is no such thing as half of it, so the line becomes body text.

/** Blocks that become a plain paragraph, carrying their contents across. */
const RESET_BLOCKS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV']);

/**
 * What may stand as a top-level child of the editor.
 *
 * A superset of what the editor writes, on purpose: it also has to recognise
 * the shapes a document can arrive in — a `<div>` from an older note, a
 * `<figure>` that survived a paste — because the question this answers is "is
 * this already a block?", and answering no to something that plainly is one
 * would wrap it in a paragraph and change the document.
 */
const BLOCK_NODES = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE',
  'HR', 'TABLE', 'DIV', 'FIGURE', 'SECTION', 'ARTICLE',
]);

/** The top-level block a node sits in - a direct child of the editor root. */
function blockOf(node: Node, offset: number, root: HTMLElement): HTMLElement | null {
  let n: Node | null = node === root
    ? (root.childNodes[offset] ?? root.lastChild)
    : node;
  while (n && n.parentNode !== root) n = n.parentNode;
  return (n as HTMLElement) ?? null;
}

/** Every top-level block a range touches, in document order. */
function blocksIn(range: Range, root: HTMLElement): HTMLElement[] {
  const first = blockOf(range.startContainer, range.startOffset, root);
  const last = blockOf(range.endContainer, range.endOffset, root);
  const children = Array.from(root.children) as HTMLElement[];
  const from = first ? children.indexOf(first) : -1;
  const to = last ? children.indexOf(last) : -1;
  if (from < 0 || to < 0) return [];
  return children.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * Every top-level node of the editor is a block, or an object standing in for
 * one. Returns whether anything had to be moved.
 *
 * ── Why this is needed ──
 * contentEditable does not maintain this invariant and never promised to. A
 * paste, a select-all-and-delete, an execCommand that half-worked — any of them
 * can leave a bare text node or a loose `<b>` sitting directly in the root, and
 * such a document *looks* completely normal. It reads normally, it saves
 * normally, and it comes back the same.
 *
 * What it is not is addressable. Every block operation in this file finds the
 * block a selection is in by looking for the direct child of the root that
 * contains it — and a text node is not among `root.children`, so the lookup
 * comes back empty and the command returns having done nothing at all. That is
 * the "clear formatting doesn't work" report: not a bug in the clearing, but a
 * selection sitting in a place the editor has no name for. The same hole is
 * under every heading, list and quote transform.
 *
 * So rather than teaching each command to cope, the shape is repaired: stray
 * runs are gathered into paragraphs, and the commands can go on assuming what
 * they already assume.
 *
 * Atomic objects — an embed, a gallery — are left where they are. They are
 * their own top-level things and always have been; wrapping one would rewrite
 * the stored markup of every post that has one in it.
 */
export function normalizeBlocks(root: HTMLElement): boolean {
  // Same reason normalizeLists does this: re-parenting a node drops the caret
  // instead of carrying it, and the nodes themselves survive - only their
  // parents change - so the caret can be put back exactly where it was.
  const sel = window.getSelection();
  const mark = sel && sel.rangeCount && root.contains(sel.anchorNode)
    ? { node: sel.anchorNode!, offset: sel.anchorOffset }
    : null;

  let changed = false;
  let run: Node[] = [];

  const flush = (before: Node | null) => {
    if (!run.length) return;
    const p = document.createElement('p');
    run.forEach(n => p.appendChild(n));
    root.insertBefore(p, before);
    run = [];
    changed = true;
  };

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && (BLOCK_NODES.has(node.nodeName) || isAtomic(node))) {
      flush(node);
      continue;
    }
    // Whitespace between two blocks is the pretty-printing of whatever wrote
    // the markup, not a line of the document.
    if (node.nodeType === Node.TEXT_NODE && !(node.nodeValue ?? '').trim() && !run.length) {
      node.remove();
      changed = true;
      continue;
    }
    run.push(node);
  }
  flush(null);

  if (changed && mark && sel) {
    try {
      const r = document.createRange();
      r.setStart(mark.node, Math.min(mark.offset, mark.node.nodeType === Node.TEXT_NODE
        ? (mark.node.nodeValue ?? '').length
        : mark.node.childNodes.length));
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {
      // The marked node was not where it was left. Losing the caret is worse
      // than not restoring it, and both are better than throwing out of a
      // repair.
    }
  }
  return changed;
}

function stripBlockAttrs(el: Element): void {
  el.removeAttribute('class');
  el.removeAttribute('style');
  el.removeAttribute('data-indent');
  el.removeAttribute('data-checked');
}

/**
 * A code block's line breaks are newlines in its text, which a paragraph would
 * collapse to single spaces - so the lines it was written in become <br>s.
 */
function newlinesToBreaks(el: Element): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.nodeValue ?? '').includes('\n')) texts.push(n as Text);
  }
  for (const text of texts) {
    const parent = text.parentNode;
    if (!parent) continue;
    const parts = (text.nodeValue ?? '').split('\n');
    // The first part stays in the original node, so a caller holding on to it
    // (see clearFormatting's returned range) still has a live node.
    text.nodeValue = parts[0];
    let after: Node = text;
    for (const part of parts.slice(1)) {
      const br = document.createElement('br');
      parent.insertBefore(br, after.nextSibling);
      const next = document.createTextNode(part);
      parent.insertBefore(next, br.nextSibling);
      after = next;
    }
  }
}

/** Move an element's contents into a bare <p>. */
function asParagraph(src: HTMLElement, breakLines: boolean): HTMLElement {
  const p = document.createElement('p');
  while (src.firstChild) p.appendChild(src.firstChild);
  if (breakLines) newlinesToBreaks(p);
  if (!p.firstChild) p.appendChild(document.createElement('br'));
  return p;
}

/** Every item of a list (and of the lists nested in it) as its own paragraph. */
function listItems(list: Element, out: HTMLElement[]): void {
  for (const child of Array.from(list.children)) {
    if (child.nodeName === 'UL' || child.nodeName === 'OL') { listItems(child, out); continue; }
    if (child.nodeName !== 'LI') continue;
    // Taken out before the item's own words are moved, so a nested list follows
    // its parent item rather than being swallowed into the same paragraph.
    const nested = Array.from(child.children)
      .filter(c => c.nodeName === 'UL' || c.nodeName === 'OL');
    nested.forEach(n => n.remove());
    out.push(asParagraph(child as HTMLElement, false));
    nested.forEach(n => listItems(n, out));
  }
}

function flattenBlock(block: HTMLElement): void {
  // A table is a shape, not a formatting choice: flattening one loses the rows
  // and columns the author built, which is a different command's job (the
  // table bar's "Delete table"). Its cells are still cleared inline, above.
  if (block.nodeName === 'TABLE' || block.nodeName === 'HR') return;
  // An embed or a gallery standing on its own is one object, and its classes
  // are what it *is* rather than how it is dressed.
  if (isAtomic(block)) return;

  if (block.nodeName === 'UL' || block.nodeName === 'OL') {
    const items: HTMLElement[] = [];
    listItems(block, items);
    if (items.length) block.replaceWith(...items);
    else block.remove();
    return;
  }

  if (RESET_BLOCKS.has(block.nodeName)) {
    block.replaceWith(asParagraph(block, block.nodeName === 'PRE'));
    return;
  }

  stripBlockAttrs(block);
}

/**
 * Strip every scrap of formatting from a selection: back to plain text.
 *
 * With nothing selected it acts on the whole block the caret is in - there is
 * no run of words to point at, and "clear this line" is the only reading of the
 * gesture that does anything at all.
 *
 * Returns the range to leave selected, or null when there was no text in it.
 */
export function clearFormatting(range: Range, root: HTMLElement): Range | null {
  // Before anything is looked up, and not only as a tidy-up: a selection whose
  // ends sit in a bare text node at the root has no block to name, blocksIn
  // comes back empty, and this returns having silently done nothing — which is
  // exactly what the button was reported as doing after a paste. The repair
  // moves nodes without replacing them, so `range` still points at the same
  // text afterwards. See normalizeBlocks.
  normalizeBlocks(root);

  const blocks = blocksIn(range, root);
  if (blocks.length === 0) return null;

  const work = range.collapsed ? document.createRange() : range;
  if (range.collapsed) work.selectNodeContents(blocks[0]);

  const { start, end } = bracket(work, root);
  const nodes = textNodesBetween(root, start, end);
  start.remove();
  end.remove();

  // Inline first, while the blocks still hold the text: unwrapping never
  // removes a block, so the list below stays valid.
  for (const text of nodes) inlineChain(text, root).forEach(unwrap);
  blocks.forEach(flattenBlock);

  return nodes.length ? rangeOver(nodes, root) : null;
}
