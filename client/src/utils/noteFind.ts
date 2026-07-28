// Find & replace inside the editor's live DOM.
//
// The problem this solves: a match is a run of *characters*, but the editor
// stores them across many text nodes. "the <b>quick</b> fox" is three nodes, so
// searching each node on its own never finds "quick fox". So we flatten the
// editable text into one string, remember where each text node landed in it,
// search the string, then map hits back to DOM Ranges.
//
// Nothing here mutates the document except `replaceAll`, and callers are
// expected to wrap that in the editor's undo bookkeeping.

// Elements that end a line of text. Two runs on opposite sides of one of these
// are not adjacent, so a separator goes between them in the flat string - it is
// what stops "<p>one</p><p>two</p>" from matching the query "onetwo".
const BLOCK = /^(P|DIV|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|TABLE|THEAD|TBODY|TR|TD|TH|UL|OL|HR|FIGURE|FIGCAPTION)$/;

// A separator that no query can contain (the find field is a single-line input),
// which is precisely why a match can never span one.
const GAP = '\n';

// Embeds are atomic - a reference card is one indivisible thing whose text is
// generated markup, not prose. Typing into one is already prevented; replacing
// inside one would corrupt it, so its text never enters the search at all.
const EMBED_SELECTOR = '.note-embed';

export interface TextSpan {
  node: Text;
  start: number;   // inclusive offset of this node's text in the flat string
  end: number;     // exclusive
}

export interface FlatText {
  text: string;
  spans: TextSpan[];
}

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface Match {
  start: number;   // offsets into FlatText.text
  end: number;
}

function isBlock(el: Element): boolean {
  return BLOCK.test(el.nodeName);
}

// The nearest enclosing element that behaves as a line. Two text nodes under
// different ones are on different lines and get a GAP between them.
function blockOf(node: Node, root: HTMLElement): Node {
  let el = node.parentElement;
  while (el && el !== root && !isBlock(el)) el = el.parentElement;
  return el ?? root;
}

/**
 * Flatten the editor's searchable text into one string plus the map back to the
 * text nodes it came from. Embed subtrees are skipped; line boundaries (block
 * elements and <br>) become a GAP that belongs to no node.
 */
export function flattenText(root: HTMLElement): FlatText {
  const spans: TextSpan[] = [];
  let text = '';
  let prevBlock: Node | null = null;
  let pendingGap = false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // Rejecting an element skips its whole subtree, which is exactly the
        // treatment an atomic embed wants.
        if ((node as Element).matches?.(EMBED_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    const node = walker.currentNode;

    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.nodeName === 'BR') pendingGap = true;
      continue;
    }

    const data = (node as Text).data;
    if (!data) continue;

    const block = blockOf(node, root);
    // A GAP is only worth writing once there is text on both sides of it.
    if (text && (pendingGap || (prevBlock !== null && block !== prevBlock))) text += GAP;
    pendingGap = false;
    prevBlock = block;

    const start = text.length;
    text += data;
    spans.push({ node: node as Text, start, end: text.length });
  }

  return { text, spans };
}

const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD.test(ch);
}

/**
 * Every non-overlapping occurrence of `query` in `text`, scanned left to right.
 * An empty query matches nothing - the caller wants "no search", not "every
 * position".
 */
export function findMatches(text: string, query: string, opts: FindOptions = {}): Match[] {
  if (!query || !text) return [];
  // A query can never span a line boundary, so one containing the separator
  // cannot match anything. Bail rather than scan for something impossible.
  if (query.includes(GAP)) return [];

  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? query : query.toLowerCase();

  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    if (
      !opts.wholeWord ||
      (!isWordChar(hay[at - 1]) && !isWordChar(hay[end]))
    ) {
      out.push({ start: at, end });
    }
    // Advance past the hit whether or not it was kept, so a rejected
    // whole-word candidate cannot be re-examined forever.
    from = at + Math.max(needle.length, 1);
  }
  return out;
}

// The span holding a flat offset. `atEnd` picks which side of a node boundary
// wins: a match ending exactly where a node ends belongs to that node, not to
// the start of the next one.
function spanAt(spans: TextSpan[], offset: number, atEnd: boolean): TextSpan | null {
  let lo = 0;
  let hi = spans.length - 1;
  let found: TextSpan | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    const covers = atEnd ? s.start < offset && offset <= s.end : s.start <= offset && offset < s.end;
    if (covers) { found = s; break; }
    if (offset < s.start || (atEnd && offset <= s.start)) hi = mid - 1;
    else lo = mid + 1;
  }
  return found;
}

/**
 * Turn a flat-string match back into a live DOM Range. Returns null if the
 * offsets don't land in any text node, which means the DOM moved under us.
 */
export function rangeOf(flat: FlatText, match: Match): Range | null {
  const startSpan = spanAt(flat.spans, match.start, false);
  const endSpan = spanAt(flat.spans, match.end, true);
  if (!startSpan || !endSpan) return null;
  const range = document.createRange();
  try {
    range.setStart(startSpan.node, match.start - startSpan.start);
    range.setEnd(endSpan.node, match.end - endSpan.start);
  } catch {
    return null;
  }
  return range;
}

/**
 * Every match of `query` under `root`, as live Ranges in document order.
 */
export function findRanges(root: HTMLElement, query: string, opts: FindOptions = {}): Range[] {
  const flat = flattenText(root);
  const out: Range[] = [];
  for (const m of findMatches(flat.text, query, opts)) {
    const r = rangeOf(flat, m);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Swap one match for `text`. The caret is left after the inserted text so a
 * replace-then-type reads naturally.
 */
export function replaceRange(range: Range, text: string): Range {
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  const after = document.createRange();
  after.setStart(node, text.length);
  after.collapse(true);
  return after;
}

/**
 * Replace every match under `root`, returning how many were changed.
 *
 * Works back to front: replacing the last match first means the earlier ranges
 * still point at untouched DOM. Normalizing once at the end merges the text
 * nodes the insertions fragmented - doing it per replacement would invalidate
 * the ranges still waiting their turn.
 */
export function replaceAll(
  root: HTMLElement, query: string, replacement: string, opts: FindOptions = {},
): number {
  const ranges = findRanges(root, query, opts);
  for (let i = ranges.length - 1; i >= 0; i--) replaceRange(ranges[i], replacement);
  if (ranges.length) root.normalize();
  return ranges.length;
}
