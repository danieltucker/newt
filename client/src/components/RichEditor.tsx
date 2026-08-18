import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './RichEditor.module.css';
import { getCaretPath, setCaretPath, CaretPath } from '../utils/caret';
import { HistoryStack, EditKind } from '../utils/history';
import { ACCEPTED_IMAGE_TYPES } from '../utils/imageUpload';
import { findRanges, replaceRange, replaceAll, FindOptions } from '../utils/noteFind';
import { modLabel } from '../utils/platform';
import { PageMeta, EMPTY_PAGE_META, pageEmbed, isBareUrl } from '../utils/pageMeta';
import { markdownToHtml, htmlToMarkdown, looksLikeMarkdown } from '../utils/markdown';
import { sanitizePastedHtml } from '../utils/pasteHtml';
import { Emoji, EMOJI_GROUPS, searchEmoji } from '../utils/emoji';
import {
  EMBED_CLASS, EmbedData, EmbedKind, EmbedVariant, applyCommentCounts, createEmbed, embedAt,
  embedMatches, embedUrlsIn, hydrateEmbeds, readEmbed, variantOf,
} from '../utils/noteEmbed';
import {
  GALLERY_CLASS, GalleryImage, MAX_GALLERY_IMAGES, createGallery, galleryAt, galleryImages,
  galleryIndexOf, hydrateGalleries,
} from '../utils/noteGallery';
import {
  ColorKind, PALETTE, applyColor, applyBlockTag, clearFormatting, colorCaret, colorClass, colorsAt, normalizeBlocks,
} from '../utils/noteFormat';
import Lightbox from './Lightbox';

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

// 'image', 'gallery' and 'reference' are grouped with the blocks in the menu but
// are not block transforms - they open a picker, so applyCmd intercepts them
// before applyBlock.
// 'emoji' and 'color' sit with the inline marks for the same reason: they
// change the run of text you are writing rather than the shape of the block,
// but they open a picker instead of toggling anything, so applyCmd intercepts
// them too.
type BlockId  = 'text' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'todo' | 'quote' | 'code' | 'hr' | 'table' | 'image' | 'gallery' | 'reference';
type InlineId = 'bold' | 'italic' | 'underline' | 'strike' | 'inlinecode' | 'link' | 'clear' | 'emoji' | 'color';

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
  { id: 'gallery', kind: 'block', label: 'Gallery',   badge: '🗂', hint: 'A stack of photos',      keys: ['gallery', 'photos', 'images', 'album', 'stack', 'carousel', 'slideshow'] },
  { id: 'reference', kind: 'block', label: 'Reference', badge: '🔖', hint: 'A saved article or your post', keys: ['reference', 'ref', 'article', 'saved', 'reading', 'post', 'blog', 'embed', 'cite', 'card'] },

  { id: 'bold',       kind: 'inline', label: 'Bold',          badge: 'B',  hint: 'Ctrl+B - **text**',  keys: ['bold', 'b', 'strong', '**'] },
  { id: 'italic',     kind: 'inline', label: 'Italic',        badge: 'I',  hint: 'Ctrl+I - *text*',    keys: ['italic', 'i', 'em', 'emphasis', '*', '_'] },
  { id: 'underline',  kind: 'inline', label: 'Underline',     badge: 'U',  hint: 'Ctrl+U',             keys: ['underline', 'u'] },
  { id: 'strike',     kind: 'inline', label: 'Strikethrough', badge: 'S',  hint: '~~text~~',           keys: ['strike', 'strikethrough', 's', 'del', 'cross', '~~'] },
  { id: 'inlinecode', kind: 'inline', label: 'Inline code',   badge: '`',  hint: 'Monospace `text`',   keys: ['inlinecode', 'mono', 'monospace', 'codespan', '`'] },
  { id: 'link',       kind: 'inline', label: 'Link',          badge: '🔗', hint: 'Add a hyperlink',    keys: ['link', 'url', 'href', 'anchor', 'a', '[]()'] },
  { id: 'color',      kind: 'inline', label: 'Colour',        badge: 'A',  hint: 'Text colour or highlight', keys: ['color', 'colour', 'text', 'highlight', 'marker', 'pen', 'red', 'green', 'blue', 'yellow'] },
  { id: 'clear',      kind: 'inline', label: 'Clear format',  badge: 'Tx', hint: 'Back to plain text', keys: ['clear', 'remove', 'unformat', 'reset', 'strip', 'plain'] },
  { id: 'emoji',      kind: 'inline', label: 'Emoji',         badge: '🙂', hint: 'Pick a character',   keys: ['emoji', 'emoticon', 'smiley', 'face', 'reaction', 'symbol', ':)'] },
];

// Enough to place the panel before it exists; the CSS caps it at the same size.
const EMOJI_PANEL_W = 268;
const EMOJI_PANEL_H = 282;

// The same, for the colour panel: two labelled rows of eight swatches, each
// with a way back to no colour at all. Taken from the coarse-pointer sizes,
// which are the taller of the two.
const COLOR_PANEL_W = 212;
const COLOR_PANEL_H = 128;

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

// The inline half of the same idea: closing a pair of markers formats what is
// between them, in place, as you type. The command menu has advertised this all
// along - every inline entry in CMDS lists its markdown in the hint - and it
// simply was not wired up.
//
// Ordered longest marker first, so "**" is claimed before the "*" that is its
// prefix. The content class excludes the marker character, which is what stops
// a run from swallowing the pair beside it, and both ends must be non-space, so
// "2 * 3 * 4" is arithmetic rather than emphasis.
//
// Cost is one regex list walk on the keystrokes that type a marker character
// and no others - see maybeInlineFormat, which returns before any of this runs
// unless the character just typed was one of `*_~\``.
// `cmds` are execCommand names rather than tag names on purpose. Writing the
// markup by hand and dropping the caret after it looks right and behaves
// wrongly: contentEditable sticks a collapsed caret to the element on its left,
// so everything typed next lands *inside* the bold that was just closed, and
// the run swallows the rest of the sentence. Going through execCommand means
// the browser owns the mark state, and toggling the same command again once the
// caret is collapsed is what turns it back off. `code` has no execCommand, so
// it is the one that has to be wrapped by hand - see wrapCaretRunInCode.
//
// There is deliberately no "***both***" rule. On an empty line "***" is already
// the horizontal rule trigger (see MD_RULES, which runs first and wins), so it
// could only ever fire mid-sentence, and a rule that works in one half of a
// paragraph and not the other is worse than not having it. Pasted markdown
// still handles it - see utils/markdown.
const INLINE_MD: { re: RegExp; cmds: string[]; solo: string | null }[] = [
  { re: /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/,     cmds: ['bold'],           solo: null },
  { re: /__([^_\s](?:[^_]*[^_\s])?)__$/,         cmds: ['bold'],           solo: null },
  { re: /~~([^~\s](?:[^~]*[^~\s])?)~~$/,         cmds: ['strikeThrough'],  solo: null },
  { re: /\*([^*\s](?:[^*]*[^*\s])?)\*$/,         cmds: ['italic'],         solo: '*' },
  { re: /_([^_\s](?:[^_]*[^_\s])?)_$/,           cmds: ['italic'],         solo: '_' },
  { re: /`([^`\s](?:[^`]*[^`\s])?)`$/,           cmds: [],                 solo: '`' },
];

// The characters worth looking at all. Anything else returns immediately.
const INLINE_MD_TRIGGERS = '*_~`';

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

// Drawn rather than an actual 🙂: a colour emoji in the bar would be the only
// full-colour thing in a row of grey strokes, and it renders differently on
// every platform.
const EmojiIcon = () => icon(<>
  <circle cx="12" cy="12" r="9" />
  <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
  <path d="M9 9.5h.01" /><path d="M15 9.5h.01" />
</>);

const TableIcon = () => icon(<>
  <rect x="3" y="4" width="18" height="16" rx="2" />
  <path d="M3 10h18" /><path d="M9 10v10" /><path d="M15 10v10" />
</>);

// An "A" over a thick bar - the universal mark for "this changes the colour of
// text". Drawn rather than set as a letter so it keeps the stroke weight of
// every other glyph in the row.
const ColorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 16 12 4l7 12" />
    <path d="M7.7 12h8.6" />
    <path d="M4 21h16" strokeWidth="3" />
  </svg>
);

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

// Two frames offset behind a third - the stack of photographs the gallery draws,
// at button size. Deliberately not a second picture-frame glyph: the whole point
// of this command is that it is more than one image.
const GalleryIcon = () => icon(<>
  <path d="M8 4h11a1 1 0 0 1 1 1v11" />
  <path d="M6 7h11a1 1 0 0 1 1 1v11" />
  <rect x="2" y="10" width="13" height="11" rx="1.5" />
</>);

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

function sameMarks(a: Marks, b: Marks): boolean {
  return a.bold === b.bold && a.italic === b.italic
    && a.underline === b.underline && a.strike === b.strike;
}

// First-paint estimate only - the bubble sizes to its content, so the real
// width is measured after render and the position corrected before paint.
const BUBBLE_EST_W = 250;
const BUBBLE_M = 8;
const BUBBLE_H = 36;

interface BubblePos { anchorX: number; left: number; top: number; }

// What is actually on screen, in the same client coordinates a fixed element is
// positioned in. They only differ on a phone: the soft keyboard shrinks the
// *visual* viewport without touching the layout viewport, so window.innerHeight
// still reports the full page and anything placed against it lands behind the
// keyboard. Pinch-zoom moves it sideways for the same reason.
interface Viewport { left: number; top: number; right: number; bottom: number; }
function viewportBox(): Viewport {
  const vv = window.visualViewport;
  if (!vv) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  return {
    left: vv.offsetLeft,
    top: vv.offsetTop,
    right: vv.offsetLeft + vv.width,
    bottom: vv.offsetTop + vv.height,
  };
}

// Centre the bubble over the selection. `boundsTop` is the top of the editor's
// scroll area - selecting on the first line would otherwise float the bubble up
// over the utility bar, so in that case it flips below the selection instead.
// Below is a fallback and not a preference: it is where a phone puts its own
// selection handles, so the bubble only goes there when it cannot go above.
function computeBubblePos(r: DOMRect, boundsTop: number): BubblePos {
  const vp = viewportBox();
  const anchorX = r.left + r.width / 2;
  const ceiling = Math.max(vp.top + BUBBLE_M, boundsTop);
  let top = r.top - 44;
  if (top < ceiling) {
    const below = r.bottom + BUBBLE_M;
    // Neither side fits - the line is taller than the visible strip between the
    // toolbar and the keyboard - so sit at the top of that strip rather than
    // scrolling off the end of it.
    top = below + BUBBLE_H <= vp.bottom ? below : ceiling;
  }
  return { anchorX, left: clampBubbleLeft(anchorX, BUBBLE_EST_W), top };
}

function clampBubbleLeft(anchorX: number, width: number): number {
  const vp = viewportBox();
  return Math.max(vp.left + BUBBLE_M, Math.min(anchorX - width / 2, vp.right - width - BUBBLE_M));
}

// A bubble is anchored to a live source rather than to the rectangle that was
// under the selection when it went up. On a phone the ground moves after the
// fact: opening the keyboard scrolls the page to reveal the caret, and a fixed
// bubble placed before that scroll stays where it was while the text it belongs
// to slides out from under it. Re-asking the anchor is how it keeps up.
type BubbleAnchor = () => DOMRect | null;

function elementAnchor(el: HTMLElement): BubbleAnchor {
  return () => (el.isConnected ? el.getBoundingClientRect() : null);
}

// The range is cloned, so it keeps reporting where those characters are now
// even as the document reflows around them.
function rangeAnchor(range: Range): BubbleAnchor {
  const live = range.cloneRange();
  return () => {
    const r = live.getBoundingClientRect();
    return r.width || r.height ? r : null;
  };
}

function sameBubble(a: BubblePos | null, b: BubblePos | null): boolean {
  if (!a || !b) return a === b;
  return a.anchorX === b.anchorX && a.left === b.left && a.top === b.top;
}

// Keep the command menu fully on-screen: clamp horizontally, and flip above the
// caret when there isn't room below. maxHeight makes it scroll rather than run
// off the page. Measured against the visible viewport for the same reason the
// bubble is - on a phone the space "below" the caret is mostly keyboard.
function computeMenuPos(base: DOMRect): MenuPos {
  const MENU_W = 288;
  const M = 8;
  const vp = viewportBox();
  let left = base.left;
  if (left + MENU_W > vp.right - M) left = vp.right - MENU_W - M;
  if (left < vp.left + M) left = vp.left + M;
  const spaceBelow = vp.bottom - base.bottom - M;
  const spaceAbove = base.top - vp.top - M;
  if (spaceBelow < 200 && spaceAbove > spaceBelow) {
    // `bottom` offsets a fixed element from the bottom of the *layout*
    // viewport, so it stays measured against innerHeight even though the room
    // available was measured against the visible strip.
    const bottom = window.innerHeight - base.top + 4;
    return { left, top: null, bottom, maxHeight: Math.max(140, Math.min(300, spaceAbove - 4)) };
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
  // A caret, not a selection. Selecting a whole line and pressing Backspace
  // starts its range at the block start too, so without this the to-do handler
  // read that as "backspace at the start of the line", cancelled the native
  // delete and unwrapped the block - which showed up as the checkbox vanishing
  // while every word the user had just highlighted stayed exactly where it was.
  // A selection means "delete these characters" whatever block they sit in, and
  // the browser's own handling is the right answer to it.
  if (!sel.isCollapsed) return false;
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

// Elements that make a block non-blank while holding no text of their own.
const VISIBLE_EMPTY = new Set(
  ['HR', 'IMG', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'H1', 'H2', 'H3', 'TABLE']);

// Whether the placeholder should show. Text alone isn't enough to decide:
// to-dos, dividers, and empty code/quote frames render visibly while holding
// no text, and the placeholder would sit on top of them.
//
// Walked with an early return rather than asked as `textContent.trim()` plus a
// querySelector. Both of those read the whole document however long it is, and
// this runs on every keystroke via emit() - so a full note paid to build (and
// immediately throw away) a copy of its own text per character, to answer a
// question the first word on the first line already settles. The walk stops at
// the first thing that proves the editor non-blank, which for any note that has
// anything in it at all is the first node it looks at.
function isBlank(el: HTMLElement): boolean {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walk.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.nodeValue ?? '').trim()) return false;
    } else {
      const tag = node.nodeName;
      const cls = (node as HTMLElement).classList;
      if (VISIBLE_EMPTY.has(tag) || cls.contains(TODO_CLASS) || cls.contains(EMBED_CLASS)) return false;
    }
    node = walk.nextNode();
  }
  return true;
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

// The node a selection brackets, if it brackets exactly one. Clicking a
// replaced element (an image) or an atomic island selects it this way rather
// than putting a caret inside it, which is what both lookups below key on.
function bracketedNode(root: HTMLElement): Node | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (r.startContainer !== r.endContainer || r.endOffset !== r.startOffset + 1) return null;
  const node = r.startContainer.childNodes[r.startOffset] ?? null;
  return node && root.contains(node) ? node : null;
}

/** The gallery a selection covers, by the same rule embeds are found by. */
function galleryInSelection(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return galleryAt(bracketedNode(root), root)
    ?? galleryAt(sel.getRangeAt(0).commonAncestorContainer, root);
}

/**
 * The plain image a selection is on - the one the resize frame belongs to.
 *
 * Only an image standing on its own: the pictures inside a reference card or a
 * gallery are that object's business, and are sized by it rather than dragged
 * about individually.
 */
function imageInSelection(root: HTMLElement): HTMLImageElement | null {
  const node = bracketedNode(root);
  if (!(node instanceof HTMLImageElement)) return null;
  if (node.closest(`.${EMBED_CLASS}, .${GALLERY_CLASS}`)) return null;
  return node;
}

// ── Image sizing ──────────────────────────────────────────────────────
// A resized image stores its size as the `width`/`height` attributes it was
// inserted with, not as inline CSS: a style attribute is refused by the server's
// allowlist (it would be a way to smuggle CSS into a reader's page - see
// RICH_HTML_OPTIONS), so it is the one vehicle that survives a round trip
// through storage. They stay in proportion, which is what keeps them doing the
// job they were added for - reserving the right space before the bytes land.
//
// Pixels rather than a percentage, because that is what the attribute means.
// The stylesheet's max-width:100% is what stops a picture sized in a wide editor
// from overflowing the narrower column it is read in.
const MIN_IMG_W = 60;

// What the presets on the image bar mean, as a fraction of the column.
const IMG_SIZES: { id: string; label: string; hint: string; pct: number }[] = [
  { id: 'sm',   label: 'S', hint: 'Small - a quarter of the column',   pct: 0.25 },
  { id: 'md',   label: 'M', hint: 'Medium - half the column',          pct: 0.5 },
  { id: 'lg',   label: 'L', hint: 'Large - three quarters',            pct: 0.75 },
  { id: 'full', label: 'Full', hint: 'The full width of the column',   pct: 1 },
];

/** The aspect ratio to hold an image at while it is resized. */
function aspectOf(img: HTMLImageElement): number {
  if (img.naturalWidth && img.naturalHeight) return img.naturalHeight / img.naturalWidth;
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  return w && h ? h / w : (img.offsetWidth ? img.offsetHeight / img.offsetWidth : 1);
}

/** How wide the image is allowed to get: the text column it sits in. */
function columnWidthFor(img: HTMLImageElement, editor: HTMLElement): number {
  const host = img.parentElement && img.parentElement !== editor ? img.parentElement : editor;
  // clientWidth excludes the border but not the padding, which the editor has a
  // lot of - so take it off, or "full width" would reach under the margin.
  const cs = getComputedStyle(host);
  const pad = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
  return Math.max(MIN_IMG_W, Math.round(host.clientWidth - pad));
}

/**
 * What the one hidden file input was opened for: a single image, a new gallery,
 * or more photos for a gallery that already exists.
 */
type PickMode = 'image' | 'gallery' | 'add';

/** Write a width onto an image, carrying the height with it. */
function setImageWidth(img: HTMLImageElement, width: number) {
  const w = Math.max(MIN_IMG_W, Math.round(width));
  img.setAttribute('width', String(w));
  img.setAttribute('height', String(Math.max(1, Math.round(w * aspectOf(img)))));
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
  // What the picker was opened for, and - for 'add' - which gallery the files
  // are going into. See pickImage.
  const pickMode = useRef<PickMode>('image');
  const pickTarget = useRef<HTMLElement | null>(null);
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
  // The same idea for the two other objects a selection can land on rather than
  // a run of words: a picture, which has a size you can drag, and a gallery,
  // which is an atomic island like an embed. Each gets its own bar.
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [galleryEl, setGalleryEl] = useState<HTMLElement | null>(null);
  // The gallery the reader is paging through, if any. Opening it from the
  // editor is how an author checks a stack they cannot see all of in place.
  const [galleryView, setGalleryView] = useState<{ images: GalleryImage[]; index: number } | null>(null);
  // The stack that overlay belongs to - see openGallery for why it is a ref.
  const viewedGallery = useRef<HTMLElement | null>(null);
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
  // nodeName of the block the caret is in, for the bubble's heading control.
  const [blockTag, setBlockTag] = useState('P');
  // Whether that control's menu is open. Local to the bubble, and closed
  // whenever the bubble itself goes.
  const [headingOpen, setHeadingOpen] = useState(false);
  const [inTable, setInTable] = useState(false);
  const [bubble, setBubble] = useState<BubblePos | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Emoji picker. Fixed and portalled, like the bubble: the comment composer is
  // a 190px shell with overflow hidden, so a panel that lived in the flow would
  // swallow the writing area and an absolute one would be clipped away.
  const [emojiAt, setEmojiAt] = useState<{ left: number; top: number } | null>(null);
  const [emojiQuery, setEmojiQuery] = useState('');
  const emojiRef = useRef<HTMLDivElement>(null);
  const emojiBtnRef = useRef<HTMLSpanElement>(null);
  const emojiInputRef = useRef<HTMLInputElement>(null);
  // Where the character goes. The grid alone could rely on suppressing
  // mousedown to leave the caret untouched, but a search field has to take
  // focus to be typed in, which collapses the selection - so the picker stashes
  // it on the way up, the way the image and reference pickers do.
  const emojiRange = useRef<Range | null>(null);

  // Colour picker. Portalled and fixed for the same reasons the emoji panel is,
  // and opened from either bar - unlike emoji, which is only on the utility bar
  // (it inserts a character, so it has nothing to say to a selection), colour is
  // *about* the selection, so the bubble is where it is mostly wanted.
  //
  // `on` is what the caret is already standing in, read once when the panel
  // opens. Doing it on every selection change would put an ancestor walk on the
  // per-keystroke path to answer a question nothing renders until it is up.
  const [colorAt, setColorAt] = useState<{ left: number; top: number } | null>(null);
  const [colorOn, setColorOn] = useState<{ fg: string | null; bg: string | null }>({ fg: null, bg: null });
  const colorRef = useRef<HTMLDivElement>(null);

  // Where the bubble is pinned. Kept in a ref rather than in state because it
  // is read by scroll handlers that must not cause a render to run.
  const bubbleAnchor = useRef<BubbleAnchor | null>(null);

  function boundsTop(): number {
    return scrollRef.current?.getBoundingClientRect().top ?? 0;
  }

  function raiseBubble(anchor: BubbleAnchor) {
    const r = anchor();
    if (!r) { dropBubble(); return; }
    bubbleAnchor.current = anchor;
    const next = computeBubblePos(r, boundsTop());
    // Typing inside a link recomputes this on every keystroke and usually lands
    // on the same pixel; a fresh object every time would re-render regardless.
    setBubble(prev => sameBubble(prev, next) ? prev : next);
  }

  function dropBubble() {
    bubbleAnchor.current = null;
    setBubble(null);
  }

  // Put the rendered bubble where its anchor is now. Written straight to the
  // node: this runs on scroll, and going through state would render the editor
  // on every frame of a flick.
  //
  // The rendered bubble is also as wide as its buttons need, which is only
  // knowable after it exists - so the real width is what gets centred, not the
  // estimate computeBubblePos had to work from.
  function placeBubble() {
    const el = bubbleRef.current;
    const anchor = bubbleAnchor.current;
    if (!el || !anchor) return;
    const r = anchor();
    if (!r) return;
    const pos = computeBubblePos(r, boundsTop());
    el.style.left = `${clampBubbleLeft(pos.anchorX, el.offsetWidth)}px`;
    el.style.top = `${pos.top}px`;
    // Scrolled past what it belongs to: hide rather than follow the text off
    // the edge of the note and hang over whatever is next to it.
    const box = scrollRef.current?.getBoundingClientRect();
    const gone = !!box && (r.bottom < box.top || r.top > box.bottom);
    el.style.visibility = gone ? 'hidden' : '';
    el.style.pointerEvents = gone ? 'none' : '';
  }

  // Every render, not just the ones that move the bubble: the JSX carries the
  // last state-held position, so any unrelated re-render would otherwise stamp
  // that back over wherever the scroll handlers have since put it. Free when
  // there is no bubble up, which is nearly always.
  useLayoutEffect(placeBubble);

  // Anything that moves the text under the bubble: scrolling the note (capture,
  // so the inner scroller counts), scrolling the page, and - the phone case -
  // the keyboard opening, which resizes the visual viewport and scrolls the
  // caret into view without either the note or the window firing a thing.
  useEffect(() => {
    if (!bubble) return;
    let frame = 0;
    function onMove() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; placeBubble(); });
    }
    const vv = window.visualViewport;
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    vv?.addEventListener('scroll', onMove);
    vv?.addEventListener('resize', onMove);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      vv?.removeEventListener('scroll', onMove);
      vv?.removeEventListener('resize', onMove);
    };
  }, [bubble]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── The object frame ──────────────────────────────────────────────────
  // A ring round whatever the bar is currently about - the selected picture or
  // gallery - carrying the handles that drag a picture's width.
  //
  // It is portalled to <body> and positioned like the bubble rather than being
  // drawn inside the editor, and that is not a layout preference: every node in
  // the editable surface is serialized straight back out through onChange and
  // saved into the note. A handle placed there would be stored as part of the
  // document, would land on the undo stack, and the caret would be free to walk
  // into it. Nothing that is chrome may live inside the text.
  const frameRef = useRef<HTMLDivElement>(null);
  const frameTarget: HTMLElement | null = imgEl ?? galleryEl;
  // Live width during a drag, so the readout can say where it has got to.
  const [dragW, setDragW] = useState<number | null>(null);

  function placeFrame() {
    const el = frameRef.current;
    const target = frameTarget;
    if (!el || !target || !target.isConnected) return;
    const r = target.getBoundingClientRect();
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
    // Scrolled past what it belongs to: hide rather than follow the picture off
    // the end of the note - the rule the bubble already follows.
    const box = scrollRef.current?.getBoundingClientRect();
    const gone = !!box && (r.bottom < box.top || r.top > box.bottom);
    el.style.visibility = gone ? 'hidden' : '';
    el.style.pointerEvents = gone ? 'none' : '';
  }

  useLayoutEffect(placeFrame);

  useEffect(() => {
    if (!frameTarget) return;
    let frame = 0;
    function onMove() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; placeFrame(); });
    }
    const vv = window.visualViewport;
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    vv?.addEventListener('scroll', onMove);
    vv?.addEventListener('resize', onMove);
    // An image that arrives after the frame does changes the size of what the
    // frame is round, and nothing scrolls or resizes to say so.
    const ro = new ResizeObserver(onMove);
    ro.observe(frameTarget);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      vv?.removeEventListener('scroll', onMove);
      vv?.removeEventListener('resize', onMove);
    };
  }, [frameTarget]); // eslint-disable-line react-hooks/exhaustive-deps

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
  if (!historyRef.current) {
    historyRef.current = new HistoryStack<Snap>(400, 50, 200, s => s.html.length);
  }
  const history = historyRef.current;

  function snapshot(): Snap {
    const el = ref.current!;
    return { html: el.innerHTML, caret: getCaretPath(el) };
  }
  // Passed as a factory, not a value: `record('type')` fires on every keypress
  // but only actually keeps a snapshot when it starts a new undo group, and
  // snapshot() serializes the whole document. Building one for every character
  // and discarding it was the editor's single largest per-keystroke cost, and
  // the garbage it made is what turned a long note on a phone into a stall.
  function record(kind: EditKind) {
    if (ref.current) history.record(snapshot, kind);
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

  // Same nudge, aimed at the caret. A collapsed range measures 0x0 in some
  // engines, so the line it sits on stands in for it.
  function revealCaret() {
    const editor = ref.current;
    const sel = window.getSelection();
    if (!editor || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return;
    const r = range.getBoundingClientRect();
    if (r.height || r.width) { revealMatch(range); return; }
    const block = getBlock(editor);
    if (!block) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const b = block.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const margin = 48;
    if (b.top < box.top + margin) scroller.scrollTop -= box.top + margin - b.top;
    else if (b.bottom > box.bottom - margin) scroller.scrollTop += b.bottom - (box.bottom - margin);
  }

  /* The keyboard opening takes the bottom of the screen away, and the host
     shrinks to fit (see --kb-inset). The caret does not move when that happens,
     so a line that was two thirds down the editor is now off the end of a
     shorter scroller - which is exactly the moment you least want to lose sight
     of it. The browser scrolls the caret into view for its own reasons; a
     container resizing under it is not one of them. */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || readOnly) return;
    const onResize = () => {
      const editor = ref.current;
      const focus = document.activeElement;
      if (!editor || !focus || !(editor === focus || editor.contains(focus))) return;
      // After the host has re-laid out at the new height, not before.
      requestAnimationFrame(revealCaret);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /* The find bar sticks under the formatting toolbar rather than scrolling off
     with the text. Where "under" is has to be measured: the toolbar wraps to as
     many rows as the width allows, and grows another one whenever the caret is
     in a table, so the offset is not a constant anyone can write in the
     stylesheet. Only tracked while the bar is open - the observer has nothing to
     tell anyone the rest of the time. */
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarH, setToolbarH] = useState(0);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || !findOpen) return;
    const measure = () => setToolbarH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [findOpen]);

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
    // And the same for the shape above the lists: a body that arrives with loose
    // text at the top level opens looking perfectly fine and then refuses every
    // block command, clear-formatting included. Repaired on the way in, and
    // persisted below with the list repair.
    normalizeBlocks(el);
    // Blog bodies come back from the server sanitizer stripped of the attribute
    // that makes an embed atomic, so put it back before the caret can wander in.
    hydrateEmbeds(el);
    hydrateGalleries(el);
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
    ((c.id !== 'image' && c.id !== 'gallery') || !!onUploadImage)
    && (c.id !== 'reference' || !!references));
  const filtered = slashQuery ? available.filter(c => cmdMatches(c, slashQuery)) : available;

  function emit() {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle('note-empty', isBlank(el));
    // Zero-width spaces are a caret-parking device, not content: they are how a
    // code span stays selectable and how the caret gets back out of one (see
    // toggleInlineCode and wrapSelectionInCode). They must not reach storage,
    // where they would show up as invisible junk in every text length check and
    // every search.
    //
    // Tested for before being stripped: this runs on every keystroke, and there
    // is one in the document only while the caret is parked in a code span. A
    // scan is cheap; rebuilding the whole serialization to change nothing is not.
    const html = el.innerHTML;
    onChange(html.includes('​') ? html.replace(/​/g, '') : html);
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

  // The inline marks and the shape of the block the caret is in, refreshed
  // together because every place that wanted one now wants both: the bubble's
  // heading control reports the current level, not just offers a new one.
  //
  // The marks are compared field by field before they are set. This runs on
  // every selection change, which means on every keystroke, and readMarks
  // always builds a fresh object - so setting it unconditionally re-rendered
  // the whole editor on every character even though the answer is the same
  // four booleans for paragraphs at a time.
  function refreshMarks() {
    markHostRef.current = markHost();
    const next = readMarks();
    setMarks(prev => sameMarks(prev, next) ? prev : next);
    const editor = ref.current;
    setBlockTag(editor ? (getBlock(editor)?.nodeName ?? 'P') : 'P');
  }

  // The element the caret's formatting is decided by. Typing runs the offset
  // along inside one text node without ever changing this, which is what makes
  // the check below sound: bold/italic/underline/strike are properties of the
  // ancestor chain, so while that chain is the same the answer is the same.
  function markHost(): Node | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null;
    const node = sel.anchorNode;
    return node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  }

  // What refreshMarks last answered for, so a selection change that cannot have
  // changed the answer can skip asking again.
  const markHostRef = useRef<Node | null>(null);
  const markCollapsedRef = useRef(true);

  /**
   * refreshMarks, minus the work when the answer cannot have moved.
   *
   * `document.queryCommandState` is the most expensive thing typing does - four
   * calls, each of which resolves style against the selection - and it ran on
   * every selection change, which is once per character. Profiled over 700
   * characters of a 300-block note it cost more than twice the whole serialize
   * -and-emit path put together.
   *
   * Nothing is skipped that could be wrong: the marks are re-read whenever the
   * caret leaves the element it was in, and whenever it goes from a caret to a
   * selection or back. Every command that changes formatting under a still
   * caret (the toolbar, the bubble, the inline markdown rules) calls
   * refreshMarks itself and is unaffected by this.
   */
  function refreshMarksIfMoved(collapsed: boolean) {
    const host = markHost();
    // Only a caret is safe to skip. A selection being dragged wider keeps both
    // its anchor and its host while sweeping across runs that are formatted
    // differently, and the bubble is showing that answer.
    if (collapsed && markCollapsedRef.current && host === markHostRef.current) {
      // Still worth keeping the block tag current - it is one cheap walk up to
      // the editor root, and Enter makes a new block inside the same host.
      const editor = ref.current;
      setBlockTag(editor ? (getBlock(editor)?.nodeName ?? 'P') : 'P');
      return;
    }
    markCollapsedRef.current = collapsed;
    refreshMarks();
  }

  function execInline(command: string, value?: string) {
    ref.current?.focus();
    record('struct');
    document.execCommand(command, false, value);
    refreshMarks();
    emit();
  }

  // ── Emoji ─────────────────────────────────────────────────────────────
  // Anchored to whatever opened it - the toolbar button, or the caret when it
  // came from /emoji - and flipped above that when there's no room below.
  function openEmojiAt(rect: DOMRect | undefined) {
    if (!rect) return;
    const sel = window.getSelection();
    const editor = ref.current;
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    emojiRange.current = range && editor?.contains(range.commonAncestorContainer)
      ? range.cloneRange()
      : null;
    const vp = viewportBox();
    const left = Math.max(vp.left + 8, Math.min(rect.left, vp.right - EMOJI_PANEL_W - 8));
    const roomBelow = vp.bottom - rect.bottom > EMOJI_PANEL_H + 12;
    setEmojiQuery('');
    setEmojiAt({
      left,
      top: roomBelow
        ? rect.bottom + 6
        : Math.max(vp.top + 8, rect.top - EMOJI_PANEL_H - 6),
    });
  }

  function closeEmoji() {
    setEmojiAt(null);
    setEmojiQuery('');
    emojiRange.current = null;
  }

  function toggleEmoji() {
    if (emojiAt) { closeEmoji(); return; }
    openEmojiAt(emojiBtnRef.current?.getBoundingClientRect());
  }

  // Picking inserts as text, not markup: an emoji is a character in the
  // sentence, so it undoes, spell-checks and copies like one. The caret goes
  // back where the picker found it first - the search field has almost
  // certainly taken focus by now.
  function insertEmoji(ch: string) {
    restoreRange(emojiRange.current);
    record('struct');
    document.execCommand('insertText', false, ch);
    closeEmoji();
    emit();
  }

  // null means "not searching" - the picker shows its groups, as it always has.
  const emojiResults = emojiAt ? searchEmoji(emojiQuery) : null;

  const emojiButton = (e: Emoji) => (
    <button
      key={e.ch}
      type="button"
      className={styles.emojiBtn}
      // The glyph is its own label for anyone who can see it; a screen reader
      // gets the name it is filed under instead.
      aria-label={e.keys[0]}
      title={e.keys[0]}
      // Suppressing mousedown keeps focus where it is - in the search field,
      // or in the editor when the grid is used without searching.
      onMouseDown={ev => ev.preventDefault()}
      onClick={() => insertEmoji(e.ch)}
    >
      {e.ch}
    </button>
  );

  useEffect(() => {
    if (!emojiAt) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (emojiRef.current?.contains(t) || emojiBtnRef.current?.contains(t)) return;
      closeEmoji();
    }
    // Capture, so Escape closes the picker without also closing the console it
    // is sitting in.
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); closeEmoji(); }
    }
    // The panel is fixed and the page underneath is not, so anything that
    // scrolls leaves it stranded. Closing is the honest answer for a transient
    // picker - unlike the bubble, nothing is lost by putting it away.
    //
    // Except its own list. A capture listener on window sees scroll from every
    // element on the page, the panel's scrollable list included, so reaching
    // for an emoji further down used to dismiss the picker on the way.
    function onScroll(e: Event) {
      if (e.target instanceof Node && emojiRef.current?.contains(e.target)) return;
      closeEmoji();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [emojiAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the search field on open, but only where there is a real pointer.
  // On a phone, focusing it summons a second keyboard over the picker you just
  // asked to look at - and the grid is the fast path there anyway.
  useEffect(() => {
    if (emojiAt && window.matchMedia?.('(hover: hover)').matches) {
      emojiInputRef.current?.focus();
    }
  }, [emojiAt]);

  // ── Colour ────────────────────────────────────────────────────────────
  // The panel has no field to type in, so - unlike the emoji picker - nothing
  // in it ever takes focus: every button suppresses mousedown, which leaves the
  // caret (and the selection the colour is *for*) exactly where it was. There
  // is therefore no stashed range here, and no restore.
  function openColorAt(rect: DOMRect | undefined) {
    const editor = ref.current;
    if (!rect || !editor) return;
    const sel = window.getSelection();
    setColorOn(colorsAt(sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null, editor));
    const vp = viewportBox();
    const left = Math.max(vp.left + 8, Math.min(rect.left, vp.right - COLOR_PANEL_W - 8));
    const roomBelow = vp.bottom - rect.bottom > COLOR_PANEL_H + 12;
    setColorAt({
      left,
      top: roomBelow ? rect.bottom + 6 : Math.max(vp.top + 8, rect.top - COLOR_PANEL_H - 6),
    });
  }

  function closeColors() {
    setColorAt(null);
  }

  /**
   * Paint one kind of colour over the selection - or, with nothing selected,
   * open a run to type in it. `id` of null takes the colour back off.
   *
   * The words stay selected afterwards, so the bubble is still up and a second
   * colour can be tried without re-selecting anything. The panel stays open for
   * the same reason: picking a colour is usually picking two or three until one
   * of them looks right.
   */
  function applyPaletteColor(kind: ColorKind, id: string | null) {
    const editor = ref.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    record('struct');
    const next = range.collapsed
      ? colorCaret(range, editor, kind, id)
      : applyColor(range, editor, kind, id);
    if (next) {
      sel.removeAllRanges();
      sel.addRange(next);
    }
    setColorOn(on => ({ ...on, [kind]: id }));
    emit();
  }

  useEffect(() => {
    if (!colorAt) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (colorRef.current?.contains(target)) return;
      if (target?.closest?.('[data-color-btn]')) return;   // let the button toggle
      closeColors();
    }
    // Capture, so Escape puts the panel away without also closing the console
    // it is sitting in - the rule the emoji picker follows.
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); closeColors(); }
    }
    // Fixed panel over a page that scrolls: closing is the honest answer, and
    // nothing is lost by it.
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', closeColors, true);
    window.addEventListener('resize', closeColors);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', closeColors, true);
      window.removeEventListener('resize', closeColors);
    };
  }, [colorAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Markdown source view ──────────────────────────────────────────────
  //
  // The document as text, editable. It exists because the rich surface cannot
  // always talk you out of a shape it got into: a bad paste that made everything
  // a heading, a block that will not become a paragraph however many times you
  // press ¶. Seeing the markup as words is the shortest route from "this is
  // wrong" to "this is fixed", and it is a repair tool first and a writing
  // surface second.
  //
  // `null` is the rich view; a string is the source view holding its text. The
  // contentEditable stays mounted underneath the whole time — hidden rather than
  // unmounted, so the caret machinery, the refs and the mount effect that seeds
  // the content never have to cope with the surface disappearing.
  //
  // Not everything in a post has a markdown spelling. Reference embeds,
  // galleries, colours and resized pictures come through as the HTML they
  // already are, and go back unchanged; see utils/markdown's htmlToMarkdown for
  // why that matters more than the view being tidy.
  const [sourceText, setSourceText] = useState<string | null>(null);

  /**
   * Write the source view's text back into the document.
   *
   * Every keystroke, rather than on leaving the view. The alternative is a
   * surface whose contents are not in the document yet, which means an autosave
   * writes the *old* post and closing the tab mid-edit throws the work away —
   * neither of which anyone would predict from a view that looks like it is
   * showing them their post. If this ever costs enough to notice, the fix is to
   * debounce this one call, not to move the work.
   */
  function applySource(text: string) {
    const editor = ref.current;
    setSourceText(text);
    if (!editor) return;
    // Through the paste allowlist on the way in: the source view is a text box
    // an author can type anything into, and what lands in the document should
    // be the same set of markup a paste is held to and the server will keep.
    const html = sanitizePastedHtml(markdownToHtml(text, { source: true }));
    editor.innerHTML = html || '<p><br></p>';
    normalizeLists(editor);
    normalizeBlocks(editor);
    hydrateEmbeds(editor);
    hydrateGalleries(editor);
    emit();
  }

  function toggleSource() {
    const editor = ref.current;
    if (!editor) return;
    if (sourceText === null) {
      record('struct');   // so one undo takes the whole visit back
      setSourceText(htmlToMarkdown(editor.innerHTML));
      return;
    }
    setSourceText(null);
    editor.focus();
  }

  // ── Clear formatting ──────────────────────────────────────────────────
  // Not execCommand('removeFormat'): that leaves links, code spans and every
  // colour standing, which is precisely the formatting this button is pressed
  // to be rid of. See utils/noteFormat.
  function clearFormat() {
    const editor = ref.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    record('struct');
    const next = clearFormatting(range, editor);
    // Flattening a list can leave its neighbours needing a tidy - two lists that
    // were separated by the one just dissolved are now adjacent.
    normalizeLists(editor);
    if (next) {
      sel.removeAllRanges();
      sel.addRange(next);
    }
    closeColors();
    refreshMarks();
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
    dropBubble();
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
      let meta: PageMeta = EMPTY_PAGE_META;
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
    refreshMarks();
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
  //
  // The same <input> serves all three things the picker can be opened for,
  // because they differ only in what is done with the files that come back.
  // Which one it was has to be remembered rather than passed along: choosing a
  // file hands focus away and the answer comes back on a change event much
  // later, by which time nothing about the click survives.
  function pickImage(mode: PickMode) {
    const sel = window.getSelection();
    imageRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    pickMode.current = mode;
    // The gallery being added to, for the same reason: the selection collapses
    // the moment the picker takes focus, so the bar's target is gone by then.
    pickTarget.current = mode === 'add' ? galleryEl : null;
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
    if (pickMode.current === 'gallery') { void insertGallery(files); return; }
    if (pickMode.current === 'add') { void addToGallery(files); return; }
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
    if (pasteUrl(e)) { e.preventDefault(); return; }
    if (pasteMarkdown(e)) { e.preventDefault(); return; }
    if (pasteRichText(e)) e.preventDefault();
  }

  /**
   * HTML on the clipboard, rewritten into the editor's own markup before it goes
   * in. Returns whether it handled the paste.
   *
   * The browser's own handling was what ran here until now, and what it inserts
   * is the source's markup nearly verbatim: a Google Docs paste wrapped in
   * `<b style="font-weight:normal">` and so entirely bold, a web page's nested
   * `<div>`s and `<section>`s that no block command can transform because they
   * are not blocks the editor knows, headings the source used for its own
   * furniture. The document then changed shape again on save, because the
   * server's sanitizer keeps a different set of tags than contentEditable does.
   *
   * See utils/pasteHtml: it mirrors that sanitizer, so what lands here is what
   * the post will still be after a reload.
   */
  function pasteRichText(e: React.ClipboardEvent): boolean {
    const html = e.clipboardData?.getData('text/html');
    if (!html?.trim()) return false;
    const clean = sanitizePastedHtml(html);
    // Nothing worth inserting — a clipboard carrying only a stylesheet, or a
    // tracking pixel. Falling through to the browser would put the junk back.
    if (!clean) return true;

    record('struct');
    document.execCommand('insertHTML', false, clean);
    const editor = ref.current;
    if (editor) {
      normalizeLists(editor);
      normalizeBlocks(editor);
      hydrateEmbeds(editor);
      hydrateGalleries(editor);
    }
    emit();
    return true;
  }

  /**
   * Markdown on the clipboard becomes formatted blocks rather than a wall of
   * asterisks. Returns whether it handled the paste.
   *
   * Only when the clipboard has no HTML of its own: copying from a web page or
   * another editor puts both `text/html` and a plain-text fallback on the
   * clipboard, and the HTML is the better source - it is what the browser's own
   * paste already uses, and running the fallback through a markdown reader
   * instead would throw away formatting the page had spelled out properly.
   * This is for the case where plain text is all there is, which is what you get
   * from a terminal, a code editor, a chat window or a `.md` file.
   *
   * `looksLikeMarkdown` is the other half of the guard: prose pastes as prose.
   */
  function pasteMarkdown(e: React.ClipboardEvent): boolean {
    const text = e.clipboardData?.getData('text/plain');
    const html = e.clipboardData?.getData('text/html');
    if (html?.trim() || !text || !looksLikeMarkdown(text)) return false;

    record('struct');
    document.execCommand('insertHTML', false, markdownToHtml(text));
    const editor = ref.current;
    if (editor) {
      // Pasted lists arrive as well-formed markup, but insertHTML merges them
      // into whatever list the caret was already in, which is where the stray
      // text-in-a-list shapes come from.
      normalizeLists(editor);
      normalizeBlocks(editor);
      hydrateEmbeds(editor);
      hydrateGalleries(editor);
    }
    emit();
    return true;
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
      raiseBubble(elementAnchor(anchor));
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

  // ── Resizing a picture ────────────────────────────────────────────────
  // Two ways, because they answer different questions. The presets on the bar
  // are for "make this a third of the column", which is a judgement about the
  // page; the corner handles are for "a bit smaller than that", which is a
  // judgement about the picture and is only ever going to be made by eye.

  /**
   * Drag a corner. `side` is which way the width follows the pointer: on the
   * left edge the picture grows as the pointer moves away from it, which is the
   * opposite of the right.
   */
  function startResize(e: React.PointerEvent<HTMLElement>, side: 1 | -1) {
    const img = imgEl;
    const editor = ref.current;
    if (!img || !editor) return;
    // Stop the browser starting a native drag of the image instead, and keep
    // the selection - and so the frame - exactly where it is.
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const max = columnWidthFor(img, editor);
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    // Before the first pixel moves, so the whole drag is one Ctrl+Z.
    record('struct');
    setDragW(Math.round(startW));

    const onPointerMove = (ev: PointerEvent) => {
      const next = Math.min(max, Math.max(MIN_IMG_W, startW + (ev.clientX - startX) * side));
      setImageWidth(img, next);
      setDragW(Math.round(next));
      // The frame is drawn round the picture, so it has to keep up within the
      // same frame as the picture does rather than a render later.
      placeFrame();
    };
    const onPointerUp = () => {
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
      setDragW(null);
      emit();
    };
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
  }

  /** One of the presets, as a fraction of the column the picture sits in. */
  function resizeImage(pct: number) {
    const img = imgEl;
    const editor = ref.current;
    if (!img || !editor) return;
    record('struct');
    // Never past the picture's own resolution: "full width" on a small image
    // should show it whole, not blow it up into a blurry one. An image that has
    // not loaded yet reports 0, in which case there is nothing to cap against.
    const natural = img.naturalWidth || Infinity;
    setImageWidth(img, Math.min(columnWidthFor(img, editor) * pct, natural));
    emit();
    selectNode(img);
  }

  function removeImage() {
    const editor = ref.current;
    const img = imgEl;
    if (!editor || !img) return;
    record('struct');
    const block = img.parentElement;
    const caret = document.createRange();
    caret.setStartAfter(img);
    caret.collapse(true);
    img.remove();
    if (block && block !== editor && !block.firstChild) block.appendChild(document.createElement('br'));
    const sel = window.getSelection();
    if (sel && editor.contains(caret.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(caret);
    }
    setImgEl(null);
    dropBubble();
    editor.focus();
    emit();
  }

  // ── Galleries ─────────────────────────────────────────────────────────
  // A fan of photographs, stored as one atomic island (see utils/noteGallery).
  // Everything here goes through createGallery rather than editing the stack in
  // place: the cards *are* the storage, so rebuilding from the list they read
  // back as is what keeps the "+N" badge and the fan honest after every change.

  /** Upload a set of files in order, and report them as gallery images. */
  async function uploadAll(files: File[]): Promise<GalleryImage[]> {
    const picked = files.filter(f => f.type.startsWith('image/'));
    if (!onUploadImage || picked.length === 0) return [];
    const out: GalleryImage[] = [];
    // Sequential rather than parallel, as insertImages is: uploads are
    // rate-limited per user, and the order they come back in is the order they
    // will be shown in.
    for (const file of picked) {
      const { url } = await onUploadImage(file);
      out.push({ src: url, alt: '' });
    }
    return out;
  }

  async function insertGallery(files: File[]) {
    if (!onUploadImage) return;
    setUploading(true);
    setUploadError(null);
    try {
      const picked = await uploadAll(files.slice(0, MAX_GALLERY_IMAGES));
      if (picked.length === 0) return;
      restoreImageRange();
      record('struct');
      writeGalleryAtSelection(picked);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  /**
   * Drop a gallery where the selection is. The same shape as
   * writeEmbedAtSelection, and for the same reasons - an atomic island cannot
   * hold a caret, so one is left in a space after it or the stack would be
   * impossible to type past.
   */
  function writeGalleryAtSelection(images: GalleryImage[]) {
    const editor = ref.current;
    const sel = window.getSelection();
    const node = createGallery(images);
    if (!editor || !sel || sel.rangeCount === 0 || !node) return;
    repairBlankBlock(editor);

    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(node);
    const after = document.createTextNode(' ');   // a plain space would collapse away
    node.after(after);
    const trailing = after.nextSibling;
    if (trailing && trailing.nodeName === 'BR' && !trailing.nextSibling) trailing.remove();

    const caret = document.createRange();
    caret.setStart(after, 1);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    emit();
  }

  async function addToGallery(files: File[]) {
    const target = pickTarget.current;
    if (!onUploadImage || !target?.isConnected) return;
    const existing = galleryImages(target);
    const room = MAX_GALLERY_IMAGES - existing.length;
    if (room <= 0) {
      setUploadError(`A gallery holds at most ${MAX_GALLERY_IMAGES} images`);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const picked = await uploadAll(files.slice(0, room));
      // The note may have been edited out from under the upload.
      if (picked.length === 0 || !target.isConnected) return;
      record('struct');
      replaceGallery(target, [...existing, ...picked]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  /**
   * Swap a gallery for one built from `images`, keeping the bar on it. Returns
   * the element that replaced it, which is not the one that went in - the fan
   * is rebuilt from the list rather than edited in place.
   */
  function replaceGallery(target: HTMLElement, images: GalleryImage[]): HTMLElement | null {
    const next = createGallery(images);
    if (!next) { removeGalleryEl(target); return null; }
    target.replaceWith(next);
    setGalleryEl(next);
    selectNode(next);
    emit();
    return next;
  }

  function removeGalleryEl(target: HTMLElement) {
    const editor = ref.current;
    if (!editor) return;
    const block = target.parentElement;
    const caret = document.createRange();
    caret.setStartAfter(target);
    caret.collapse(true);
    target.remove();
    // A block left holding nothing renders as a collapsed line the caret can't
    // enter, so give it the usual filler.
    if (block && block !== editor && !block.firstChild) block.appendChild(document.createElement('br'));
    const sel = window.getSelection();
    if (sel && editor.contains(caret.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(caret);
    }
    setGalleryEl(null);
    dropBubble();
    editor.focus();
    emit();
  }

  function removeGallery() {
    if (!galleryEl) return;
    record('struct');
    removeGalleryEl(galleryEl);
  }

  /**
   * Open the gallery over everything, at a given photo.
   *
   * The element is stashed rather than read back off `galleryEl` later: the
   * overlay takes focus, which drops the editor's selection and with it the bar
   * that was on the stack - and removing a photo from in here has to know which
   * stack it came out of.
   */
  function openGallery(el: HTMLElement | null, index = 0) {
    const images = galleryImages(el);
    if (!images.length) return;
    viewedGallery.current = el;
    setGalleryView({ images, index });
  }

  /**
   * Throw one photo out of the gallery being viewed.
   *
   * This is where per-image editing lives, rather than on the bar: the bar is
   * on the *stack*, where two of the photos are a sliver of an edge and the
   * rest are not drawn at all. You have to be looking at a picture to say you
   * don't want it, and looking at them one at a time is what the overlay is for.
   */
  function removeGalleryImage(index: number) {
    const el = viewedGallery.current;
    if (!el?.isConnected || readOnly) return;
    const next = galleryImages(el).filter((_, i) => i !== index);
    record('struct');
    if (next.length === 0) {
      removeGalleryEl(el);
      viewedGallery.current = null;
      setGalleryView(null);
      return;
    }
    viewedGallery.current = replaceGallery(el, next);
    setGalleryView({ images: next, index: Math.min(index, next.length - 1) });
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
    dropBubble();
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

  // Everything the bar can be *about* rather than the words under it. Cleared
  // together whenever the selection stops being on any of them.
  function clearObjectBars() {
    setEmbedEl(null);
    setImgEl(null);
    setGalleryEl(null);
    closeLinkBar();
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
    let meta: PageMeta = EMPTY_PAGE_META;
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
    dropBubble();
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
    dropBubble();
    ref.current?.focus();
    emit();
  }

  // Track the selection to light up the active marks and raise the bubble.
  //
  // Coalesced onto an animation frame. Typing moves the caret, so this fires on
  // every keystroke - and a mobile IME fires it several times per keystroke,
  // once for the composition and again for the commit. The work inside is all
  // forced layout (queryCommandState reads computed style, getBoundingClientRect
  // reads geometry), which on a long document is the most expensive thing the
  // editor does. Once per frame is as often as any of it can be seen.
  useEffect(() => {
    let frame = 0;
    function readSelection() {
      frame = 0;
      const el = ref.current;
      const sel = window.getSelection();
      if (readOnly) { dropBubble(); return; }
      if (!el || !sel || sel.rangeCount === 0) { dropBubble(); clearObjectBars(); return; }
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return; // selection elsewhere on the page
      refreshMarksIfMoved(sel.isCollapsed);
      setInTable(!!cellAtCaret(el));
      // A gallery is an atomic island like an embed, and is checked first
      // because it *contains* images: the picture lookup below would otherwise
      // claim a card out of the stack and offer to resize it on its own.
      const gallery = galleryInSelection(el);
      setGalleryEl(gallery);
      if (gallery) {
        setEmbedEl(null);
        setImgEl(null);
        closeLinkBar();
        raiseBubble(elementAnchor(gallery));
        return;
      }
      // An embed takes the bar over: formatting means nothing inside an atomic
      // island, and its own controls are what the selection is asking for.
      const embed = embedInSelection(el);
      setEmbedEl(embed);
      if (embed) {
        setImgEl(null);
        closeLinkBar();
        raiseBubble(elementAnchor(embed));
        return;
      }
      // A picture on its own is the third kind of object: not text to format,
      // and not an island to swap the size of, but something with a width you
      // can drag. The bar becomes its size controls and a frame goes round it.
      const picture = imageInSelection(el);
      setImgEl(picture);
      if (picture) {
        closeLinkBar();
        raiseBubble(elementAnchor(picture));
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
        raiseBubble(elementAnchor(anchor));
        return;
      }
      closeLinkBar();
      if (sel.isCollapsed || !sel.toString().trim()) { dropBubble(); return; }
      const r = range.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) { dropBubble(); return; }
      raiseBubble(rangeAnchor(range));
    }
    function onSelectionChange() {
      if (frame) return;
      frame = requestAnimationFrame(readSelection);
    }
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [readOnly]);

  // The command menu and the bubble should never be up at the same time
  // The heading menu belongs to the bubble, so it goes when the bubble does -
  // otherwise it would be left hanging over the page with nothing under it.
  useEffect(() => { if (!bubble) setHeadingOpen(false); }, [bubble]);

  useEffect(() => { if (slashOpen) dropBubble(); }, [slashOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // …nor should the bubble sit over the link dialog
  useEffect(() => { if (linkForm) dropBubble(); }, [linkForm]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /**
   * Closing a pair of inline markdown markers formats the text between them.
   * Returns true if it fired, so the caller skips the rest of the input pass.
   *
   * Everything about this is written to cost nothing on the keystrokes that
   * aren't a marker: one character comparison and out. Only when the character
   * just typed is one of `*_~\`` does it look at the line at all, and then only
   * at the text before the caret in the current node.
   */
  function maybeInlineFormat(): boolean {
    const editor = ref.current!;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode) return false;

    const node = sel.anchorNode;
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const offset = sel.anchorOffset;
    const text = node.textContent ?? '';
    if (offset === 0 || !INLINE_MD_TRIGGERS.includes(text[offset - 1])) return false;

    // Inside a code span or a code block the markers are the content. Same
    // reasoning as the block rules refusing to fire inside a list or a quote.
    const host = node.parentElement;
    if (!host || !editor.contains(host)) return false;
    if (host.closest('code, pre')) return false;

    const before = text.slice(0, offset);
    for (const rule of INLINE_MD) {
      const m = rule.re.exec(before);
      if (!m) continue;
      const start = before.length - m[0].length;
      // A one-character marker must not be the tail of a longer one, or typing
      // the fourth character of "**bold**" would italicise "*bold" on the way
      // past. It must not follow a word character either, which is what keeps
      // snake_case identifiers and 3*4*5 out of it.
      if (rule.solo) {
        const prev = start > 0 ? before[start - 1] : '';
        if (prev === rule.solo || /\w/.test(prev)) continue;
      }

      record('struct');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, offset);
      range.deleteContents();

      // Swap "**text**" for "text", select exactly that, and let the browser
      // format it - the same path the toolbar buttons take.
      const content = document.createTextNode(m[1]);
      range.insertNode(content);

      const pick = document.createRange();
      pick.setStart(content, 0);
      pick.setEnd(content, m[1].length);
      sel.removeAllRanges();
      sel.addRange(pick);

      if (rule.cmds.length) {
        for (const cmd of rule.cmds) document.execCommand(cmd);
        sel.collapseToEnd();
        // Toggling each one off again at the collapsed caret is what stops the
        // formatting running on into whatever gets typed next.
        for (const cmd of rule.cmds) document.execCommand(cmd);
      } else {
        wrapSelectionInCode();
      }

      refreshMarks();
      emit();
      return true;
    }
    return false;
  }

  function handleInput() {
    const editor = ref.current!;
    const sel = window.getSelection();

    if (!slashOpenRef.current && maybeAutoformat()) return;   // applyBlock emits
    if (!slashOpenRef.current && maybeInlineFormat()) return;  // emits its own

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
    if (cmd.id === 'image' || cmd.id === 'gallery') {
      ref.current?.focus();
      if (slashInfo.current) stripSlash();
      closeSlash();
      emit();
      pickImage(cmd.id === 'gallery' ? 'gallery' : 'image');
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
    // And /emoji and /colour: both panels open on the caret, so the "/emoji" or
    // "/colour" text has to be gone before its rectangle is measured.
    if (cmd.id === 'emoji' || cmd.id === 'color') {
      ref.current?.focus();
      if (slashInfo.current) stripSlash();
      closeSlash();
      emit();
      const sel = window.getSelection();
      const caretRect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : undefined;
      // A collapsed range can measure zero-by-zero; the button is a fine fallback.
      const rect = caretRect && caretRect.height > 0
        ? caretRect
        : emojiBtnRef.current?.getBoundingClientRect();
      if (cmd.id === 'emoji') openEmojiAt(rect);
      else openColorAt(rect);
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
    // The link dialog records on submit, and clearFormat records its own - both
    // would otherwise cost two undos to step back over one action.
    if (id !== 'link' && id !== 'clear') record('struct');
    if (slashInfo.current) stripSlash();
    repairBlankBlock(editor);
    switch (id) {
      case 'bold':       document.execCommand('bold'); break;
      case 'italic':     document.execCommand('italic'); break;
      case 'underline':  document.execCommand('underline'); break;
      case 'strike':     document.execCommand('strikeThrough'); break;
      case 'inlinecode': toggleInlineCode(); break;
      case 'clear':      closeSlash(); clearFormat(); return;
      case 'link':       closeSlash(); applyLink(); return;
    }
    closeSlash();
    refreshMarks();
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

  // Wrap the current selection in a code span and leave the caret *after* it.
  //
  // toggleInlineCode parks the caret inside, which is right when you pressed
  // the button and are about to type code. Here the span is already complete -
  // you typed the closing backtick - and what comes next is prose again.
  //
  // The caret goes into a text node of its own rather than at the element
  // boundary: contentEditable adopts a collapsed caret into the element on its
  // left, so a bare setStartAfter would put the next keystroke back inside the
  // code. The node is a zero-width space, which is the same device
  // toggleInlineCode already uses, and it is stripped on the way out (see
  // emit) so it never reaches storage.
  function wrapSelectionInCode() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const code = document.createElement('code');
    code.appendChild(range.extractContents());
    range.insertNode(code);

    const tail = document.createTextNode('​');
    code.parentNode?.insertBefore(tail, code.nextSibling);
    const after = document.createRange();
    after.setStart(tail, 1);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }

  function applyBlock(id: BlockId) {
    const editor = ref.current!;
    editor.focus();
    record('struct');
    if (slashInfo.current) stripSlash();

    const block = repairBlankBlock(editor) ?? getBlock(editor);

    // The block transforms, over whatever the selection actually touches. A
    // no-op when there is no selection in the editor, which is the one case the
    // browser used to handle by guessing.
    const retag = (tag: string) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      applyBlockTag(range, editor, tag);
      refreshMarks();
    };

    switch (id) {
      // Not execCommand('formatBlock'). It returns true and changes nothing
      // whenever the block is not the shape the browser expects - a heading
      // holding a picture, a paragraph that got wrapped in one after a bad
      // paste - which is a button that does nothing with no way to tell why.
      // See applyBlockTag in utils/noteFormat.
      case 'text':  retag('P'); break;
      case 'h1':    retag('H1'); break;
      case 'h2':    retag('H2'); break;
      case 'h3':    retag('H3'); break;
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
      case 'quote': retag('BLOCKQUOTE'); break;
      case 'code':  retag('PRE'); break;
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
    // A gallery is an atomic island: a click brackets the whole stack, which is
    // what raises its bar. Checked before the embed and the picture below,
    // because a card in the fan is an <img> inside it and would otherwise be
    // claimed by the picture branch and offered a resize handle of its own.
    const gallery = galleryAt(target, ref.current!);
    if (gallery) { e.preventDefault(); selectNode(gallery); return; }
    // An embed's anchor would otherwise navigate the whole app out from under
    // the note. A plain click selects it - the bar's Open (or Ctrl-click, just
    // handled) is how you follow it.
    const embed = embedAt(target, ref.current!);
    if (embed) { e.preventDefault(); selectNode(embed); return; }
    // Clicking a picture selects the picture. Chrome would otherwise drop a
    // caret beside it, which is a selection of nothing and leaves no way to
    // reach the size controls with a mouse.
    if (target instanceof HTMLImageElement) { e.preventDefault(); selectNode(target); return; }
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
      {/* On both bars, unlike the emoji button: colour is about the words you
          have selected, and the bubble is where a selection is. */}
      <ColorBtn open={!!colorAt} onOpen={openColorAt} onClose={closeColors} />
    </>
  );

  // Link, divider and clear formatting travel together as the "insert & strip"
  // group at the end of the bar
  const linkBtns = (
    <>
      <TBtn title="Add link" onRun={applyLink}><LinkIcon /></TBtn>
      {onUploadImage && (
        <>
          <TBtn
            title={uploading ? 'Uploading…' : 'Insert image - or paste and drop one'}
            onRun={() => pickImage('image')}
            disabled={uploading}
          >
            <ImageIcon />
          </TBtn>
          <TBtn
            title={uploading ? 'Uploading…' : 'Gallery - a stack of photos'}
            onRun={() => pickImage('gallery')}
            disabled={uploading}
          >
            <GalleryIcon />
          </TBtn>
        </>
      )}
      {references && (
        <TBtn title="Reference a saved article" onRun={openPicker}><ReferenceIcon /></TBtn>
      )}
      <TBtn title="Divider" onRun={() => applyBlock('hr')}><DividerIcon /></TBtn>
      <TBtn title="Clear formatting - back to plain text" onRun={clearFormat}><ClearIcon /></TBtn>
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

  // ── The gallery bar ──
  // A stack is one object, so the bar is about the stack: look through it, add
  // to it, or throw it away. Removing a single photo is not here - see
  // removeGalleryImage for why it belongs in the overlay instead.
  const galleryBtns = galleryEl && (
    <>
      <span className={styles.tbGroupLabel}>
        {galleryImages(galleryEl).length === 1
          ? '1 photo'
          : `${galleryImages(galleryEl).length} photos`}
      </span>
      <WordBtn title="Look through the gallery" onRun={() => openGallery(galleryEl)}>Open</WordBtn>
      {/* Gated on the uploader for the same reason the /gallery command is: a
          surface with nowhere to put a file cannot be offered one. A note
          written elsewhere can still *contain* a gallery, and it stays openable
          and removable here - only adding to it is out of reach. */}
      {onUploadImage && (
        <WordBtn
          title={uploading ? 'Uploading…' : 'Add more photos to this gallery'}
          onRun={() => { if (!uploading) pickImage('add'); }}
        >
          Add photos
        </WordBtn>
      )}
      <span className={styles.tbSep} />
      <WordBtn title="Remove the whole gallery" onRun={removeGallery} danger>Remove</WordBtn>
    </>
  );

  // ── The picture bar ──
  // Four presets, read as a fraction of the column rather than in pixels: the
  // question an author is actually answering is how much of the page this
  // photograph should take, and the column is what the answer is relative to.
  // The number beside them is the live width while a corner is being dragged.
  const imageBtns = !galleryEl && !embedEl && imgEl && (
    <>
      <span className={styles.tbGroupLabel}>Size</span>
      {IMG_SIZES.map(s => (
        <TBtn key={s.id} title={s.hint} onRun={() => resizeImage(s.pct)}>{s.label}</TBtn>
      ))}
      {dragW !== null && <span className={styles.tbReadout}>{dragW}px</span>}
      <span className={styles.tbSep} />
      <WordBtn title="Remove this image" onRun={removeImage} danger>Remove</WordBtn>
    </>
  );

  // ── The link bar ──
  // The same shape as the embed bar above, because a link is the same kind of
  // object: something with a size and a label. Editing the label happens in
  // place - a dialog for one field is a lot of ceremony for renaming a link.
  const linkBarBtns = !embedEl && !galleryEl && !imgEl && linkEl && (
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

  // The overlay is shared by both branches below: a gallery is worth looking
  // through in a trashed note too, which is often exactly when you want to.
  const galleryOverlay = galleryView && (
    <Lightbox
      images={galleryView.images}
      index={galleryView.index}
      onRemove={readOnly ? undefined : removeGalleryImage}
      onClose={() => { setGalleryView(null); viewedGallery.current = null; }}
    />
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
          onClick={e => {
            // Nothing here is selectable-as-an-object, so a gallery does the
            // thing it does everywhere it is read: opens on the card clicked.
            const g = galleryAt(e.target as Node, e.currentTarget);
            if (g) { e.preventDefault(); openGallery(g, galleryIndexOf(g, e.target as Node)); return; }
            if (openLinkAt(e.target as HTMLElement)) e.preventDefault();
          }}
        />
        {galleryOverlay}
      </div>
    );
  }

  return (
    <>
      {/* ── Utility bar ──
          In the source view it is one button: everything else on it acts on a
          selection in the rich surface, which is not the surface being typed
          into. Buttons that look pressable and do nothing are worse than
          buttons that are not there. */}
      <div className={styles.toolbar} ref={toolbarRef} role="toolbar" aria-label="Formatting">
        {sourceText !== null ? (
          <WordBtn
            title="Back to the formatted view"
            onRun={toggleSource}
          >
            Done
          </WordBtn>
        ) : (
        <>
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
        {/* Only on the bar above the note, not in the selection bubble: the
            bubble appears because text is selected, and inserting a character
            would replace it. */}
        <span className={styles.tbAnchor} ref={emojiBtnRef}>
          <TBtn title="Emoji" active={!!emojiAt} onRun={toggleEmoji}><EmojiIcon /></TBtn>
        </span>
        {linkBtns}
        <span className={styles.tbSep} />
        {/* Last on the bar, because it is the thing you reach for when the rest
            of the bar has not worked. */}
        <WordBtn title="Edit the markdown behind this post" onRun={toggleSource}>Markdown</WordBtn>
        </>
        )}

        {/* Row/column controls appear only while the caret is in a table. They
            take a row of their own - spelled out they'd wrap raggedly into the
            formatting buttons, and the caret can only ever be in one table.
            `inTable` is where the caret was left in the rich surface, so it
            outlives a switch to the source view and has to be gated too. */}
        {sourceText === null && inTable && (
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
          searched is its own obstacle.

          And it stays under it. The toolbar is sticky; this was not, so on a
          host where the page scrolls (the blog editor) stepping through hits
          scrolled the field you were typing in off the top of the screen while
          the bold button stayed put. Its resting place is the toolbar's, plus
          however tall the toolbar currently is. */}
      {findOpen && (
        <div
          className={styles.findBar}
          style={{ top: `calc(var(--editor-toolbar-top, 0px) + ${toolbarH}px)` }}
          role="search"
          aria-label="Find and replace"
        >
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

      {/* ── The object frame ──
          Drawn round the selected picture or gallery, outside the editable
          surface so nothing about it can end up in the saved document. The
          handles are on the two bottom corners only: those are the ones that
          resize downwards into empty page rather than up through the text
          above, and a picture's aspect ratio is held, so the four corners of a
          box would all be doing the same job. */}
      {frameTarget && createPortal(
        <div
          ref={frameRef}
          className={`${styles.objFrame} ${dragW !== null ? styles.objFrameBusy : ''}`}
          aria-hidden
        >
          {imgEl && (
            <>
              <span
                className={`${styles.objHandle} ${styles.objHandleSW}`}
                onPointerDown={e => startResize(e, -1)}
              />
              <span
                className={`${styles.objHandle} ${styles.objHandleSE}`}
                onPointerDown={e => startResize(e, 1)}
              />
            </>
          )}
        </div>,
        document.body
      )}

      {galleryOverlay}

      {/* ── Selection bubble ──
          One bar, two jobs: formatting for a run of text, and the embed's own
          controls when the selection is an atomic island instead. */}
      {bubble && createPortal(
        <div ref={bubbleRef} className={styles.bubble} style={{ left: bubble.left, top: bubble.top }}>
          {galleryBtns || imageBtns || embedBtns || linkBarBtns || (
            <>
              {inlineBtns}
              <span className={styles.tbSep} />
              <HeadingPicker
                current={blockTag}
                open={headingOpen}
                onToggle={() => setHeadingOpen(o => !o)}
                onPick={id => { setHeadingOpen(false); applyBlock(id); }}
              />
              <TBtn title="Quote" onRun={() => applyBlock('quote')}><QuoteIcon /></TBtn>
              <span className={styles.tbSep} />
              {linkBtns}
            </>
          )}
        </div>,
        document.body
      )}

      {/* ── Colour picker ──
          Text colour and highlight in one panel, because they are one decision:
          you are here to make a phrase stand out, and which of the two does it
          is the choice, not a separate errand. */}
      {colorAt && createPortal(
        <div
          ref={colorRef}
          className={styles.colorPanel}
          style={{ left: colorAt.left, top: colorAt.top }}
          role="dialog"
          aria-label="Text colour and highlight"
        >
          <ColorRow
            label="Text"
            kind="fg"
            current={colorOn.fg}
            clearLabel="Default"
            onPick={id => applyPaletteColor('fg', id)}
          />
          <ColorRow
            label="Highlight"
            kind="bg"
            current={colorOn.bg}
            clearLabel="None"
            onPick={id => applyPaletteColor('bg', id)}
          />
        </div>,
        document.body
      )}

      {/* ── Emoji picker ── */}
      {emojiAt && createPortal(
        <div
          ref={emojiRef}
          className={styles.emojiPanel}
          style={{ left: emojiAt.left, top: emojiAt.top }}
          role="dialog"
          aria-label="Emoji"
        >
          <div className={styles.emojiSearch}>
            <input
              ref={emojiInputRef}
              className={styles.emojiSearchInput}
              value={emojiQuery}
              onChange={e => setEmojiQuery(e.target.value)}
              // Enter takes the first match, so the whole thing can be done
              // without leaving the keyboard: "/emoji", "heart", Enter.
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const first = emojiResults?.[0];
                if (first) insertEmoji(first.ch);
              }}
              placeholder="Search - heart, <3, :)"
              aria-label="Search emoji"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className={styles.emojiList}>
            {emojiResults
              ? (emojiResults.length > 0
                ? <div className={styles.emojiGrid}>{emojiResults.map(emojiButton)}</div>
                : <div className={styles.emojiEmpty}>Nothing matches “{emojiQuery.trim()}”</div>)
              : EMOJI_GROUPS.map(g => (
                <div key={g.name}>
                  <div className={styles.emojiGroupLabel}>{g.name}</div>
                  <div className={styles.emojiGrid}>{g.items.map(emojiButton)}</div>
                </div>
              ))}
          </div>
        </div>,
        document.body
      )}

    <div className={styles.editorScroll} ref={scrollRef}>
      {sourceText !== null && (
        <textarea
          className={styles.sourceArea}
          value={sourceText}
          onChange={e => applySource(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Markdown source"
          // The document is being typed into as text; a Tab here should indent
          // rather than leave for the next control, which is what every code
          // editor does and what a list needs.
          onKeyDown={e => {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: from, selectionEnd: to } = el;
            const next = `${sourceText.slice(0, from)}  ${sourceText.slice(to)}`;
            applySource(next);
            // Assigning `value` moves the caret to the end, so put it back
            // where the two spaces just went.
            requestAnimationFrame(() => el.setSelectionRange(from + 2, from + 2));
          }}
          autoFocus
        />
      )}
      <div
        ref={ref}
        // Hidden rather than unmounted while the source view is open: the mount
        // effect that seeds this element runs once, so tearing it down would
        // leave nothing to put the content back into.
        hidden={sourceText !== null}
        className={styles.editor}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onClick={handleClick}
        // A single click selects the stack (there has to be a way to reach its
        // bar); a double click is the "open it" gesture every file browser has
        // trained people in, and lands on the card that was double-clicked.
        onDoubleClick={e => {
          const g = galleryAt(e.target as Node, e.currentTarget);
          if (!g) return;
          e.preventDefault();
          openGallery(g, galleryIndexOf(g, e.target as Node));
        }}
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
// Search what there is to cite and choose one. The size chosen here is only the
// starting point - selecting the embed afterwards switches between the three
// without losing anything, so this defaults to the middle one and gets out of
// the way. Escape is swallowed so it dismisses the picker, not the console.
//
// The list is whatever the surface handed over, already in embed shape: today
// that is the reading list and the author's own posts, and the picker is none
// the wiser about either.

// What a row calls itself, where the two kinds would otherwise look alike - a
// post's provenance is a person's name, which reads exactly like a publication.
const REF_KIND_HINT: Partial<Record<EmbedKind, string>> = { post: 'Your post' };

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
      <div className={styles.refDialog} onKeyDown={onKeyDown} role="dialog" aria-label="Reference an article or a post">
        <div className={styles.linkTitle}>Reference</div>

        <input
          ref={inputRef}
          className={styles.linkInput}
          value={query}
          onChange={e => { setQuery(e.target.value); setIdx(0); }}
          placeholder="Search saved articles and your posts"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search saved articles and your posts"
        />

        <div className={styles.refList} ref={listRef}>
          {results.length === 0 && (
            <div className={styles.refEmpty}>
              {items.length === 0
                ? 'Nothing to reference yet - save an article to your reading list, or write a post.'
                : `Nothing matches “${query.trim()}”`}
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
                  {[REF_KIND_HINT[d.kind], d.source, d.meta].filter(Boolean).join(' · ')}
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

// The heading control in the selection bubble.
//
// It used to be a lone "H2" button, which was an odd thing to offer: of the
// three heading levels the editor has, one of them was reachable from the bar
// that appears when you select text and the other two were not. This shows
// which level the selection is already at and opens onto all of them, plus the
// way back to body text.
const HEADING_LEVELS: { id: BlockId; label: string; badge: string }[] = [
  { id: 'h1',   label: 'Heading 1',  badge: 'H1' },
  { id: 'h2',   label: 'Heading 2',  badge: 'H2' },
  { id: 'h3',   label: 'Heading 3',  badge: 'H3' },
  { id: 'text', label: 'Plain text', badge: '¶'  },
];

function HeadingPicker({ current, open, onToggle, onPick }: {
  /** nodeName of the block the caret is in, e.g. 'H2'. */
  current: string;
  open: boolean;
  onToggle: () => void;
  onPick: (id: BlockId) => void;
}) {
  const level = /^H[123]$/.test(current) ? current : null;
  return (
    <span className={styles.headingPick}>
      <button
        type="button"
        className={`${styles.tbBtn} ${level ? styles.tbBtnActive : ''}`}
        title="Heading level"
        aria-label="Heading level"
        aria-expanded={open}
        aria-haspopup="menu"
        onMouseDown={e => e.preventDefault()}
        onClick={onToggle}
      >
        {/* The current level, so the button reports as well as offers. */}
        {level ?? 'H'}
        <span className={styles.headingCaret} aria-hidden>▾</span>
      </button>
      {open && (
        <span className={styles.headingMenu} role="menu">
          {HEADING_LEVELS.map(h => (
            <button
              key={h.id}
              type="button"
              role="menuitem"
              className={`${styles.headingItem} ${current === h.id.toUpperCase() ? styles.headingItemOn : ''}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => onPick(h.id)}
            >
              {/* Each row is set at the size it produces, so the choice is
                  visible rather than read. */}
              <span className={`${styles.headingSample} ${styles[h.id]}`}>{h.badge}</span>
              <span className={styles.headingLabel}>{h.label}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// The colour button, which appears on both bars. It carries its own anchor ref
// rather than borrowing one from the editor: there are two of these on screen at
// once when the bubble is up, and the panel belongs under whichever was pressed.
function ColorBtn({ open, onOpen, onClose }: {
  open: boolean;
  onOpen: (rect: DOMRect | undefined) => void;
  onClose: () => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    // Marked rather than tracked by ref: there are two of these on screen when
    // the bubble is up, and the "did the click land outside?" test has to
    // recognise either of them. Without it, pressing the button that opened the
    // panel would close it on mousedown and reopen it on click.
    <span className={styles.tbAnchor} ref={anchor} data-color-btn="">
      <TBtn
        title="Text colour and highlight"
        active={open}
        onRun={() => (open ? onClose() : onOpen(anchor.current?.getBoundingClientRect()))}
      >
        <ColorIcon />
      </TBtn>
    </span>
  );
}

// One half of the colour panel: eight swatches and the way back out of them.
//
// A text swatch is the letter set in its own colour, and a highlight swatch is
// that letter *on* its wash - so each one is a sample of what pressing it does,
// rather than a dot you have to imagine applied. The current choice wears a
// ring, which is also the only affordance saying a colour can be turned off
// again by pressing the row's Default/None.
function ColorRow({ label, kind, current, clearLabel, onPick }: {
  label: string;
  kind: ColorKind;
  current: string | null;
  clearLabel: string;
  onPick: (id: string | null) => void;
}) {
  return (
    <div className={styles.colorGroup}>
      <div className={styles.colorHead}>
        <span className={styles.colorLabel}>{label}</span>
        <button
          type="button"
          className={styles.colorClear}
          title={`${label}: back to the default`}
          onMouseDown={e => e.preventDefault()}
          onClick={() => onPick(null)}
        >
          {clearLabel}
        </button>
      </div>
      <div className={styles.colorGrid} role="group" aria-label={label}>
        {PALETTE.map(c => (
          <button
            key={c.id}
            type="button"
            className={`${styles.colorSwatch} ${current === c.id ? styles.colorSwatchOn : ''}`}
            // Painted from the very token the class it writes resolves to - the
            // class and the custom property share a name on purpose (see
            // styles/noteColor.css), so the panel cannot drift from what lands
            // in the document, or from the theme.
            style={kind === 'fg'
              ? { color: `var(--${colorClass(kind, c.id)})` }
              : { background: `var(--${colorClass(kind, c.id)})` }}
            title={c.label}
            aria-label={`${label}: ${c.label}`}
            aria-pressed={current === c.id}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onPick(c.id)}
          >
            A
          </button>
        ))}
      </div>
    </div>
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
