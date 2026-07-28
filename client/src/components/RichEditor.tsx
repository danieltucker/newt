import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './RichEditor.module.css';
import { getCaretPath, setCaretPath, CaretPath } from '../utils/caret';
import { HistoryStack, EditKind } from '../utils/history';
import { ACCEPTED_IMAGE_TYPES } from '../utils/imageUpload';
import { findRanges, replaceRange, replaceAll, FindOptions } from '../utils/noteFind';
import { modLabel } from '../utils/platform';
import { PageMeta, pageEmbed, isBareUrl } from '../utils/pageMeta';
import {
  EMBED_CLASS, EmbedData, EmbedVariant, applyCommentCounts, createEmbed, embedAt, embedMatches,
  embedUrlsIn, hydrateEmbeds, readEmbed, variantOf,
} from '../utils/noteEmbed';

// A Confluence-style block editor. There is no separate "edit mode" - the
// surface is always a contentEditable that renders its content live. Typing "/"
// at the start of an empty block opens a command menu that transforms the
// current block (heading, list, to-do, quote, code, divider).
//
// The editor is intentionally *uncontrolled*: React sets the initial HTML on
// mount (the parent remounts it via `key` when switching notes) and never
// rewrites innerHTML afterwards, so the caret is never disturbed. Edits flow
// out through onChange(html).

// Stable, non-hashed class so to-do markup embedded in saved note HTML keeps
// working across builds (a CSS-module hash could change and orphan old notes).
const TODO_CLASS = 'note-todo';
const TABLE_CLASS = 'note-table';

// 'image' and 'reference' are grouped with the blocks in the menu but are not
// block transforms - they open a picker, so applyCmd intercepts them before
// applyBlock.
type BlockId  = 'text' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'todo' | 'quote' | 'code' | 'hr' | 'table' | 'image' | 'reference';
type InlineId = 'bold' | 'italic' | 'underline' | 'strike' | 'inlinecode' | 'link' | 'clear';

interface Cmd {
  id: BlockId | InlineId;
  kind: 'block' | 'inline';
  label: string;
  badge: string;
  hint: string;
  // Extra search terms, including the markdown that produces the same thing -
  // a plain label match can't find "Heading 2" from "h2" or "##".
  keys: string[];
}

const CMDS: Cmd[] = [
  { id: 'text',  kind: 'block', label: 'Text',        badge: '¶',  hint: 'Plain paragraph',      keys: ['text', 'p', 'plain', 'paragraph', 'body', 'normal'] },
  { id: 'h1',    kind: 'block', label: 'Heading 1',   badge: 'H1', hint: 'or type # + space',     keys: ['h1', 'heading1', '#', 'title'] },
  { id: 'h2',    kind: 'block', label: 'Heading 2',   badge: 'H2', hint: 'or type ## + space',    keys: ['h2', 'heading2', '##', 'subtitle', 'subheading'] },
  { id: 'h3',    kind: 'block', label: 'Heading 3',   badge: 'H3', hint: 'or type ### + space',   keys: ['h3', 'heading3', '###'] },
  { id: 'ul',    kind: 'block', label: 'Bullet list', badge: '•',  hint: 'or type - + space',     keys: ['ul', 'bullet', 'list', 'unordered', '-', '*'] },
  { id: 'ol',    kind: 'block', label: 'Numbered',    badge: '1.', hint: 'or type 1. + space',    keys: ['ol', 'number', 'numbered', 'ordered', '1.'] },
  { id: 'todo',  kind: 'block', label: 'To-do',       badge: '☐',  hint: 'or type [] + space',    keys: ['todo', 'task', 'check', 'checkbox', 'checklist', '[]'] },
  { id: 'quote', kind: 'block', label: 'Quote',       badge: '"',  hint: 'or type > + space',     keys: ['quote', 'blockquote', 'cite', '>'] },
  { id: 'code',  kind: 'block', label: 'Code block',  badge: '<>', hint: 'or type ```',           keys: ['code', 'codeblock', 'pre', 'snippet', '```'] },
  { id: 'table', kind: 'block', label: 'Table',       badge: '⊞',  hint: '3×3 - Tab moves cell',  keys: ['table', 'grid', 'tbl', 'rows', 'columns', '|'] },
  { id: 'hr',    kind: 'block', label: 'Divider',     badge: '-',  hint: 'or type ---',           keys: ['hr', 'divider', 'rule', 'line', 'separator', '---'] },
  { id: 'image', kind: 'block', label: 'Image',       badge: '🖼', hint: 'or paste / drop a file', keys: ['image', 'img', 'picture', 'photo', 'screenshot', 'upload'] },
  { id: 'reference', kind: 'block', label: 'Reference', badge: '🔖', hint: 'Embed a saved article', keys: ['reference', 'ref', 'article', 'saved', 'reading', 'embed', 'cite', 'card'] },

  { id: 'bold',       kind: 'inline', label: 'Bold',          badge: 'B',  hint: 'Ctrl+B - **text**',  keys: ['bold', 'b', 'strong', '**'] },
  { id: 'italic',     kind: 'inline', label: 'Italic',        badge: 'I',  hint: 'Ctrl+I - *text*',    keys: ['italic', 'i', 'em', 'emphasis', '*', '_'] },
  { id: 'underline',  kind: 'inline', label: 'Underline',     badge: 'U',  hint: 'Ctrl+U',             keys: ['underline', 'u'] },
  { id: 'strike',     kind: 'inline', label: 'Strikethrough', badge: 'S',  hint: '~~text~~',           keys: ['strike', 'strikethrough', 's', 'del', 'cross', '~~'] },
  { id: 'inlinecode', kind: 'inline', label: 'Inline code',   badge: '`',  hint: 'Monospace `text`',   keys: ['inlinecode', 'mono', 'monospace', 'codespan', '`'] },
  { id: 'link',       kind: 'inline', label: 'Link',          badge: '🔗', hint: 'Add a hyperlink',    keys: ['link', 'url', 'href', 'anchor', 'a', '[]()'] },
  { id: 'clear',      kind: 'inline', label: 'Clear format',  badge: 'Tx', hint: 'Strip formatting',   keys: ['clear', 'remove', 'unformat', 'reset', 'strip', 'plain'] },
];

// Markdown typed at the start of a block turns it into that block, the way the
// slash menu's aliases have always promised. The trailing space is part of the
// trigger, so "1." on its own stays text; Chrome writes that space as a
// non-breaking one, hence the alternative in each character class. Dividers and
// code fences fire on their last character - there's no space to wait for.
const MD_RULES: { re: RegExp; id: BlockId }[] = [
  { re: /^#[ \u00a0]$/,            id: 'h1' },
  { re: /^##[ \u00a0]$/,           id: 'h2' },
  { re: /^###[ \u00a0]$/,          id: 'h3' },
  { re: /^[-*+][ \u00a0]$/,        id: 'ul' },
  { re: /^\d+[.)][ \u00a0]$/,      id: 'ol' },
  { re: /^\[[ \u00a0xX]?\][ \u00a0]$/, id: 'todo' },
  { re: /^>[ \u00a0]$/,            id: 'quote' },
  { re: /^```$/,                   id: 'code' },
  { re: /^(---|\*\*\*|___)$/,      id: 'hr' },
];

// ── List repair ───────────────────────────────────────────────────────
// execCommand can leave a list holding raw text instead of <li> children -
// typically after emptying a list and making a new one over the remains. Such
// a list renders with no bullet or number at all and Enter inside it produces
// sibling lists rather than items, which reads as "lists are broken". Notes
// saved in that state stay broken until the markup is put right, so this runs
// on load as well as after every command that touches a list.
function normalizeLists(editor: HTMLElement) {
  // Re-parenting an item drops the caret where it was rather than carrying it
  // along, so the typing that follows an outdent would land in the wrong item.
  // The nodes themselves survive the repair - only their parents change - so
  // the caret can be put back exactly where the user left it.
  const sel = window.getSelection();
  const mark = sel && sel.rangeCount && editor.contains(sel.anchorNode)
    ? { node: sel.anchorNode!, offset: sel.anchorOffset }
    : null;

  // 1. Anything inside a list that isn't an item or a sub-list becomes an item.
  //    Consecutive strays group into one, so inline formatting stays together.
  editor.querySelectorAll('ul, ol').forEach(list => {
    let buffer: Node[] = [];
    const flush = (before: Node | null) => {
      if (!buffer.length) return;
      const li = document.createElement('li');
      buffer.forEach(n => li.appendChild(n));
      list.insertBefore(li, before);
      buffer = [];
    };
    Array.from(list.childNodes).forEach(node => {
      const isStructural = node.nodeType === Node.ELEMENT_NODE &&
        /^(LI|UL|OL)$/.test((node as HTMLElement).nodeName);
      const isBlankText = node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim();
      if (isStructural) { flush(node); return; }
      if (isBlankText) { list.removeChild(node); return; }
      buffer.push(node);
    });
    flush(null);
  });

  // 2. Outdenting lifts an item out of its sub-list but can leave it inside the
  //    parent item; it belongs to the list, as the sibling that follows.
  editor.querySelectorAll('li').forEach(li => {
    let anchor: Element = li;
    Array.from(li.children)
      .filter(child => child.nodeName === 'LI')
      .forEach(stray => { anchor.after(stray); anchor = stray; });
  });

  // 3. A list directly inside a list belongs to the item above it (the shape
  //    browsers produce for Tab). With no item above, the outer list is just a
  //    wrapper and goes away.
  editor.querySelectorAll('ul, ol').forEach(list => {
    const parent = list.parentElement;
    if (!parent || !/^(UL|OL)$/.test(parent.nodeName)) return;
    const prev = list.previousElementSibling;
    if (prev && prev.nodeName === 'LI') prev.appendChild(list);
  });
  editor.querySelectorAll('ul, ol').forEach(list => {
    const parent = list.parentElement;
    if (!parent || !/^(UL|OL)$/.test(parent.nodeName)) return;
    parent.replaceWith(...Array.from(parent.childNodes));
  });

  // 4. Lists split by the repairs above read as one list, so join neighbours
  //    of the same kind, and drop anything left with no items at all.
  editor.querySelectorAll('ul, ol').forEach(list => {
    let next = list.nextElementSibling;
    while (next && next.nodeName === list.nodeName) {
      const after = next.nextElementSibling;
      while (next.firstChild) list.appendChild(next.firstChild);
      next.remove();
      next = after;
    }
  });
  editor.querySelectorAll('ul, ol').forEach(list => {
    if (!list.querySelector('li')) list.remove();
  });

  if (mark && mark.node.isConnected && sel) {
    const limit = mark.node.nodeType === Node.TEXT_NODE
      ? (mark.node.textContent ?? '').length
      : mark.node.childNodes.length;
    const caret = document.createRange();
    try {
      caret.setStart(mark.node, Math.min(mark.offset, limit));
      caret.collapse(true);
      sel.removeAllRanges();
      sel.addRange(caret);
    } catch { /* the node was rewritten out from under us - leave the caret be */ }
  }
}

// How far a block is indented by Tab. Lists nest natively; everything else
// (paragraphs, headings, to-dos) steps through this attribute.
const INDENT_ATTR = 'data-indent';
const MAX_INDENT = 5;

function indentBlock(block: HTMLElement, delta: 1 | -1) {
  const next = Math.max(0, Math.min(MAX_INDENT, Number(block.getAttribute(INDENT_ATTR) ?? 0) + delta));
  if (next === 0) block.removeAttribute(INDENT_ATTR);
  else block.setAttribute(INDENT_ATTR, String(next));
}

// Match on the label and every alias, ignoring spaces and case, so "h2",
// "heading2", "heading 2" and "##" all land on Heading 2.
function cmdMatches(cmd: Cmd, query: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return true;
  if (cmd.label.toLowerCase().replace(/\s+/g, '').includes(q)) return true;
  return cmd.keys.some(k => k.includes(q));
}

// Toolbar glyphs. Stroke-based 24-viewBox icons, matching the rest of the app -
// the letter/punctuation stand-ins read poorly at button size.
const icon = (paths: React.ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
);

// A quote bar beside indented lines - reads as "blockquote" rather than as a
// stray punctuation mark
const QuoteIcon = () => icon(<>
  <path d="M4 5v14" />
  <path d="M9 7h11" /><path d="M9 12h11" /><path d="M9 17h7" />
</>);

const CodeIcon = () => icon(<>
  <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
</>);

// Eraser - the conventional "remove formatting" mark
const ClearIcon = () => icon(<>
  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
  <path d="M22 21H7" /><path d="m5 11 9 9" />
</>);

// A single clean rule. Faded marks above and below read as "=" at this size.
const DividerIcon = () => icon(<path d="M3 12h18" />);

const TableIcon = () => icon(<>
  <rect x="3" y="4" width="18" height="16" rx="2" />
  <path d="M3 10h18" /><path d="M9 10v10" /><path d="M15 10v10" />
</>);

const TrashIcon = () => icon(<>
  <path d="M3 6h18" /><path d="M8 6V4h8v2" />
  <path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5" /><path d="M14 11v5" />
</>);

const LinkIcon = () => icon(<>
  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
</>);

// Framed picture - a sun and a hill, the usual shorthand for a photo
const ImageIcon = () => icon(<>
  <rect x="3" y="3" width="18" height="18" rx="2" />
  <circle cx="8.5" cy="8.5" r="1.5" />
  <path d="m21 15-4.35-4.35a2 2 0 0 0-2.83 0L3 21" />
</>);

// A bookmark - what the saved articles /reference points at already look like
// everywhere else in the app
const ReferenceIcon = () => icon(<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />);

// The three embed sizes, drawn as what they lay out: a line of text, a card
// with its thumbnail beside the title, a card led by full-width artwork.
const SmallCardIcon = () => icon(<>
  <rect x="2.5" y="6" width="19" height="12" rx="2" />
  <rect x="5.5" y="9" width="6" height="6" rx="1" />
  <path d="M14.5 10.5h4M14.5 14h4" />
</>);

const LargeCardIcon = () => icon(<>
  <rect x="2.5" y="4" width="19" height="16" rx="2" />
  <path d="M2.5 13.5h19" />
  <path d="M6 16.8h8" />
</>);

// ── Tables ────────────────────────────────────────────────────────────
// A table is ordinary <table class="note-table"> markup living inside the
// editable surface: a header row plus body rows, every cell editable on its
// own. The class is global (like .note-todo) so saved note HTML keeps its
// styling across builds.
function buildCell(tag: 'th' | 'td'): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.appendChild(document.createElement('br'));
  return cell;
}

function buildRow(cols: number, tag: 'th' | 'td'): HTMLTableRowElement {
  const tr = document.createElement('tr');
  for (let c = 0; c < cols; c++) tr.appendChild(buildCell(tag));
  return tr;
}

function buildTable(bodyRows: number, cols: number): HTMLTableElement {
  const table = document.createElement('table');
  table.className = TABLE_CLASS;
  const thead = document.createElement('thead');
  thead.appendChild(buildRow(cols, 'th'));
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (let r = 0; r < bodyRows; r++) tbody.appendChild(buildRow(cols, 'td'));
  table.appendChild(tbody);
  return table;
}

// The cell holding the caret, if the selection is inside one of our tables.
function cellAtCaret(editor: HTMLElement): HTMLTableCellElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null;
  const node = sel.anchorNode;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  const cell = el?.closest('th, td') as HTMLTableCellElement | null;
  if (!cell || !editor.contains(cell)) return null;
  return cell.closest(`table.${TABLE_CLASS}`) ? cell : null;
}

// Move the caret into a cell: after existing text (so Tab lands where you'd
// keep typing), but *before* the filler <br> of an empty cell - after it would
// leave the caret stranded on a phantom second line.
function focusCell(cell: HTMLTableCellElement) {
  placeCaret(cell, !(cell.textContent ?? '').trim());
}

function cellsOf(table: HTMLTableElement): HTMLTableCellElement[] {
  return Array.from(table.querySelectorAll('th, td'));
}

// Column index is positional: every row in these tables has the same width
// (no colspan is ever produced), so cellIndex is the column.
function columnCount(table: HTMLTableElement): number {
  return table.rows[0]?.cells.length ?? 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Where a drop landed, as a collapsed Range. The two APIs are the WebKit/Blink
// and Gecko spellings of the same thing; neither is in every browser, so a null
// return has to be tolerated by the caller.
function rangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const r = document.createRange();
  r.setStart(pos.offsetNode, pos.offset);
  r.collapse(true);
  return r;
}

// ── Links ─────────────────────────────────────────────────────────────
// What the user types in the link dialog is rarely a full URL - "example.com"
// is the common case, so a bare host gets https://. Anything that already names
// a scheme, an anchor or a site-root path is left alone; the script-bearing
// schemes are refused outright rather than rewritten.
function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (/^(javascript|data|vbscript):/i.test(s)) return '';
  if (/^([a-z][a-z0-9+.-]*:|#|\/|\.\/|\.\.\/)/i.test(s)) return s;
  return `https://${s}`;
}

// The <a> the caret sits in (or that the selection lies within), if any - an
// existing link is edited in place rather than nested inside a new one.
function anchorAt(editor: HTMLElement): HTMLAnchorElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  const a = el?.closest('a') as HTMLAnchorElement | null;
  return a && editor.contains(a) ? a : null;
}

// State of the link dialog: the fields, plus what the Apply will act on.
interface LinkForm {
  url: string;
  text: string;
  selected: string;    // text the selection covered when the dialog opened
  editing: boolean;    // an existing link is being changed
  // How the link should render. 'link' is the plain anchor this dialog has
  // always produced; the two card sizes reuse the reference embed, so a link
  // and a saved article look the same at the same size.
  variant: EmbedVariant;
}

// What each link size is called in the dialog, and the one-liner under it.
const LINK_SIZES: { id: EmbedVariant; label: string; hint: string }[] = [
  { id: 'link',  label: 'Text',       hint: 'Inline, in the sentence' },
  { id: 'small', label: 'Small card', hint: 'Thumbnail and title' },
  { id: 'large', label: 'Large card', hint: 'Full-width artwork' },
];

interface Props {
  initialHtml: string;
  onChange: (html: string) => void;
  readOnly?: boolean;   // notes in Recently Deleted are shown, not edited
  // Supplied by whichever surface embeds the editor. Its absence is what hides
  // the image affordances entirely - the editor itself knows nothing about how
  // or where an image is stored, only how to ask for a URL and insert it.
  onUploadImage?: (file: File) => Promise<{ url: string; width: number; height: number }>;
  // What /reference can point at, already reduced to the embed shape. Absent
  // hides the command, exactly as onUploadImage gates the image one. The editor
  // never learns what a reading list is - a tweet or an external link would
  // arrive here as more entries of a different `kind`.
  references?: EmbedData[];
  // Live comment counts by article URL, for the large card. Never stored - see
  // applyCommentCounts. The embedding surface fetches them because it is the
  // one that knows whether the viewer is signed in.
  commentCounts?: Record<string, number>;
  // Fired when a reference is added, so the surface above can fetch a count for
  // it. Deliberately not fired on removal: a URL that lingers in the fetch list
  // costs one unused number, whereas checking after every keystroke would cost
  // a DOM walk on every keystroke.
  onEmbedsChange?: (urls: string[]) => void;
  // Whether Ctrl/Cmd+F opens find & replace over this surface. Off by default
  // because it is a claim on a key the browser already owns: worth it in a
  // document (notes, posts), wrong in a short composer, where the reader almost
  // certainly means to search the page around it rather than their own draft.
  findable?: boolean;
  // Put the caret in the editor as soon as it mounts. For surfaces that appear
  // *because* the user asked to write - a reply, a new comment - where landing
  // anywhere else means a wasted click.
  autoFocus?: boolean;
  // Reads a URL's title and artwork, so a link can be inserted as a card.
  // Injected for the same reason onUploadImage is: the editor knows how to
  // render a card, not how this app talks to its server. Absent, the link
  // dialog offers plain text only.
  onFetchPageMeta?: (url: string) => Promise<PageMeta>;
}

// ── CSS Custom Highlight API ──
// Newer than the DOM typings this project builds against, so it is reached
// through a narrow local declaration rather than by widening the whole lib.
type HighlightCtor = new (...ranges: Range[]) => object;
interface HighlightRegistry {
  set(name: string, highlight: object): void;
  delete(name: string): void;
}

const HIGHLIGHTS: HighlightRegistry | null =
  typeof CSS !== 'undefined' && 'highlights' in CSS
    ? (CSS as unknown as { highlights: HighlightRegistry }).highlights
    : null;

const Highlight: HighlightCtor | null =
  typeof window !== 'undefined' && typeof (window as unknown as { Highlight?: HighlightCtor }).Highlight === 'function'
    ? (window as unknown as { Highlight: HighlightCtor }).Highlight
    : null;

// Every match, and the one the user is standing on. Two registries so the
// current hit can be painted differently without re-splitting the list.
const HL_ALL = 'note-find';
const HL_CURRENT = 'note-find-current';

interface MenuPos { left: number; top: number | null; bottom: number | null; maxHeight: number; }

// Inline marks the toolbars light up for
interface Marks { bold: boolean; italic: boolean; underline: boolean; strike: boolean; }
const NO_MARKS: Marks = { bold: false, italic: false, underline: false, strike: false };

// First-paint estimate only - the bubble sizes to its content, so the real
// width is measured after render and the position corrected before paint.
const BUBBLE_EST_W = 250;
const BUBBLE_M = 8;

interface BubblePos { anchorX: number; left: number; top: number; }

// Centre the bubble over the selection. `boundsTop` is the top of the editor's
// scroll area - selecting on the first line would otherwise float the bubble up
// over the utility bar, so in that case it flips below the selection instead.
function computeBubblePos(r: DOMRect, boundsTop: number): BubblePos {
  const anchorX = r.left + r.width / 2;
  let top = r.top - 44;
  if (top < Math.max(BUBBLE_M, boundsTop)) top = r.bottom + BUBBLE_M;
  return { anchorX, left: clampBubbleLeft(anchorX, BUBBLE_EST_W), top };
}

function clampBubbleLeft(anchorX: number, width: number): number {
  return Math.max(BUBBLE_M, Math.min(anchorX - width / 2, window.innerWidth - width - BUBBLE_M));
}

// Keep the command menu fully on-screen: clamp horizontally, and flip above the
// caret when there isn't room below. maxHeight makes it scroll rather than run
// off the page.
function computeMenuPos(base: DOMRect): MenuPos {
  const MENU_W = 288;
  const M = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = base.left;
  if (left + MENU_W > vw - M) left = vw - MENU_W - M;
  if (left < M) left = M;
  const spaceBelow = vh - base.bottom - M;
  const spaceAbove = base.top - M;
  if (spaceBelow < 200 && spaceAbove > spaceBelow) {
    return { left, top: null, bottom: vh - base.top + 4, maxHeight: Math.max(140, Math.min(300, spaceAbove - 4)) };
  }
  return { left, top: base.bottom + 4, bottom: null, maxHeight: Math.max(140, Math.min(300, spaceBelow - 4)) };
}

// The top-level block element that contains the caret (a direct child of the
// editor root).
function getBlock(editor: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node: Node | null = sel.anchorNode;
  if (!node) return null;
  if (node === editor) {
    return (editor.children[sel.anchorOffset] as HTMLElement)
      ?? (editor.lastElementChild as HTMLElement) ?? null;
  }
  while (node && node.parentNode !== editor) node = node.parentNode;
  return (node as HTMLElement) ?? null;
}

// stripSlash leaves the block holding nothing but an empty text node, and
// Chrome treats such a block as if it weren't there: formatBlock and the list
// commands act on the *previous* block, and typed text lands outside the
// paragraph entirely. Swap in a <br> and re-anchor the caret so commands apply
// to the line the user is actually on. Returns the repaired block.
function repairBlankBlock(editor: HTMLElement): HTMLElement | null {
  const block = getBlock(editor);
  if (!block) return null;
  if ((block.textContent ?? '').trim() || block.querySelector('br, hr, img')) return block;
  while (block.firstChild) block.removeChild(block.firstChild);
  block.appendChild(document.createElement('br'));
  placeCaret(block, true);
  return getBlock(editor);
}

function placeCaret(node: Node, atStart = true) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(atStart);
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretAtBlockStart(block: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(block);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length === 0;
}

// No visible text between the caret and the end of the block (trailing <br>s
// count as empty).
function caretAtBlockEnd(block: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(block);
  try { r.setStart(sel.anchorNode!, sel.anchorOffset); } catch { return false; }
  return r.toString().length === 0;
}

// The line the caret sits on has no text (caret at block start or right after a
// line break).
function currentLineEmpty(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return false;
  const node = sel.anchorNode;
  const off = sel.anchorOffset;
  if (node.nodeType === Node.TEXT_NODE) {
    const before = (node.textContent ?? '').slice(0, off);
    if (before.length > 0) return /\n$/.test(before);
    const prev = node.previousSibling;
    return !prev || (prev as HTMLElement).nodeName === 'BR';
  }
  const child = (node as HTMLElement).childNodes[off - 1];
  return !child || (child as HTMLElement).nodeName === 'BR';
}

// Whether the placeholder should show. Text alone isn't enough to decide:
// to-dos, dividers, and empty code/quote frames render visibly while holding
// no text, and the placeholder would sit on top of them.
function isBlank(el: HTMLElement): boolean {
  if ((el.textContent ?? '').trim()) return false;
  return !el.querySelector(
    `hr, img, pre, blockquote, ul, ol, h1, h2, h3, table, .${TODO_CLASS}, .${EMBED_CLASS}`);
}

// Select an atomic island (an embed) as a unit: the browser highlights it, and
// Backspace then removes the whole thing rather than putting a caret inside a
// node that cannot hold one.
function selectNode(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNode(node);
  sel.removeAllRanges();
  sel.addRange(r);
}

// The embed a selection covers. Clicking an atomic island brackets it rather
// than landing inside it, so the single-node case is checked before the usual
// ancestor walk.
function embedInSelection(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const bracketed = r.startContainer === r.endContainer && r.endOffset === r.startOffset + 1
    ? r.startContainer.childNodes[r.startOffset]
    : null;
  return embedAt(bracketed ?? null, root) ?? embedAt(r.commonAncestorContainer, root);
}

export default function RichEditor({
  initialHtml, onChange, readOnly = false, onUploadImage, references, commentCounts,
  onEmbedsChange, findable = false, autoFocus = false, onFetchPageMeta,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The range to insert into, stashed before the file picker opens. Choosing a
  // file moves focus out of the editor and collapses the selection, so without
  // this the image would land wherever focus happens to return to.
  const imageRange = useRef<Range | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [linkForm, setLinkForm] = useState<LinkForm | null>(null);
  // A card has to go and read the page first, which is slow enough to say so.
  const [linkBusy, setLinkBusy] = useState(false);
  // /reference: the picker, and where its result goes. The range is stashed for
  // the same reason the image one is - the search field takes focus, which
  // collapses whatever the caret was on.
  const [pickerOpen, setPickerOpen] = useState(false);
  const embedRange = useRef<Range | null>(null);
  // The embed the selection is on, if any. It is what turns the floating bar
  // from a formatting bubble into the embed's own controls.
  const [embedEl, setEmbedEl] = useState<HTMLElement | null>(null);
  // The plain <a> the caret is sitting in. It gets the same floating bar an
  // embed does - a link is an object you can resize too, not just styled text.
  const [linkEl, setLinkEl] = useState<HTMLAnchorElement | null>(null);
  // Non-null while the bar's inline "edit text" field is open, holding its
  // draft. Null means the bar is showing its buttons.
  const [linkTextDraft, setLinkTextDraft] = useState<string | null>(null);
  // The selectionchange listener is registered once, so it would close over a
  // stale linkEl. Mirrored the way slashOpenRef and queryRef are.
  const linkElRef = useRef<HTMLAnchorElement | null>(null);
  linkElRef.current = linkEl;
  // The selection the dialog was opened on. Focusing an input collapses it, so
  // it's restored before the link is written back.
  const linkRange = useRef<Range | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIdx, setSlashIdx] = useState(0);
  const [menuPos, setMenuPos] = useState<MenuPos>({ left: 0, top: 0, bottom: null, maxHeight: 280 });
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const [inTable, setInTable] = useState(false);
  const [bubble, setBubble] = useState<BubblePos | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // The rendered bubble is as wide as its buttons need; re-centre on the real
  // width before paint so nothing hangs off either edge.
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el || !bubble) return;
    el.style.left = `${clampBubbleLeft(bubble.anchorX, el.offsetWidth)}px`;
  }, [bubble]);

  // Where the "/" was typed, so we can strip "/query" before applying a command
  const slashInfo = useRef<{ node: Node; offset: number } | null>(null);
  const slashOpenRef = useRef(false);
  slashOpenRef.current = slashOpen;
  const menuRef = useRef<HTMLDivElement>(null);

  // ── Undo/redo ──────────────────────────────────────────────────────────
  // Custom history: the editor's own DOM edits bypass contentEditable's native
  // undo, so we record a pre-edit snapshot before every change and drive Ctrl+Z
  // ourselves. `record('type')` runs on beforeinput (coalesced); command
  // handlers call `record('struct')` before they mutate.
  type Snap = { html: string; caret: CaretPath | null };
  const historyRef = useRef<HistoryStack<Snap> | null>(null);
  if (!historyRef.current) historyRef.current = new HistoryStack<Snap>();
  const history = historyRef.current;

  function snapshot(): Snap {
    const el = ref.current!;
    return { html: el.innerHTML, caret: getCaretPath(el) };
  }
  function record(kind: EditKind) {
    if (ref.current) history.record(snapshot(), kind);
  }
  function restore(snap: Snap) {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = snap.html;
    setCaretPath(el, snap.caret);
    el.classList.toggle('note-empty', isBlank(el));
    onChange(el.innerHTML);
  }
  function undo() {
    if (!ref.current) return;
    const prev = history.undoTo(snapshot());
    if (prev) restore(prev);
  }
  function redo() {
    if (!ref.current) return;
    const next = history.redoTo(snapshot());
    if (next) restore(next);
  }

  // ── Find & replace ─────────────────────────────────────────────────────
  // Hits are painted with the CSS Custom Highlight API, which draws over live
  // Ranges without touching the DOM. That matters more here than it looks: the
  // editor is uncontrolled and every mutation flows out through onChange, so
  // wrapping hits in <mark> would save highlight markup into the document and
  // push junk onto the undo stack. Searching has to be free of side effects.
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [findOpts, setFindOpts] = useState<FindOptions>({ caseSensitive: false, wholeWord: false });
  // Match count and cursor are state (they are rendered); the Ranges themselves
  // are a ref - they are recomputed constantly and nothing renders from them.
  const [findHits, setFindHits] = useState({ count: 0, index: 0 });
  const hitsRef = useRef<Range[]>([]);
  const findIdxRef = useRef(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  function clearHighlights() {
    HIGHLIGHTS?.delete(HL_ALL);
    HIGHLIGHTS?.delete(HL_CURRENT);
  }

  function paintHighlights(ranges: Range[], index: number) {
    const current = ranges[index];
    // Without the highlight API there is nothing to paint over, so fall back to
    // the one selection the browser will draw for us. It marks the current hit
    // only - the others stay invisible - which is why this is the fallback and
    // not the design: focus stays in the find field, so it renders as an
    // inactive selection rather than stealing the caret.
    if (!HIGHLIGHTS || !Highlight) {
      if (!current) return;
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(current.cloneRange());
      return;
    }
    const rest = ranges.filter((_, i) => i !== index);
    HIGHLIGHTS.set(HL_ALL, new Highlight(...rest));
    if (current) HIGHLIGHTS.set(HL_CURRENT, new Highlight(current));
    else HIGHLIGHTS.delete(HL_CURRENT);
  }

  // Bring a match into view without stealing focus from the find field - the
  // scroller is nudged just far enough, so the page doesn't jump on every step.
  function revealMatch(range: Range) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const r = range.getBoundingClientRect();
    if (!r.height && !r.width) return;   // collapsed or detached
    const box = scroller.getBoundingClientRect();
    const margin = 48;
    if (r.top < box.top + margin) scroller.scrollTop -= box.top + margin - r.top;
    else if (r.bottom > box.bottom - margin) scroller.scrollTop += r.bottom - (box.bottom - margin);
  }

  /**
   * Recompute the hit list against the document as it stands. `keepIndex` holds
   * the user's place across an edit; otherwise the cursor returns to the first
   * hit, which is what a changed query means.
   */
  function refreshFind(keepIndex = true) {
    const el = ref.current;
    if (!el || !findOpen || !findQuery) {
      hitsRef.current = [];
      findIdxRef.current = 0;
      clearHighlights();
      setFindHits({ count: 0, index: 0 });
      return;
    }
    const ranges = findRanges(el, findQuery, findOpts);
    const index = ranges.length
      ? Math.min(keepIndex ? findIdxRef.current : 0, ranges.length - 1)
      : 0;
    hitsRef.current = ranges;
    findIdxRef.current = index;
    paintHighlights(ranges, index);
    setFindHits({ count: ranges.length, index });
  }

  function gotoMatch(delta: number) {
    const ranges = hitsRef.current;
    if (!ranges.length) return;
    // Wraps in both directions: reaching the end and carrying on is how every
    // find bar behaves, and stopping dead reads as a broken button.
    const next = (findIdxRef.current + delta + ranges.length) % ranges.length;
    findIdxRef.current = next;
    paintHighlights(ranges, next);
    setFindHits({ count: ranges.length, index: next });
    revealMatch(ranges[next]);
  }

  function openFind(withReplace = false) {
    if (!findable) return;
    setFindOpen(true);
    if (withReplace) setReplaceOpen(true);
    // Opening on a selection searches for it, the way every editor does.
    const sel = window.getSelection();
    const picked = sel && !sel.isCollapsed && ref.current?.contains(sel.anchorNode)
      ? sel.toString().trim()
      : '';
    if (picked && !picked.includes('\n')) setFindQuery(picked);
    // The field may be mounting this same tick, so focus after paint.
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  // Keys while focus is in one of the find fields. The bar is outside the
  // editor's own keydown handler, so it repeats the bindings it needs.
  function handleFindKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      // Stop the host (the notes console) from also acting on this Escape.
      e.preventDefault();
      e.stopPropagation();
      closeFind();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter in the replace field replaces; in the find field it steps on.
      if (e.currentTarget.getAttribute('aria-label') === 'Replace with' && !e.shiftKey) replaceCurrent();
      else gotoMatch(e.shiftKey ? -1 : 1);
      return;
    }
    // Pressing the open-find chord again re-selects the query, so a second
    // Ctrl+F is "search for something else" rather than a no-op.
    if (mod && (e.code === 'KeyF' || e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      findInputRef.current?.focus();
      findInputRef.current?.select();
      return;
    }
    if (e.key === 'F3' || (mod && (e.code === 'KeyG' || e.key === 'g' || e.key === 'G'))) {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
    }
  }

  function closeFind() {
    setFindOpen(false);
    setReplaceOpen(false);
    hitsRef.current = [];
    findIdxRef.current = 0;
    clearHighlights();
    setFindHits({ count: 0, index: 0 });
    ref.current?.focus();
  }

  // Replacing is a document edit like any other, so it goes through the same
  // history and save path the toolbar commands use - one entry for one action,
  // which is what makes Ctrl+Z after "Replace all" put everything back at once.
  function replaceCurrent() {
    const range = hitsRef.current[findIdxRef.current];
    if (!range || readOnly) return;
    record('struct');
    replaceRange(range, replaceWith);
    ref.current?.normalize();
    emit();
    // The replacement may itself contain the query ("cat" → "cats"), so stay
    // where we are rather than advancing past a hit that just appeared.
    refreshFind();
  }

  function replaceEvery() {
    const el = ref.current;
    if (!el || readOnly || !findQuery) return;
    record('struct');
    const n = replaceAll(el, findQuery, replaceWith, findOpts);
    if (!n) return;
    emit();
    findIdxRef.current = 0;
    refreshFind(false);
  }

  // Re-run the search whenever the query, the flags, or the open state change.
  useEffect(() => {
    refreshFind(false);
    if (findOpen && findQuery && hitsRef.current.length) revealMatch(hitsRef.current[0]);
  }, [findQuery, findOpts, findOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlights are registered on the document, not on this element, so an
  // unmount that skipped closeFind would leave them painted over nothing.
  useEffect(() => clearHighlights, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing/paste/delete: snapshot the pre-change state (native beforeinput fires
  // before the DOM mutates), coalesced into word-level groups.
  useEffect(() => {
    const el = ref.current;
    if (!el || readOnly) return;
    const onBeforeInput = () => record('type');
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close the command menu when clicking anywhere outside it
  useEffect(() => {
    if (!slashOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeSlash();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [slashOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set the initial content once; the parent remounts (key) on note switch.
  useEffect(() => {
    const el = ref.current!;
    el.innerHTML = initialHtml && initialHtml.trim() ? initialHtml : '<p><br></p>';
    // Notes written before the list markup was fixed open with their bullets
    // and numbers missing; put them right on the way in.
    const beforeRepair = el.innerHTML;
    normalizeLists(el);
    // Blog bodies come back from the server sanitizer stripped of the attribute
    // that makes an embed atomic, so put it back before the caret can wander in.
    hydrateEmbeds(el);
    el.classList.toggle('note-empty', isBlank(el));
    if (el.innerHTML !== beforeRepair && !readOnly) onChange(el.innerHTML);   // persist the repair
    // Caret to the end, not the start: an edit surface seeded with existing
    // text should continue it rather than type in front of it.
    if (autoFocus && !readOnly) {
      el.focus();
      const last = el.lastElementChild;
      if (last) placeCaret(last, false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live counts land straight on the DOM rather than going through onChange -
  // they are display, not content, and must never reach what gets saved.
  useEffect(() => {
    if (ref.current && commentCounts) applyCommentCounts(ref.current, commentCounts);
  }, [commentCounts]);

  // Both pickers are only offered where the embedding surface can serve them:
  // no uploader, no image; nothing to reference, no /reference.
  const available = CMDS.filter(c =>
    (c.id !== 'image' || !!onUploadImage) && (c.id !== 'reference' || !!references));
  const filtered = slashQuery ? available.filter(c => cmdMatches(c, slashQuery)) : available;

  function emit() {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle('note-empty', isBlank(el));
    onChange(el.innerHTML);
    // Editing moves the text the highlights are painted over, so the hit list
    // is stale the moment the document changes. Only costs a walk while the
    // find bar is actually open with something in it.
    if (findOpen && findQuery) refreshFind();
  }

  function closeSlash() {
    slashInfo.current = null;
    setSlashOpen(false);
    setSlashQuery('');
    setSlashIdx(0);
  }

  // ── Toolbars ──────────────────────────────────────────────────────────
  // Both the bar above the note and the selection bubble drive these. Buttons
  // suppress mousedown so focus (and the selection) never leaves the editor,
  // which is what lets execCommand act on what the user highlighted.
  function readMarks(): Marks {
    try {
      return {
        bold:      document.queryCommandState('bold'),
        italic:    document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        strike:    document.queryCommandState('strikeThrough'),
      };
    } catch { return NO_MARKS; }
  }

  function execInline(command: string, value?: string) {
    ref.current?.focus();
    record('struct');
    document.execCommand(command, false, value);
    setMarks(readMarks());
    emit();
  }

  // ── Link dialog ───────────────────────────────────────────────────────
  // Links are composed in the console itself (text + URL), not in a browser
  // prompt. Opening stashes the selection - the fields take focus away from the
  // editor, and the range is what Apply writes into.
  function applyLink() {
    const editor = ref.current;
    const sel = window.getSelection();
    if (!editor || !sel || sel.rangeCount === 0) return;

    const existing = anchorAt(editor);
    if (existing) {
      // Select the anchor itself, not its contents - Apply replaces the whole
      // element, so an edited link can't end up nested inside the old one.
      const r = document.createRange();
      r.selectNode(existing);
      linkRange.current = r;
      setLinkForm({
        url: existing.getAttribute('href') ?? '',
        text: existing.textContent ?? '',
        selected: existing.textContent ?? '',
        editing: true,
        variant: 'link',
      });
    } else {
      linkRange.current = sel.getRangeAt(0).cloneRange();
      const selected = sel.isCollapsed ? '' : sel.toString();
      setLinkForm({ url: '', text: selected, selected, editing: false, variant: 'link' });
    }
    setBubble(null);
  }

  // Put the stashed selection back and hand focus to the editor, so execCommand
  // acts where the user invoked the dialog.
  function restoreLinkRange(): Selection | null {
    const sel = window.getSelection();
    const saved = linkRange.current;
    if (!sel || !saved) return null;
    ref.current?.focus();
    sel.removeAllRanges();
    sel.addRange(saved);
    return sel;
  }

  function closeLink() {
    setLinkForm(null);
    linkRange.current = null;
  }

  async function submitLink(form: LinkForm) {
    const href = normalizeUrl(form.url);
    if (!href) return;

    // A card is an embed, not an anchor: fetch what the page calls itself, then
    // hand it to the same writer the reference picker uses. The fetch happens
    // before the selection is restored because it is the slow part, and the
    // dialog stays up saying so.
    if (form.variant !== 'link' && onFetchPageMeta) {
      setLinkBusy(true);
      let meta: PageMeta = { title: null, image: null };
      try {
        meta = await onFetchPageMeta(href);
      } catch {
        // A card with the host as its title is still better than nothing, and
        // is what pageEmbed falls back to.
      }
      setLinkBusy(false);
      if (!restoreLinkRange()) { closeLink(); return; }
      record('struct');
      writeEmbedAtSelection(pageEmbed(href, meta, form.text), form.variant);
      closeLink();
      return;
    }

    const sel = restoreLinkRange();
    if (!sel) { closeLink(); return; }
    record('struct');
    const label = form.text.trim();

    // Linking the selection as it stands keeps whatever formatting it holds -
    // only a changed (or absent) label has to be written as fresh markup.
    if (form.editing) {
      document.execCommand('insertHTML', false,
        `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>`);
    } else if (!form.selected) {
      // Nothing was selected (toolbar or slash menu on a bare caret)
      document.execCommand('insertHTML', false,
        `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>&nbsp;`);
    } else if (label && label !== form.selected.trim()) {
      document.execCommand('insertHTML', false,
        `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
    } else {
      document.execCommand('createLink', false, href);
    }
    setMarks(readMarks());
    emit();
    closeLink();
  }

  function removeLink() {
    const sel = restoreLinkRange();
    if (sel) { record('struct'); document.execCommand('unlink'); emit(); }
    closeLink();
  }

  // ── Images ────────────────────────────────────────────────────────────
  // Three ways in - the toolbar/slash command, paste, and drop - all funnel
  // through insertImages so they behave identically.
  function pickImage() {
    const sel = window.getSelection();
    imageRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    setUploadError(null);
    fileRef.current?.click();
  }

  // Restore a stashed caret if we still have a usable one; otherwise fall back
  // to the end of the note, which is where an insertion with no prior selection
  // belongs. Shared by the image upload and the /reference picker - both hand
  // focus away and come back to a collapsed, worthless selection.
  function restoreRange(saved: Range | null) {
    const editor = ref.current;
    const sel = window.getSelection();
    if (!editor || !sel) return;
    editor.focus();
    // A stashed range is only usable if it still points inside this editor -
    // the DOM may have changed while the upload/picker was up.
    if (saved && editor.contains(saved.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(saved);
      return;
    }
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function restoreImageRange() {
    restoreRange(imageRange.current);
  }

  async function insertImages(files: File[]) {
    if (!onUploadImage || files.length === 0) return;
    const images = files.filter(f => f.type.startsWith('image/'));
    if (images.length === 0) return;

    setUploading(true);
    setUploadError(null);
    try {
      // Sequential rather than parallel: each insertion depends on where the
      // last one left the caret, and uploads are rate-limited per user anyway.
      for (const file of images) {
        const { url, width, height } = await onUploadImage(file);
        restoreImageRange();
        record('struct');
        // width/height are the intrinsic pixel size, so the browser can reserve
        // the right space before the bytes arrive; CSS caps the displayed size.
        const dims = width && height ? ` width="${width}" height="${height}"` : '';
        document.execCommand('insertHTML', false,
          `<p><img src="${escapeHtml(url)}" alt=""${dims}></p><p><br></p>`);
        // Carry the caret forward so a second file lands after the first
        const sel = window.getSelection();
        imageRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
      }
      emit();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Reset first, so choosing the same file twice in a row still fires
    e.target.value = '';
    void insertImages(files);
  }

  // Pasting an image gives a file on the clipboard; everything else falls
  // through to the browser's own paste handling.
  function handlePaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (onUploadImage && files.length > 0) {
      e.preventDefault();
      void insertImages(files);
      return;
    }
    if (pasteUrl(e)) e.preventDefault();
  }

  /**
   * A pasted URL becomes a link there and then, and raises the link bar so the
   * size can be changed without going anywhere. Returns whether it handled the
   * paste.
   *
   * The link is written immediately rather than opening a dialog: pasting is a
   * fast gesture, and the common case - a URL dropped into a sentence - should
   * cost nothing. The bar is an offer, not a question; ignore it and keep typing.
   */
  function pasteUrl(e: React.ClipboardEvent): boolean {
    const editor = ref.current;
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (!editor || !text || !isBareUrl(text)) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;

    record('struct');
    const href = normalizeUrl(text);
    // Pasting a URL over selected words links those words, which is the one
    // thing every editor agrees on. With nothing selected the URL is its own
    // label, and the bar's "edit text" is how that gets a friendlier name.
    const selected = sel.isCollapsed ? '' : sel.toString();
    if (selected) {
      document.execCommand('createLink', false, href);
    } else {
      document.execCommand('insertHTML', false,
        `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`);
    }
    emit();

    // Find what was just written and put the bar on it. The caret lands at the
    // end of the new link, so the usual lookup finds it.
    const anchor = anchorAt(editor);
    if (anchor) {
      setLinkEl(anchor);
      setLinkTextDraft(null);
      const boundsTop = scrollRef.current?.getBoundingClientRect().top ?? 0;
      setBubble(computeBubblePos(anchor.getBoundingClientRect(), boundsTop));
    }
    return true;
  }

  function handleDrop(e: React.DragEvent) {
    if (!onUploadImage) return;
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    // Drop puts the caret where the pointer is, which is what we want - but the
    // browser only moves it as part of its own default handling, which we just
    // cancelled. Take the position from the drop point instead.
    imageRange.current = rangeFromPoint(e.clientX, e.clientY);
    void insertImages(files);
  }

  // ── References ────────────────────────────────────────────────────────
  // An embed is an atomic island in the note: contenteditable="false" markup
  // that carries everything it renders on itself. Clicking one selects it and
  // the floating bar becomes its controls, where the three sizes live.
  // A card that has just appeared (inserted, or switched up to the large size)
  // wants its count now, not on the next counts fetch.
  function refreshCounts() {
    if (ref.current && commentCounts) applyCommentCounts(ref.current, commentCounts);
  }

  function openPicker() {
    const sel = window.getSelection();
    embedRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    setPickerOpen(true);
  }

  function insertEmbed(data: EmbedData, variant: EmbedVariant) {
    const editor = ref.current;
    setPickerOpen(false);
    if (!editor) return;
    restoreRange(embedRange.current);
    embedRange.current = null;
    record('struct');
    writeEmbedAtSelection(data, variant);
  }

  /**
   * Drop an embed where the selection currently is, replacing whatever it
   * covers. The caller is responsible for restoring the selection and for
   * recording history first - both the reference picker and the link dialog
   * come through here, and they stash their range in different places.
   */
  function writeEmbedAtSelection(data: EmbedData, variant: EmbedVariant) {
    const editor = ref.current;
    const sel = window.getSelection();
    if (!editor || !sel || sel.rangeCount === 0) return;
    repairBlankBlock(editor);

    const node = createEmbed(data, variant);
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(node);
    // Somewhere to carry on typing: an atomic node cannot hold a caret, so a
    // trailing embed would otherwise be impossible to get past.
    const after = document.createTextNode('\u00a0');   // a plain space here would collapse away
    node.after(after);
    // An empty block was given a filler <br> on the way in (repairBlankBlock).
    // With the embed and that space either side of it, it now draws nothing but
    // a blank line under the card.
    const trailing = after.nextSibling;
    if (trailing && trailing.nodeName === 'BR' && !trailing.nextSibling) trailing.remove();

    const caret = document.createRange();
    caret.setStart(after, 1);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    emit();
    onEmbedsChange?.(embedUrlsIn(editor));
    refreshCounts();
  }

  // Sizes are a re-render from the stored data, not a transform of the markup,
  // so switching back and forth is lossless.
  function setEmbedVariant(variant: EmbedVariant) {
    const data = embedEl && readEmbed(embedEl);
    if (!embedEl || !data) return;
    record('struct');
    const next = createEmbed(data, variant);
    embedEl.replaceWith(next);
    setEmbedEl(next);
    selectNode(next);
    emit();
    refreshCounts();
  }

  function removeEmbed() {
    const editor = ref.current;
    if (!editor || !embedEl) return;
    record('struct');
    const block = embedEl.parentElement;
    const caret = document.createRange();
    caret.setStartAfter(embedEl);
    caret.collapse(true);
    embedEl.remove();
    // A block left holding nothing renders as a collapsed line the caret can't
    // enter, so give it the usual filler.
    if (block && block !== editor && !block.firstChild) block.appendChild(document.createElement('br'));
    const sel = window.getSelection();
    if (sel && editor.contains(caret.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(caret);
    }
    setEmbedEl(null);
    setBubble(null);
    editor.focus();
    emit();
  }

  function openEmbed() {
    const a = embedEl?.querySelector('a');
    if (a) openLinkAt(a);
  }

  // ── The link bar ──────────────────────────────────────────────────────
  // A plain <a> and a 'page' card are two renderings of one thing: a URL the
  // writer pointed at. These convert between them, so the size switch on the
  // bar means the same for a link as it does for a reference.

  function closeLinkBar() {
    setLinkEl(null);
    setLinkTextDraft(null);
  }

  /** Replace the anchor the bar is on with a card of the given size. */
  async function linkToCard(variant: EmbedVariant) {
    const a = linkEl;
    const href = a?.getAttribute('href');
    if (!a || !href || !onFetchPageMeta) return;
    // The visible text is worth carrying over as the card's title - unless it is
    // just the URL again, which is what a bare paste leaves behind and would
    // make for a card titled with its own address.
    const text = (a.textContent ?? '').trim();
    const typed = text && text !== href && text !== href.replace(/^https?:\/\//, '') ? text : '';

    setLinkBusy(true);
    let meta: PageMeta = { title: null, image: null };
    try {
      meta = await onFetchPageMeta(href);
    } catch { /* the host fallback in pageEmbed covers this */ }
    setLinkBusy(false);

    // The anchor may have been edited away while the fetch was out.
    if (!a.isConnected) { closeLinkBar(); return; }
    record('struct');
    selectNode(a);
    writeEmbedAtSelection(pageEmbed(href, meta, typed), variant);
    closeLinkBar();
  }

  /** Turn a card back into the plain anchor it came from. */
  function cardToLink() {
    const data = embedEl && readEmbed(embedEl);
    if (!embedEl || !data) return;
    record('struct');
    const a = document.createElement('a');
    a.setAttribute('href', data.href || data.url);
    a.textContent = data.title || data.url;
    embedEl.replaceWith(a);
    setEmbedEl(null);
    setBubble(null);
    // Caret after the link, so typing carries on from it rather than inside it.
    const caret = document.createRange();
    caret.setStartAfter(a);
    caret.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(caret); }
    ref.current?.focus();
    emit();
  }

  /** Commit the inline text field on the link bar. */
  function applyLinkText() {
    const a = linkEl;
    if (!a || linkTextDraft === null) return;
    const next = linkTextDraft.trim();
    // An empty label would leave an invisible link nobody could click or find.
    if (next && next !== a.textContent) {
      record('struct');
      a.textContent = next;
      emit();
    }
    setLinkTextDraft(null);
    ref.current?.focus();
  }

  function removeLinkAt() {
    const a = linkEl;
    if (!a) return;
    record('struct');
    // Unwrap rather than delete: removing a link should leave the words behind.
    a.replaceWith(...Array.from(a.childNodes));
    closeLinkBar();
    setBubble(null);
    ref.current?.focus();
    emit();
  }

  // Track the selection to light up the active marks and raise the bubble.
  useEffect(() => {
    function onSelectionChange() {
      const el = ref.current;
      const sel = window.getSelection();
      if (readOnly) { setBubble(null); return; }
      if (!el || !sel || sel.rangeCount === 0) { setBubble(null); setEmbedEl(null); closeLinkBar(); return; }
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return; // selection elsewhere on the page
      setMarks(readMarks());
      setInTable(!!cellAtCaret(el));
      // An embed takes the bar over: formatting means nothing inside an atomic
      // island, and its own controls are what the selection is asking for.
      const embed = embedInSelection(el);
      setEmbedEl(embed);
      if (embed) {
        closeLinkBar();
        const boundsTop = scrollRef.current?.getBoundingClientRect().top ?? 0;
        setBubble(computeBubblePos(embed.getBoundingClientRect(), boundsTop));
        return;
      }
      // A caret resting in a link raises that link's own bar. Only when nothing
      // is selected: a selection that happens to cross a link is a request to
      // format the words, and the formatting bar is what answers it.
      const anchor = sel.isCollapsed ? anchorAt(el) : null;
      if (anchor && !embedAt(anchor, el)) {
        // The field is per-link, so moving to a different one closes it rather
        // than carrying a half-typed label across.
        if (anchor !== linkElRef.current) setLinkTextDraft(null);
        setLinkEl(anchor);
        const boundsTop = scrollRef.current?.getBoundingClientRect().top ?? 0;
        setBubble(computeBubblePos(anchor.getBoundingClientRect(), boundsTop));
        return;
      }
      closeLinkBar();
      if (sel.isCollapsed || !sel.toString().trim()) { setBubble(null); return; }
      const r = range.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) { setBubble(null); return; }
      const boundsTop = scrollRef.current?.getBoundingClientRect().top ?? 0;
      setBubble(computeBubblePos(r, boundsTop));
    }
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [readOnly]);

  // The command menu and the bubble should never be up at the same time
  useEffect(() => { if (slashOpen) setBubble(null); }, [slashOpen]);

  // …nor should the bubble sit over the link dialog
  useEffect(() => { if (linkForm) setBubble(null); }, [linkForm]);

  // Markdown shortcuts: when everything typed so far in the block is one of the
  // MD_RULES triggers, swallow it and turn the block into what it describes.
  // Returns true if it fired, so the caller skips the rest of the input pass.
  function maybeAutoformat(): boolean {
    const editor = ref.current!;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode) return false;
    if (cellAtCaret(editor)) return false;    // tables keep their cells literal

    const block = getBlock(editor);
    // Only plain paragraphs convert. Inside a list, code block, quote or to-do
    // the marker characters are content the user meant to type.
    if (!block || !/^(P|DIV)$/.test(block.nodeName)) return false;
    if (block.classList.contains(TODO_CLASS)) return false;

    const typed = document.createRange();
    typed.selectNodeContents(block);
    try { typed.setEnd(sel.anchorNode, sel.anchorOffset); } catch { return false; }
    const before = typed.toString();

    const rule = MD_RULES.find(r => r.re.test(before));
    if (!rule) return false;

    // Drop the marker text, then apply the block command to the empty line
    typed.deleteContents();
    const caret = document.createRange();
    caret.setStart(typed.startContainer, typed.startOffset);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    applyBlock(rule.id);
    return true;
  }

  function handleInput() {
    const editor = ref.current!;
    const sel = window.getSelection();

    if (!slashOpenRef.current && maybeAutoformat()) return;   // applyBlock emits

    if (slashOpenRef.current && slashInfo.current) {
      // Track the query typed after "/"
      const { node, offset } = slashInfo.current;
      if (!sel || sel.anchorNode !== node || sel.anchorOffset <= offset) { closeSlash(); }
      else {
        const text = node.textContent ?? '';
        const q = text.substring(offset + 1, sel.anchorOffset);
        if (/\s/.test(q)) closeSlash();
        else { setSlashQuery(q); setSlashIdx(0); }
      }
    } else if (sel && sel.isCollapsed && sel.anchorNode) {
      // Confluence-style: open when "/" is typed at the start of a line/text
      // node or right after whitespace (not mid-word, e.g. "and/or").
      const node = sel.anchorNode;
      const off = sel.anchorOffset;
      if (node.nodeType === Node.TEXT_NODE && off > 0 && node.textContent![off - 1] === '/') {
        const prev = off >= 2 ? node.textContent![off - 2] : '';
        if (prev === '' || /\s/.test(prev)) {
          slashInfo.current = { node, offset: off - 1 };
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          const base = rect && rect.height ? rect : (getBlock(editor)?.getBoundingClientRect() ?? rect);
          setMenuPos(computeMenuPos(base));
          setSlashOpen(true);
          setSlashQuery('');
          setSlashIdx(0);
        }
      }
    }

    emit();
  }

  function stripSlash() {
    const info = slashInfo.current;
    const sel = window.getSelection();
    if (!info || !sel || sel.rangeCount === 0) return;
    const del = document.createRange();
    try {
      del.setStart(info.node, info.offset);
      del.setEnd(sel.anchorNode!, sel.anchorOffset);
      del.deleteContents();
    } catch { return; }
    // deleteContents collapses the range to its start and re-homes the boundary
    // if the text node was removed entirely (empty line) - so use the range's
    // own (now-valid) boundary rather than the possibly-detached stored node.
    sel.removeAllRanges();
    const c = document.createRange();
    c.setStart(del.startContainer, del.startOffset);
    c.collapse(true);
    sel.addRange(c);
  }

  function makeTodo(block: HTMLElement) {
    const div = document.createElement('div');
    div.className = TODO_CLASS;
    div.setAttribute('data-checked', 'false');
    while (block.firstChild) div.appendChild(block.firstChild);
    if (!div.firstChild) div.appendChild(document.createElement('br'));
    block.replaceWith(div);
    placeCaret(div, true);
  }

  // ── Table commands ────────────────────────────────────────────────────
  function insertTable() {
    const editor = ref.current!;
    const table = buildTable(2, 3);

    const openCell = cellAtCaret(editor);
    if (openCell) {
      // Asking for a table from inside one adds it after, never nested within
      openCell.closest(`table.${TABLE_CLASS}`)!.after(table);
    } else {
      const block = repairBlankBlock(editor) ?? getBlock(editor);
      // Drop the table onto an empty paragraph rather than leaving a blank line
      // above it; otherwise it goes after the current block.
      if (block && isBlank(block)) block.replaceWith(table);
      else if (block) block.after(table);
      else editor.appendChild(table);
    }

    // Always leave somewhere to type after the table - a trailing table is
    // otherwise impossible to escape with the caret.
    if (!table.nextElementSibling) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      table.after(p);
    }
    const first = table.querySelector('th, td') as HTMLTableCellElement | null;
    if (first) focusCell(first);
    setInTable(true);
  }

  // Tab walks the cells in reading order; Tab out of the last cell grows the
  // table by a row, the way a spreadsheet does.
  function moveCell(delta: 1 | -1) {
    const editor = ref.current!;
    const cell = cellAtCaret(editor);
    if (!cell) return;
    const table = cell.closest(`table.${TABLE_CLASS}`) as HTMLTableElement;
    const cells = cellsOf(table);
    const i = cells.indexOf(cell);
    const next = cells[i + delta];
    if (next) { focusCell(next); return; }
    if (delta < 0) return; // at the very first cell - stay put
    const tbody = table.tBodies[0] ?? table;
    const row = buildRow(columnCount(table), 'td');
    tbody.appendChild(row);
    focusCell(row.cells[0]);
    emit();
  }

  function addRow(after: boolean) {
    const editor = ref.current!;
    const cell = cellAtCaret(editor);
    if (!cell) return;
    record('struct');
    const table = cell.closest(`table.${TABLE_CLASS}`) as HTMLTableElement;
    const tr = cell.parentElement as HTMLTableRowElement;
    const row = buildRow(columnCount(table), 'td');
    // A row can't be added above the header - it would become the new header
    // row visually while still holding <td>s, so it lands below instead.
    const inHead = tr.parentElement === table.tHead;
    if (after || inHead) {
      if (inHead) (table.tBodies[0] ?? table).prepend(row);
      else tr.after(row);
    } else tr.before(row);
    focusCell(row.cells[0]);
    emit();
  }

  function addColumn(after: boolean) {
    const editor = ref.current!;
    const cell = cellAtCaret(editor);
    if (!cell) return;
    record('struct');
    const table = cell.closest(`table.${TABLE_CLASS}`) as HTMLTableElement;
    const at = cell.cellIndex + (after ? 1 : 0);
    Array.from(table.rows).forEach(tr => {
      const tag = tr.parentElement === table.tHead ? 'th' : 'td';
      const fresh = buildCell(tag);
      const ref_ = tr.cells[at];
      if (ref_) tr.insertBefore(fresh, ref_);
      else tr.appendChild(fresh);
    });
    focusCell(cell.parentElement!.children[at] as HTMLTableCellElement);
    emit();
  }

  function deleteRow() {
    const editor = ref.current!;
    const cell = cellAtCaret(editor);
    if (!cell) return;
    record('struct');
    const table = cell.closest(`table.${TABLE_CLASS}`) as HTMLTableElement;
    const tr = cell.parentElement as HTMLTableRowElement;
    if (tr.parentElement === table.tHead) return; // the header row stays
    const fallback = (tr.nextElementSibling ?? tr.previousElementSibling) as HTMLTableRowElement | null;
    tr.remove();
    if (fallback) focusCell(fallback.cells[0]);
    else focusCell(table.rows[0].cells[0]);
    emit();
  }

  function deleteColumn() {
    const editor = ref.current!;
    const cell = cellAtCaret(editor);
    if (!cell) return;
    const table = cell.closest(`table.${TABLE_CLASS}`) as HTMLTableElement;
    if (columnCount(table) <= 1) { deleteTable(); return; }   // deleteTable records
    record('struct');
    const at = cell.cellIndex;
    Array.from(table.rows).forEach(tr => tr.cells[at]?.remove());
    const row = table.rows[0];
    focusCell(row.cells[Math.min(at, row.cells.length - 1)]);
    emit();
  }

  function deleteTable() {
    const editor = ref.current!;
    const cell = cellAtCaret(editor);
    if (!cell) return;
    record('struct');
    const table = cell.closest(`table.${TABLE_CLASS}`) as HTMLTableElement;
    let landing = table.nextElementSibling as HTMLElement | null;
    if (!landing) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      table.after(p);
      landing = p;
    }
    table.remove();
    placeCaret(landing, true);
    setInTable(false);
    editor.focus();
    emit();
  }

  function applyCmd(cmd: Cmd) {
    // Insert-image opens a file picker rather than transforming a block. The
    // "/image" text has to be cleared here, before the picker takes focus -
    // once it has, there is no selection left to strip.
    if (cmd.id === 'image') {
      ref.current?.focus();
      if (slashInfo.current) stripSlash();
      closeSlash();
      emit();
      pickImage();
      return;
    }
    // Same story for /reference: the picker's search field takes focus, so the
    // "/reference" text has to go before it opens.
    if (cmd.id === 'reference') {
      ref.current?.focus();
      if (slashInfo.current) stripSlash();
      closeSlash();
      emit();
      openPicker();
      return;
    }
    if (cmd.kind === 'inline') applyInline(cmd.id as InlineId);
    else applyBlock(cmd.id as BlockId);
  }

  // Inline marks from the slash menu act on a collapsed caret: execCommand
  // flips the typing state, so whatever the user types next comes out styled.
  function applyInline(id: InlineId) {
    const editor = ref.current!;
    editor.focus();
    if (id !== 'link') record('struct');   // the link dialog records on submit
    if (slashInfo.current) stripSlash();
    repairBlankBlock(editor);
    switch (id) {
      case 'bold':       document.execCommand('bold'); break;
      case 'italic':     document.execCommand('italic'); break;
      case 'underline':  document.execCommand('underline'); break;
      case 'strike':     document.execCommand('strikeThrough'); break;
      case 'inlinecode': toggleInlineCode(); break;
      case 'clear':      document.execCommand('removeFormat'); break;
      case 'link':       closeSlash(); applyLink(); return;
    }
    closeSlash();
    setMarks(readMarks());
    emit();
  }

  // No execCommand for <code>, so wrap the selection by hand. With nothing
  // selected, drop in an empty code span and park the caret inside it.
  function toggleInlineCode() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const existing = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement)?.closest('code');
    if (existing) { // unwrap
      const parent = existing.parentNode!;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
      return;
    }
    const code = document.createElement('code');
    if (sel.isCollapsed) {
      code.appendChild(document.createTextNode('​')); // keeps the span selectable
      range.insertNode(code);
      placeCaret(code, false);
    } else {
      code.appendChild(range.extractContents());
      range.insertNode(code);
      placeCaret(code, false);
    }
  }

  function applyBlock(id: BlockId) {
    const editor = ref.current!;
    editor.focus();
    record('struct');
    if (slashInfo.current) stripSlash();

    const block = repairBlankBlock(editor) ?? getBlock(editor);

    switch (id) {
      case 'text':  document.execCommand('formatBlock', false, '<P>'); break;
      case 'h1':    document.execCommand('formatBlock', false, '<H1>'); break;
      case 'h2':    document.execCommand('formatBlock', false, '<H2>'); break;
      case 'h3':    document.execCommand('formatBlock', false, '<H3>'); break;
      case 'ul':
      case 'ol': {
        // Clear out any malformed list left over from earlier editing first -
        // running the command over one is what produces text-in-a-list.
        normalizeLists(editor);
        // A to-do is a block in its own right: turning one into a list has to
        // replace it, or the list ends up inside the to-do div and inherits its
        // `list-style: none` - indented, but with no bullet in sight.
        if (block?.classList.contains(TODO_CLASS)) {
          const p = document.createElement('p');
          while (block.firstChild) p.appendChild(block.firstChild);
          if (!p.firstChild) p.appendChild(document.createElement('br'));
          block.replaceWith(p);
          placeCaret(p, false);
        }
        document.execCommand(id === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
        // Chrome leaves the new list nested inside the block it replaced - a
        // <p>, or the bare <div> it drops when you exit a previous list. That
        // renders, but re-parsing the saved HTML hoists the list out and
        // strands an empty block, so unwrap it now.
        const b = getBlock(editor);
        if (b && /^(P|DIV)$/.test(b.nodeName) && !b.classList.contains(TODO_CLASS) &&
            b.children.length === 1 &&
            /^(UL|OL)$/.test(b.firstElementChild!.nodeName)) {
          const list = b.firstElementChild as HTMLElement;
          b.replaceWith(list);
          const li = list.querySelector('li');
          if (li) placeCaret(li, false);
        }
        // …and again afterwards: a browser that emits a list holding raw text
        // instead of items would otherwise leave the note markerless until
        // something else happened to trigger a repair.
        normalizeLists(editor);
        break;
      }
      case 'quote': document.execCommand('formatBlock', false, '<BLOCKQUOTE>'); break;
      case 'code':  document.execCommand('formatBlock', false, '<PRE>'); break;
      case 'todo':  if (block) makeTodo(block); break;
      case 'table': insertTable(); break;
      case 'hr': {
        document.execCommand('insertHorizontalRule');
        // Guarantee an editable paragraph after the rule
        if (editor.lastElementChild?.tagName === 'HR') {
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          editor.appendChild(p);
          placeCaret(p, true);
        }
        break;
      }
    }
    closeSlash();
    emit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => (i + 1) % Math.max(filtered.length, 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx(i => (i - 1 + filtered.length) % Math.max(filtered.length, 1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (filtered[slashIdx]) applyCmd(filtered[slashIdx]); return; }
      // stopPropagation keeps the console's Escape-to-close from also firing -
      // the first Escape should only dismiss this menu
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
      if (e.key === 'Backspace') {
        // Backspacing over the "/" closes the menu (native delete still runs)
        const info = slashInfo.current;
        const sel = window.getSelection();
        if (info && sel && sel.anchorOffset <= info.offset + 1) closeSlash();
        return;
      }
      return;
    }

    // Undo/redo - driven by our own history so the editor's DOM edits (indent,
    // to-do splits, table ops) are undoable, which native contentEditable can't.
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }

    // Find & replace. Both modifiers are accepted, as everywhere else here, but
    // e.code carries the physical key: on a Mac, Option+F types "ƒ", so the
    // Find-and-replace chord (⌥⌘F) would otherwise not be recognisable.
    if (findable && mod && (e.code === 'KeyF' || e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFind(e.altKey);   // ⌥⌘F is the macOS chord for find *and replace*
      return;
    }
    if (findable && mod && (e.code === 'KeyH' || e.key === 'h' || e.key === 'H')) {
      e.preventDefault();   // Ctrl+H is the Windows/Linux one
      openFind(true);
      return;
    }
    // With the bar open, Escape belongs to it before it belongs to whatever is
    // hosting the editor - the notes console closes on Escape, and dismissing
    // the search should not also close the note. Same claim the slash menu makes.
    if (findOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
      return;
    }
    // Step through hits without going back to the field (F3 is the native
    // binding; Ctrl/Cmd+G is the one Mac and most editors use).
    if (findOpen && (e.key === 'F3' || (mod && (e.code === 'KeyG' || e.key === 'g' || e.key === 'G')))) {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
      return;
    }

    const editor = ref.current!;

    // Inside a table: Tab walks cells, Enter stays in the cell as a line break
    // (the browser's default would split the cell into stray divs).
    const cell = cellAtCaret(editor);
    if (cell) {
      if (e.key === 'Tab') { e.preventDefault(); record('struct'); moveCell(e.shiftKey ? -1 : 1); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); record('struct'); document.execCommand('insertLineBreak'); emit(); return; }
    }

    const block = getBlock(editor);

    // Tab indents rather than walking focus out of the note. Lists nest for
    // real (so numbering restarts on the sub-list); every other block steps
    // through data-indent, and a code block takes a literal tab.
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!block) return;
      record('struct');
      if (/^(UL|OL)$/.test(block.nodeName)) {
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        normalizeLists(editor);   // browsers nest the sub-list beside the item, not inside it
      } else if (block.nodeName === 'PRE') {
        document.execCommand('insertText', false, '\t');
      } else {
        indentBlock(block, e.shiftKey ? -1 : 1);
      }
      emit();
      return;
    }

    // To-do list behaviour: Enter continues the list; Enter on an empty item or
    // Backspace at its start exits back to a paragraph.
    if (block && block.classList.contains(TODO_CLASS)) {
      if (e.key === 'Enter') {
        e.preventDefault();
        record('struct');
        const empty = !(block.textContent ?? '').trim();
        if (empty) {
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          block.replaceWith(p);
          placeCaret(p, true);
        } else {
          const nd = document.createElement('div');
          nd.className = TODO_CLASS;
          nd.setAttribute('data-checked', 'false');
          // Carry the indent across, so a nested task list keeps its shape
          const depth = block.getAttribute(INDENT_ATTR);
          if (depth) nd.setAttribute(INDENT_ATTR, depth);
          // Split at the caret: everything from the caret to the end of the line
          // moves down into the new to-do, so Enter mid-text pushes the tail
          // down rather than dropping it.
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            const caret = sel.getRangeAt(0);
            const tail = document.createRange();
            tail.setStart(caret.endContainer, caret.endOffset);
            tail.setEnd(block, block.childNodes.length);
            nd.appendChild(tail.extractContents());
          }
          if (!nd.firstChild || !(nd.textContent ?? '').length) {
            while (nd.firstChild) nd.removeChild(nd.firstChild);
            nd.appendChild(document.createElement('br'));   // caret was at the end
          }
          if (!block.firstChild) block.appendChild(document.createElement('br'));
          block.after(nd);
          placeCaret(nd, true);
        }
        emit();
        return;
      }
      if (e.key === 'Backspace' && caretAtBlockStart(block)) {
        e.preventDefault();
        record('struct');
        const p = document.createElement('p');
        while (block.firstChild) p.appendChild(block.firstChild);
        if (!p.firstChild) p.appendChild(document.createElement('br'));
        block.replaceWith(p);
        placeCaret(p, true);
        emit();
        return;
      }
    }

    // Quote / code block: Enter adds a line; a second Enter (or Enter on an
    // already-blank last line) exits to a fresh paragraph, like a bullet list.
    if (block && (block.nodeName === 'BLOCKQUOTE' || block.nodeName === 'PRE') && e.key === 'Enter') {
      e.preventDefault();
      record('struct');
      if (caretAtBlockEnd(block) && currentLineEmpty()) {
        while (block.lastChild && (block.lastChild as HTMLElement).nodeName === 'BR') {
          block.removeChild(block.lastChild);
        }
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        block.after(p);
        if (!(block.textContent ?? '').trim()) block.remove();
        placeCaret(p, true);
      } else {
        document.execCommand('insertLineBreak');
      }
      emit();
      return;
    }
  }

  // Open a link on Ctrl/Cmd-click (a plain click keeps placing the caret, so the
  // link's text can still be edited). A middle-click (auxclick) opens it too.
  function openLinkAt(target: HTMLElement): boolean {
    const a = target.closest('a');
    const href = a?.getAttribute('href');
    if (!href || /^(javascript|data|vbscript):/i.test(href.trim())) return false;
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  }

  // Toggle a to-do checkbox when its box (the left gutter) is clicked.
  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if ((e.metaKey || e.ctrlKey) && openLinkAt(target)) { e.preventDefault(); return; }
    // An embed's anchor would otherwise navigate the whole app out from under
    // the note. A plain click selects it - the bar's Open (or Ctrl-click, just
    // handled) is how you follow it.
    const embed = embedAt(target, ref.current!);
    if (embed) { e.preventDefault(); selectNode(embed); return; }
    const todo = target.closest(`.${TODO_CLASS}`) as HTMLElement | null;
    if (!todo) return;
    const rect = todo.getBoundingClientRect();
    if (e.clientX - rect.left <= 24) {
      record('struct');
      const checked = todo.getAttribute('data-checked') === 'true';
      todo.setAttribute('data-checked', checked ? 'false' : 'true');
      emit();
    }
  }

  const inlineBtns = (
    <>
      <TBtn title="Bold (Ctrl+B)"      active={marks.bold}      onRun={() => execInline('bold')}><b>B</b></TBtn>
      <TBtn title="Italic (Ctrl+I)"    active={marks.italic}    onRun={() => execInline('italic')}><i>I</i></TBtn>
      <TBtn title="Underline (Ctrl+U)" active={marks.underline} onRun={() => execInline('underline')}><u>U</u></TBtn>
      <TBtn title="Strikethrough"      active={marks.strike}    onRun={() => execInline('strikeThrough')}><s>S</s></TBtn>
    </>
  );

  // Link, divider and clear formatting travel together as the "insert & strip"
  // group at the end of the bar
  const linkBtns = (
    <>
      <TBtn title="Add link" onRun={applyLink}><LinkIcon /></TBtn>
      {onUploadImage && (
        <TBtn
          title={uploading ? 'Uploading…' : 'Insert image - or paste and drop one'}
          onRun={pickImage}
          disabled={uploading}
        >
          <ImageIcon />
        </TBtn>
      )}
      {references && (
        <TBtn title="Reference a saved article" onRun={openPicker}><ReferenceIcon /></TBtn>
      )}
      <TBtn title="Divider" onRun={() => applyBlock('hr')}><DividerIcon /></TBtn>
      <TBtn title="Clear formatting" onRun={() => execInline('removeFormat')}><ClearIcon /></TBtn>
    </>
  );

  // What the floating bar offers when the selection is an embed: the three
  // sizes, then the two things you can do with the thing itself.
  //
  // A 'page' card is a link the writer chose to show large, so its smallest
  // size is a real anchor rather than the inline chip a reference uses - three
  // states for a URL, matching the link dialog exactly. The library kinds keep
  // the chip, which is a reference to something, not a sentence to read.
  const isPageCard = !!embedEl && readEmbed(embedEl)?.kind === 'page';
  const embedBtns = embedEl && (
    <>
      <span className={styles.tbGroupLabel}>Size</span>
      {isPageCard ? (
        <TBtn title="Text - a plain link in the sentence" onRun={cardToLink}><LinkIcon /></TBtn>
      ) : (
        <TBtn title="Just a link" active={variantOf(embedEl) === 'link'} onRun={() => setEmbedVariant('link')}><LinkIcon /></TBtn>
      )}
      <TBtn title="Small card"   active={variantOf(embedEl) === 'small'} onRun={() => setEmbedVariant('small')}><SmallCardIcon /></TBtn>
      <TBtn title="Large card"   active={variantOf(embedEl) === 'large'} onRun={() => setEmbedVariant('large')}><LargeCardIcon /></TBtn>
      <span className={styles.tbSep} />
      <WordBtn title={isPageCard ? 'Open this link' : 'Open this reference'} onRun={openEmbed}>Open</WordBtn>
      <WordBtn title={isPageCard ? 'Remove this card' : 'Remove this reference'} onRun={removeEmbed} danger>Remove</WordBtn>
    </>
  );

  // ── The link bar ──
  // The same shape as the embed bar above, because a link is the same kind of
  // object: something with a size and a label. Editing the label happens in
  // place - a dialog for one field is a lot of ceremony for renaming a link.
  const linkBarBtns = !embedEl && linkEl && (
    linkTextDraft !== null ? (
      <>
        <input
          className={styles.linkTextInput}
          value={linkTextDraft}
          autoFocus
          onChange={ev => setLinkTextDraft(ev.target.value)}
          onKeyDown={ev => {
            ev.stopPropagation();   // the console's Escape must not close the note
            if (ev.key === 'Enter') { ev.preventDefault(); applyLinkText(); }
            if (ev.key === 'Escape') { ev.preventDefault(); setLinkTextDraft(null); }
          }}
          placeholder="Link text"
          aria-label="Link text"
          spellCheck={false}
        />
        <WordBtn title="Save this text (Enter)" onRun={applyLinkText}>Save</WordBtn>
        <WordBtn title="Discard (Esc)" onRun={() => setLinkTextDraft(null)}>Cancel</WordBtn>
      </>
    ) : (
      <>
        <span className={styles.tbGroupLabel}>Size</span>
        <TBtn title="Text - a plain link in the sentence" active onRun={() => { /* already text */ }}>
          <LinkIcon />
        </TBtn>
        {onFetchPageMeta && (
          <>
            <TBtn title={linkBusy ? 'Reading page…' : 'Small card'} disabled={linkBusy} onRun={() => void linkToCard('small')}>
              <SmallCardIcon />
            </TBtn>
            <TBtn title={linkBusy ? 'Reading page…' : 'Large card'} disabled={linkBusy} onRun={() => void linkToCard('large')}>
              <LargeCardIcon />
            </TBtn>
          </>
        )}
        <span className={styles.tbSep} />
        <WordBtn
          title="Change the words this link shows"
          onRun={() => setLinkTextDraft(linkEl.textContent ?? '')}
        >
          Edit text
        </WordBtn>
        <WordBtn title="Change the address" onRun={applyLink}>Edit link</WordBtn>
        <WordBtn title="Unlink - keeps the words" onRun={removeLinkAt} danger>Remove</WordBtn>
      </>
    )
  );

  // A trashed note is shown as it was written: no toolbars, no command menu,
  // and the surface itself isn't editable.
  if (readOnly) {
    return (
      <div className={styles.editorScroll} ref={scrollRef}>
        <div
          ref={ref}
          className={`${styles.editor} ${styles.editorReadOnly}`}
          // Links are live here (this surface isn't editable), so a plain click
          // opens them in a new tab rather than navigating the page out from
          // under the note.
          onClick={e => { if (openLinkAt(e.target as HTMLElement)) e.preventDefault(); }}
        />
      </div>
    );
  }

  return (
    <>
      {/* ── Utility bar ── */}
      <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
        {inlineBtns}
        <span className={styles.tbSep} />
        <TBtn title="Heading 1" onRun={() => applyBlock('h1')}>H1</TBtn>
        <TBtn title="Heading 2" onRun={() => applyBlock('h2')}>H2</TBtn>
        <TBtn title="Heading 3" onRun={() => applyBlock('h3')}>H3</TBtn>
        <TBtn title="Plain text" onRun={() => applyBlock('text')}>¶</TBtn>
        <span className={styles.tbSep} />
        <TBtn title="Bullet list"   onRun={() => applyBlock('ul')}>•</TBtn>
        <TBtn title="Numbered list" onRun={() => applyBlock('ol')}>1.</TBtn>
        <TBtn title="To-do"         onRun={() => applyBlock('todo')}>☐</TBtn>
        <span className={styles.tbSep} />
        <TBtn title="Quote"      onRun={() => applyBlock('quote')}><QuoteIcon /></TBtn>
        <TBtn title="Code block" onRun={() => applyBlock('code')}><CodeIcon /></TBtn>
        <TBtn title="Table"      onRun={() => applyBlock('table')}><TableIcon /></TBtn>
        <span className={styles.tbSep} />
        {linkBtns}

        {/* Row/column controls appear only while the caret is in a table. They
            take a row of their own - spelled out they'd wrap raggedly into the
            formatting buttons, and the caret can only ever be in one table. */}
        {inTable && (
          <div className={styles.tbTableRow}>
            <span className={styles.tbGroupLabel}>Table</span>
            <WordBtn title="Insert a row below this one"     onRun={() => addRow(true)}>Add row</WordBtn>
            <WordBtn title="Insert a column to the right"    onRun={() => addColumn(true)}>Add column</WordBtn>
            <WordBtn title="Delete the row the caret is in"  onRun={deleteRow} danger>Delete row</WordBtn>
            <WordBtn title="Delete the column the caret is in" onRun={deleteColumn} danger>Delete column</WordBtn>
            <WordBtn title="Remove the whole table" onRun={deleteTable} danger chip>
              <TrashIcon />Delete table
            </WordBtn>
          </div>
        )}
      </div>

      {/* ── Find & replace ──
          Sits under the toolbar rather than floating over the text: it is open
          for as long as a search lasts, and a panel that covers the words being
          searched is its own obstacle. */}
      {findOpen && (
        <div className={styles.findBar} role="search" aria-label="Find and replace">
          <button
            className={styles.findToggle}
            onClick={() => setReplaceOpen(o => !o)}
            title={replaceOpen ? 'Hide replace' : 'Show replace'}
            aria-expanded={replaceOpen}
            aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
          >
            <svg
              className={`${styles.findToggleIcon} ${replaceOpen ? styles.findToggleIconOpen : ''}`}
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <div className={styles.findFields}>
            <div className={styles.findRow}>
              <span className={styles.findInputWrap}>
                <input
                  ref={findInputRef}
                  className={`${styles.findInput} ${findQuery && !findHits.count ? styles.findInputEmpty : ''}`}
                  value={findQuery}
                  onChange={e => setFindQuery(e.target.value)}
                  onKeyDown={handleFindKey}
                  placeholder="Find"
                  aria-label="Find"
                  spellCheck={false}
                />
                <span className={styles.findCount} aria-live="polite">
                  {findQuery ? `${findHits.count ? findHits.index + 1 : 0}/${findHits.count}` : ''}
                </span>
              </span>

              <button
                className={styles.findBtn}
                onClick={() => gotoMatch(-1)}
                disabled={!findHits.count}
                title="Previous match (Shift+Enter)"
                aria-label="Previous match"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 15l-6-6-6 6" />
                </svg>
              </button>
              <button
                className={styles.findBtn}
                onClick={() => gotoMatch(1)}
                disabled={!findHits.count}
                title="Next match (Enter)"
                aria-label="Next match"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              <button
                className={`${styles.findBtn} ${styles.findFlag} ${findOpts.caseSensitive ? styles.findFlagOn : ''}`}
                onClick={() => setFindOpts(o => ({ ...o, caseSensitive: !o.caseSensitive }))}
                title="Match case"
                aria-pressed={!!findOpts.caseSensitive}
              >
                Aa
              </button>
              <button
                className={`${styles.findBtn} ${styles.findFlag} ${findOpts.wholeWord ? styles.findFlagOn : ''}`}
                onClick={() => setFindOpts(o => ({ ...o, wholeWord: !o.wholeWord }))}
                title="Whole word only"
                aria-pressed={!!findOpts.wholeWord}
              >
                ab|
              </button>
            </div>

            {replaceOpen && (
              <div className={styles.findRow}>
                <span className={styles.findInputWrap}>
                  <input
                    className={styles.findInput}
                    value={replaceWith}
                    onChange={e => setReplaceWith(e.target.value)}
                    onKeyDown={handleFindKey}
                    placeholder="Replace with"
                    aria-label="Replace with"
                    spellCheck={false}
                  />
                </span>
                <button
                  className={styles.findBtn}
                  onClick={replaceCurrent}
                  disabled={!findHits.count}
                  title="Replace this match"
                >
                  Replace
                </button>
                <button
                  className={styles.findBtn}
                  onClick={replaceEvery}
                  disabled={!findHits.count}
                  title="Replace every match - one undo puts them all back"
                >
                  All
                </button>
              </div>
            )}
          </div>

          <button
            className={styles.findClose}
            onClick={closeFind}
            title="Close find (Esc)"
            aria-label="Close find"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M1 1l10 10M11 1L1 11" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Selection bubble ──
          One bar, two jobs: formatting for a run of text, and the embed's own
          controls when the selection is an atomic island instead. */}
      {bubble && createPortal(
        <div ref={bubbleRef} className={styles.bubble} style={{ left: bubble.left, top: bubble.top }}>
          {embedBtns || linkBarBtns || (
            <>
              {inlineBtns}
              <span className={styles.tbSep} />
              <TBtn title="Heading 2" onRun={() => applyBlock('h2')}>H2</TBtn>
              <TBtn title="Quote" onRun={() => applyBlock('quote')}><QuoteIcon /></TBtn>
              <span className={styles.tbSep} />
              {linkBtns}
            </>
          )}
        </div>,
        document.body
      )}

    <div className={styles.editorScroll} ref={scrollRef}>
      <div
        ref={ref}
        className={styles.editor}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onClick={handleClick}
        onAuxClick={e => { if (e.button === 1 && openLinkAt(e.target as HTMLElement)) e.preventDefault(); }}
        onPaste={handlePaste}
        onDrop={handleDrop}
        // Without this the browser navigates away to the dropped file
        onDragOver={e => { if (onUploadImage && e.dataTransfer?.types.includes('Files')) e.preventDefault(); }}
        onBlur={emit}
        data-placeholder="Type / for commands, or just start writing…"
      />

      {onUploadImage && (
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES}
          multiple
          hidden
          onChange={onFileChosen}
        />
      )}

      {/* Upload feedback sits under the text rather than over it, so it never
          covers what is being written. Both states are transient. */}
      {uploading && <div className={styles.uploadNote}>Uploading image…</div>}
      {uploadError && (
        <div className={styles.uploadError} role="alert">
          {uploadError}
          <button className={styles.uploadDismiss} onClick={() => setUploadError(null)}>Dismiss</button>
        </div>
      )}

      {/* Portaled to <body> so its position:fixed resolves against the viewport
          - the console shell keeps a transform (animation fill), which would
          otherwise become the containing block and mis-place the menu. */}
      {slashOpen && createPortal(
        <div
          ref={menuRef}
          className={styles.slashMenu}
          style={{
            left: menuPos.left,
            top: menuPos.top ?? undefined,
            bottom: menuPos.bottom ?? undefined,
            maxHeight: menuPos.maxHeight,
          }}
        >
          {filtered.length === 0 && (
            <div className={styles.slashEmpty}>No match for “{slashQuery}”</div>
          )}
          {filtered.map((cmd, i) => (
            <Fragment key={cmd.id}>
              {(i === 0 || filtered[i - 1].kind !== cmd.kind) && (
                <div className={styles.slashHint}>{cmd.kind === 'block' ? 'Blocks' : 'Format'}</div>
              )}
              <button
                className={`${styles.slashItem} ${i === slashIdx ? styles.slashItemSel : ''}`}
                onMouseDown={e => { e.preventDefault(); applyCmd(cmd); }}
                onMouseEnter={() => setSlashIdx(i)}
              >
                <span className={styles.slashBadge}>{cmd.badge}</span>
                <span className={styles.slashLabel}>{cmd.label}</span>
                <span className={styles.slashHintText}>{cmd.hint}</span>
              </button>
            </Fragment>
          ))}
        </div>,
        document.body
      )}
    </div>

    {linkForm && createPortal(
      <LinkDialog
        form={linkForm}
        canCard={!!onFetchPageMeta}
        busy={linkBusy}
        onChange={setLinkForm}
        onSubmit={submitLink}
        onRemove={removeLink}
        onCancel={closeLink}
      />,
      document.body
    )}

    {pickerOpen && references && createPortal(
      <ReferencePicker
        items={references}
        onPick={insertEmbed}
        onCancel={() => { setPickerOpen(false); restoreRange(embedRange.current); }}
      />,
      document.body
    )}
    </>
  );
}

// ── Reference picker ────────────────────────────────────────────────────
// Search the saved articles and choose one. The size chosen here is only the
// starting point - selecting the embed afterwards switches between the three
// without losing anything, so this defaults to the middle one and gets out of
// the way. Escape is swallowed so it dismisses the picker, not the console.
function ReferencePicker({ items, onPick, onCancel }: {
  items: EmbedData[];
  onPick: (data: EmbedData, variant: EmbedVariant) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const [variant, setVariant] = useState<EmbedVariant>('small');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = items.filter(d => embedMatches(d, query));
  // A filter that drops the highlighted row would otherwise leave the selection
  // pointing past the end, and Enter would insert nothing.
  const sel = Math.min(idx, Math.max(results.length - 1, 0));

  // Keep the keyboard cursor in view - the list scrolls well past the dialog.
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, query]);

  function onKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter' && results[sel]) { e.preventDefault(); onPick(results[sel], variant); }
  }

  return (
    <div className={styles.linkOverlay} onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={styles.refDialog} onKeyDown={onKeyDown} role="dialog" aria-label="Reference a saved article">
        <div className={styles.linkTitle}>Reference</div>

        <input
          ref={inputRef}
          className={styles.linkInput}
          value={query}
          onChange={e => { setQuery(e.target.value); setIdx(0); }}
          placeholder="Search saved articles"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search saved articles"
        />

        <div className={styles.refList} ref={listRef}>
          {results.length === 0 && (
            <div className={styles.refEmpty}>
              {items.length === 0
                ? 'Nothing saved to reference yet - add an article to your reading list first.'
                : `No saved article matches “${query.trim()}”`}
            </div>
          )}
          {results.map((d, i) => (
            <button
              key={d.href}
              data-sel={i === sel}
              className={`${styles.refItem} ${i === sel ? styles.refItemSel : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => onPick(d, variant)}
            >
              {d.image
                ? <img className={styles.refThumb} src={d.image} alt="" loading="lazy" />
                : <span className={styles.refThumbBlank} aria-hidden="true" />}
              <span className={styles.refText}>
                <span className={styles.refTitle}>{d.title}</span>
                <span className={styles.refMeta}>
                  {[d.source, d.meta].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className={styles.linkActions}>
          <span className={styles.linkLabel}>Show as</span>
          <div className={styles.refSizes} role="group" aria-label="Embed size">
            <SizeBtn label="Link"  on={variant === 'link'}  onRun={() => setVariant('link')}><LinkIcon /></SizeBtn>
            <SizeBtn label="Small" on={variant === 'small'} onRun={() => setVariant('small')}><SmallCardIcon /></SizeBtn>
            <SizeBtn label="Large" on={variant === 'large'} onRun={() => setVariant('large')}><LargeCardIcon /></SizeBtn>
          </div>
          <span className={styles.linkSpacer} />
          <button className={styles.linkCancel} onClick={onCancel}>Cancel</button>
          <button
            className={styles.linkApply}
            onClick={() => results[sel] && onPick(results[sel], variant)}
            disabled={!results[sel]}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}

// Segmented size choice in the picker - spelled out, since this is where the
// three sizes are met for the first time.
function SizeBtn({ label, on, onRun, children }: {
  label: string; on: boolean; onRun: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${styles.refSize} ${on ? styles.refSizeOn : ''}`}
      aria-pressed={on}
      onClick={onRun}
    >
      {children}{label}
    </button>
  );
}

// ── Link dialog ─────────────────────────────────────────────────────────
// Text and URL together, inside the console - Escape is swallowed here so it
// dismisses the dialog rather than the whole notes window behind it.
function LinkDialog({ form, canCard, busy, onChange, onSubmit, onRemove, onCancel }: {
  form: LinkForm;
  canCard: boolean;   // the host supplied a metadata reader, so cards are possible
  busy: boolean;
  onChange: (f: LinkForm) => void;
  onSubmit: (f: LinkForm) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const urlRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const isCard = form.variant !== 'link';

  // Land on the field that still needs filling in
  useEffect(() => {
    const el = form.url ? textRef.current : urlRef.current;
    el?.focus();
    el?.select();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = !!normalizeUrl(form.url);

  function onKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    if (e.key === 'Enter' && valid) { e.preventDefault(); onSubmit(form); }
  }

  return (
    <div className={styles.linkOverlay} onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={styles.linkDialog} onKeyDown={onKeyDown} role="dialog" aria-label="Link">
        <div className={styles.linkTitle}>{form.editing ? 'Edit link' : 'Add link'}</div>

        <label className={styles.linkField}>
          {/* A card carries a heading rather than a run of link text, and it
              falls back to the page's own title, so the field says so. */}
          <span className={styles.linkLabel}>{isCard ? 'Title' : 'Text'}</span>
          <input
            ref={textRef}
            className={styles.linkInput}
            value={form.text}
            onChange={e => onChange({ ...form, text: e.target.value })}
            placeholder={isCard ? "Leave blank to use the page's own title" : 'Link text'}
            spellCheck={false}
          />
        </label>

        <label className={styles.linkField}>
          <span className={styles.linkLabel}>URL</span>
          <input
            ref={urlRef}
            className={styles.linkInput}
            value={form.url}
            onChange={e => onChange({ ...form, url: e.target.value })}
            placeholder="example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        {/* How it renders. The same three sizes a saved reference offers, so a
            link and an article look alike at the same size. Only shown where the
            host can actually read a page - without that a card would be an
            untitled box. */}
        {canCard && (
          <div className={styles.linkField}>
            <span className={styles.linkLabel}>Show as</span>
            <div className={styles.linkSizes} role="radiogroup" aria-label="Link appearance">
              {LINK_SIZES.map(size => (
                <button
                  key={size.id}
                  type="button"
                  role="radio"
                  aria-checked={form.variant === size.id}
                  className={`${styles.linkSize} ${form.variant === size.id ? styles.linkSizeOn : ''}`}
                  onClick={() => onChange({ ...form, variant: size.id })}
                  title={size.hint}
                >
                  {size.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={styles.linkActions}>
          {form.editing && (
            <button className={styles.linkRemove} onClick={onRemove} disabled={busy}>Remove link</button>
          )}
          <span className={styles.linkSpacer} />
          <button className={styles.linkCancel} onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={styles.linkApply} onClick={() => onSubmit(form)} disabled={!valid || busy}>
            {busy ? 'Reading page…' : form.editing ? 'Save' : isCard ? 'Add card' : 'Add link'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Spelled-out toolbar action. Row and column commands are near-impossible to
// tell apart as 14px glyphs, so the table group says what it does; `chip`
// outlines the one action that throws work away wholesale.
function WordBtn({ title, onRun, danger, chip, children }: {
  title: string; onRun: () => void; danger?: boolean; chip?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${styles.tbWordBtn} ${danger ? styles.tbWordBtnDanger : ''} ${chip ? styles.tbWordBtnChip : ''}`}
      title={title}
      aria-label={title}
      onMouseDown={e => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

// Toolbar button. Suppressing mousedown is what keeps the caret/selection alive
// in the editor while the button is pressed.
function TBtn({ title, active, onRun, disabled, children }: {
  title: string; active?: boolean; onRun: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${styles.tbBtn} ${active ? styles.tbBtnActive : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={e => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}
