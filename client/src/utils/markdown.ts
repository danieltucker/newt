// Markdown to editor HTML.
//
// The editor already understands markdown as you type: "## " turns the block
// into a heading, "- " into a list (see MD_RULES in RichEditor). What it could
// not do was take a whole document at once, so pasting anything written
// elsewhere - a note out of another app, a chunk of a README, an answer from a
// chatbot - dropped a wall of asterisks and hashes into the page and left you
// to reformat it by hand.
//
// This is deliberately not a full CommonMark implementation. It covers what
// people actually paste and what the editor can actually render: headings,
// both kinds of list, to-dos, quotes, fenced and indented code, rules, tables,
// and the inline run of bold/italic/strike/code/links. Anything it does not
// recognise survives as its own paragraph with its text intact, which is the
// property that matters - a paste is never allowed to lose words.
//
// The output is the same shape the editor writes for itself, so a pasted
// document and a typed one are indistinguishable afterwards. TODO_CLASS and
// TABLE_CLASS are duplicated here rather than imported from RichEditor because
// they are part of the saved document format, not of the component.

const TODO_CLASS = 'note-todo';
const TABLE_CLASS = 'note-table';

// ── Raw HTML, for the round trip and nothing else ────────────────────────────
//
// Markdown has no spelling for a reference embed, a gallery, a coloured run or
// a picture the author resized, and the editor writes all four. A source view
// that silently dropped them would be a feature that eats your work the second
// time you open it, so htmlToMarkdown emits those as HTML and this reads them
// back — the same escape hatch markdown has always had for the same reason.
//
// Both directions are opt-in (see the source parameter). Everything that has
// ever pasted markdown into this module keeps the behaviour it had: escaped up
// front, no tags in the result but the ones put there deliberately.
const RAW_INLINE_TAG = /<\/?(?:b|strong|i|em|u|s|strike|del|code|a|span|br|img)\b[^>]*>/gi;

/**
 * Whether a line opens a run of raw HTML — a block that is copied through
 * verbatim until the next blank line.
 *
 * A bare `<span>` does not qualify: an inline span opening a paragraph is a
 * sentence, not a block, and it is handled by the inline pass instead. One of
 * *ours* does, because an embed or a gallery is a whole object that happens to
 * be spelled as a span.
 */
function startsRawBlock(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('<')) return false;
  if (/^<span\b/i.test(t)) return /class="[^"]*\bnote-(embed|gallery)\b/i.test(t);
  return /^<(p|div|table|ul|ol|blockquote|pre|h[1-6]|hr|img|figure|section)\b/i.test(t);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Does this text look like markdown worth converting?
 *
 * Pasting plain prose must not go through the converter: it would still come
 * out as a paragraph, but any stray asterisk or underscore in the text would be
 * read as emphasis, and a line starting with a hyphen would silently become a
 * bullet. So the bar is a construct that is unambiguous at the start of a line,
 * or a paired inline marker - things people do not type by accident.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  const block = [
    /^#{1,6}\s+\S/m,          // # Heading
    /^\s*[-*+]\s+\S/m,        // - bullet
    /^\s*\d+[.)]\s+\S/m,      // 1. numbered
    /^\s*>\s+\S/m,            // > quote
    /^\s*[-*+]\s+\[[ xX]\]/m, // - [ ] to-do
    /^```/m,                  // fenced code
    /^\s*(\|.*\|)\s*$/m,      // | table |
    /^\s*(---|\*\*\*|___)\s*$/m,
  ];
  if (block.some(re => re.test(text))) return true;
  // Paired inline markers. Bold and code only - single asterisks and
  // underscores turn up in ordinary text far too often (file_names, 3 * 4) to
  // be treated as a signal on their own.
  return /\*\*[^*\n]+\*\*/.test(text) || /`[^`\n]+`/.test(text);
}

/**
 * The inline run: code first, because a span of code is literal and nothing
 * inside it may be interpreted, then links, then the emphasis markers longest
 * first so `**` is claimed before `*`.
 *
 * Everything is escaped up front, so the only tags in the result are the ones
 * put there here.
 */
export function inlineMarkdown(src: string, source = false): string {
  // Raw inline HTML, pulled out before anything else touches it.
  //
  // Off by default, and that default is the safety property this function has
  // always had: everything is escaped up front, so the only tags in the result
  // are the ones put there here \u2014 which is what makes it safe to point at a
  // pasted clipboard. It is turned on for exactly one caller, the editor's own
  // source view, where the markdown was produced by htmlToMarkdown a moment ago
  // and carries the constructs markdown has no spelling for. That caller runs
  // the result through the paste allowlist afterwards; see markdownToHtml.
  const raw: string[] = [];
  const input = source
    ? src.replace(RAW_INLINE_TAG, m => {
        raw.push(m);
        return `\uE001H${raw.length - 1}\uE001`;
      })
    : src;

  const code: string[] = [];
  // Pulled out and replaced by a placeholder built from a private-use
  // codepoint, which escapeHtml can never produce, so the emphasis and link
  // passes below cannot reach inside a span of code and rewrite it.
  let s = escapeHtml(input).replace(/`([^`]+)`/g, (_, body) => {
    code.push(body);
    return `\uE000C${code.length - 1}\uE000`;
  });

  // Backslash-escaped punctuation, pulled out the same way and for the same
  // reason: what it protects must not be read as a marker by the passes below.
  //
  // Only in the source dialect. Ordinary pasted markdown keeps the behaviour it
  // has always had, where a backslash is a backslash — a Windows path or a
  // regex in a chat message is a far more likely thing to paste than a
  // deliberate escape, and eating the backslash out of one is a silent
  // corruption of somebody's text.
  const escapes: string[] = [];
  if (source) {
    s = s.replace(/\\([!-\/:-@[-`{-~])/g, (_, ch: string) => {
      escapes.push(ch);
      return `E${escapes.length - 1}`;
    });
  }

  // ![alt](src), before the link rule that would otherwise claim the bracket
  // pair and leave the "!" stranded in front of it.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
    const safe = safeHref(src);
    if (!safe) return m;
    return `<img src="${safe}" alt="${alt}">`;
  });

  // [label](href). The href is checked before it is written: a javascript: or
  // data: URL in a pasted document is somebody else's idea, not the reader's.
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label, href) => {
    const safe = safeHref(href);
    if (!safe) return m;
    return `<a href="${safe}">${label || safe}</a>`;
  });

  // Bare autolinks in <>
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (m, href) => {
    const safe = safeHref(href);
    return safe ? `<a href="${safe}">${safe}</a>` : m;
  });

  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<i>$2</i>');
  // Underscores only between non-word characters, so snake_case_names and
  // __dunder__ identifiers in prose survive intact.
  s = s.replace(/(^|[^_\w])__([^_\n]+)__(?![_\w])/g, '$1<b>$2</b>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<i>$2</i>');

  s = s.replace(/\uE000C(\d+)\uE000/g, (_, i) => `<code>${code[Number(i)]}</code>`);
  if (!source) return s;
  // The escaped character itself, as text \u2014 escapeHtml ran long before this, so
  // a `<` or an `&` that was protected by a backslash still has to be escaped.
  s = s.replace(/\uE002E(\d+)\uE002/g, (_, i) => escapeHtml(escapes[Number(i)]));
  return s.replace(/\uE001H(\d+)\uE001/g, (_, i) => raw[Number(i)]);
}

// http, https, mailto and relative links only. Everything else - javascript:,
// data:, vbscript: - is refused, and the caller leaves the original text alone.
function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/&quot;/g, '');
  if (/^(https?:|mailto:)/i.test(href)) return escapeHtml(href);
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;   // some other scheme
  if (/^(\/|#|\.)/.test(href)) return escapeHtml(href);  // relative
  if (/^[\w-]+(\.[\w-]+)+/.test(href)) return escapeHtml(`https://${href}`);
  return null;
}

interface ListItem {
  indent: number;
  html: string;
  /** null unless this is a to-do, in which case it is the checked state. */
  done: boolean | null;
}

// The editor's to-do is a block of its own - a <div class="note-todo"> with a
// data-checked attribute - not a list item. Markdown spells one as a bullet
// ("- [ ] thing"), so a run of them has to come out of the list and become
// blocks, or they paste as bullets with no checkbox and no way to tick them.
// Depth rides on data-indent, which is what the editor's own Tab handling
// writes (see indentBlock in RichEditor).
const MAX_INDENT = 5;

function renderTodos(items: ListItem[]): string {
  return items.map(it => {
    const depth = Math.min(it.indent, MAX_INDENT);
    const indent = depth > 0 ? ` data-indent="${depth}"` : '';
    return `<div class="${TODO_CLASS}" data-checked="${it.done ? 'true' : 'false'}"${indent}>${it.html}</div>`;
  }).join('');
}

// One flat run of list items, nested by indent. Recursive because markdown
// nesting is a tree and the editor's markup is one too. Returns where it
// stopped as well as what it built, so the caller can pick up after a nested
// run without rescanning.
function renderList(items: ListItem[], ordered: boolean, from: number, depth: number): { html: string; next: number } {
  const tag = ordered ? 'ol' : 'ul';
  let out = `<${tag}>`;
  let i = from;
  while (i < items.length && items[i].indent >= depth) {
    const item = items[i];
    if (item.indent > depth) {
      const nested = renderList(items, ordered, i, item.indent);
      out = out.replace(/<\/li>$/, `${nested.html}</li>`);
      i = nested.next;
      continue;
    }
    out += `<li>${item.html}</li>`;
    i++;
  }
  return { html: out + `</${tag}>`, next: i };
}

function renderTable(rows: string[][], source: boolean): string {
  const [head, ...body] = rows;
  const cells = (r: string[], tag: 'th' | 'td') =>
    r.map(c => `<${tag}>${inlineMarkdown(c, source)}</${tag}>`).join('');
  const thead = `<thead><tr>${cells(head, 'th')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map(r => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody>`
    : '';
  return `<table class="${TABLE_CLASS}">${thead}${tbody}</table>`;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

/** A |---|---| separator, which is what tells a table from lines of pipes. */
function isTableRule(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

/**
 * A markdown document as editor HTML.
 *
 * Block-level, line by line. Anything unrecognised falls through to a
 * paragraph, so no input can produce empty output.
 */
export function markdownToHtml(src: string, opts: { source?: boolean } = {}): string {
  const allow = !!opts.source;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (!line.trim()) { i++; continue; }

    // A run of raw HTML, copied through as it stands until the next blank line.
    // Only for the source view (see source): this is how an embed, a gallery
    // or a resized picture makes the trip back through markdown, which has no
    // spelling of its own for any of them.
    if (allow && startsRawBlock(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
      out.push(body.join('\n'));
      continue;
    }

    // Fenced code. An unterminated fence runs to the end of the document
    // rather than being abandoned - the text is what matters.
    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++; // the closing fence
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Indented code, four spaces or a tab. Only when it isn't a list
    // continuation, which is why the list branches come first for indents.
    if (/^(\t| {4})/.test(line) && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^(\t| {4})/.test(lines[i]) || !lines[i].trim())) {
        if (!lines[i].trim() && !(i + 1 < lines.length && /^(\t| {4})/.test(lines[i + 1]))) break;
        body.push(lines[i++].replace(/^(\t| {4})/, ''));
      }
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // ATX heading. The editor has h1-h3; deeper levels flatten to h3 rather
    // than being dropped, since an h4 is still a heading.
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = Math.min(h[1].length, 3);
      out.push(`<h${level}>${inlineMarkdown(h[2], allow)}</h${level}>`);
      i++;
      continue;
    }

    // Setext heading: a line underlined with === or ---. The --- case is only
    // a heading if there is text above it, otherwise the rule above claimed it.
    if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && line.trim()) {
      const level = lines[i + 1].trim().startsWith('=') ? 1 : 2;
      out.push(`<h${level}>${inlineMarkdown(line.trim(), allow)}</h${level}>`);
      i += 2;
      continue;
    }

    // Table: a header row followed by a |---| rule.
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i++]));
      }
      out.push(renderTable(rows, allow));
      continue;
    }

    // Quote. Consecutive > lines join into one block, and the markers are
    // stripped before the contents are run through the inline pass.
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      out.push(`<blockquote>${inlineMarkdown(body.join(' '), allow)}</blockquote>`);
      continue;
    }

    // Lists, including to-dos. A run stops at the first line that is neither an
    // item nor the continuation of one.
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = lines[i].match(bullet);
        if (!m) {
          // A plain indented line continues the item above it.
          if (items.length && /^\s+\S/.test(lines[i]) && lines[i].trim()) {
            items[items.length - 1].html += ` ${inlineMarkdown(lines[i].trim(), allow)}`;
            i++;
            continue;
          }
          break;
        }
        // A switch between bullets and numbers starts a new list.
        if (/^\s*\d/.test(lines[i]) !== ordered) break;
        const todo = m[3].match(/^\[([ xX])\]\s*(.*)$/);
        items.push({
          // Two spaces per level is the common convention; a tab counts as one
          // level however wide it is.
          indent: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
          html: inlineMarkdown(todo ? todo[2] : m[3], allow),
          done: todo ? todo[1].toLowerCase() === 'x' : null,
        });
        i++;
      }
      // Levels are relative to the shallowest item, so a whole list indented by
      // two spaces doesn't come out nested inside an empty one.
      const base = Math.min(...items.map(it => it.indent));
      items.forEach(it => { it.indent -= base; });

      // To-dos are blocks and bullets are list items, so a run that mixes them
      // becomes several runs. Grouping consecutive items of a kind keeps a
      // plain list one list rather than one per line.
      let g = 0;
      while (g < items.length) {
        const isTodo = items[g].done !== null;
        let end = g;
        while (end < items.length && (items[end].done !== null) === isTodo) end++;
        const group = items.slice(g, end);
        out.push(isTodo ? renderTodos(group) : renderList(group, ordered, 0, 0).html);
        g = end;
      }
      continue;
    }

    // Paragraph. Runs to the next blank line or block construct; the lines are
    // joined with a space, which is what markdown means by a soft break.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim()
           && !startsBlock(lines[i], lines[i + 1])
           && !(allow && startsRawBlock(lines[i]))) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) para.push(lines[i++].trim());   // never loop forever
    out.push(`<p>${inlineMarkdown(para.join(' '), allow)}</p>`);
  }

  return out.join('') || '<p><br></p>';
}

// Whether a line inside a paragraph run starts something else. `next` is needed
// for the two constructs that are only recognisable from the line below them:
// setext headings and tables.
function startsBlock(line: string, next: string | undefined): boolean {
  return /^\s*(#{1,6}\s|>|```|~~~)/.test(line)
    || /^\s*([-*+]|\d+[.)])\s+\S/.test(line)
    || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || (!!next && /^\s*(=+|-+)\s*$/.test(next))
    || (line.includes('|') && !!next && isTableRule(next));
}

// ── The other direction: editor HTML back to markdown ────────────────────────
//
// For the editor's source view, which exists because a document can end up in a
// shape the rich surface cannot easily talk you out of — everything a heading
// after a bad paste, a stray block that will not become a paragraph. Seeing the
// document as text is the shortest route from "this is wrong" to "this is
// fixed", and it is a view of the same document rather than a different format
// it gets converted into: what comes out of here goes back through
// markdownToHtml, and both halves have to agree or the round trip loses work.
//
// ── What is not markdown ──
// Reference embeds, galleries, coloured runs, underlines and pictures the author
// resized have no markdown spelling. They are emitted as the HTML they already
// are, on their own line, and markdownToHtml reads them straight back (see
// startsRawBlock). It makes the source view a little less pretty and a great
// deal more honest: switching to markdown and back is not allowed to quietly
// delete somebody's photographs.

/** Heading depth by tag. The editor has three; deeper ones flatten, as they do coming the other way. */
const HEADING_LEVEL: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 3, H5: 3, H6: 3 };

/** Characters that would change meaning if the text around them were read as markdown. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*[\]])/g, '\\$1');
}

/** Whether this element carries formatting markdown cannot express. */
function needsRawHtml(el: Element): boolean {
  if (el.classList.contains('note-embed') || el.classList.contains('note-gallery')) return true;
  // A colour is a class on a span, and there is no markdown for one.
  if (el.nodeName === 'SPAN') return true;
  if (el.nodeName === 'U') return true;
  // A picture the author resized. The width attribute is what holds that
  // decision (see the note on image sizing in RichEditor), and the `![](…)`
  // form has nowhere to put it.
  if (el.nodeName === 'IMG') return el.hasAttribute('width') || el.hasAttribute('height');
  return false;
}

/** The inline run of a block, as markdown. `skip` are children to leave out. */
function inlineToMarkdown(node: Node, skip: Set<Node> = new Set()): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (skip.has(child)) continue;
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeMarkdown(child.nodeValue ?? '');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const el = child as Element;
    if (needsRawHtml(el)) { out += el.outerHTML; continue; }

    const inner = () => inlineToMarkdown(el, skip);
    switch (el.nodeName) {
      case 'B': case 'STRONG': out += '**' + inner() + '**'; break;
      case 'I': case 'EM':     out += '*' + inner() + '*'; break;
      case 'S': case 'DEL': case 'STRIKE': out += '~~' + inner() + '~~'; break;
      case 'CODE':             out += '`' + (el.textContent ?? '') + '`'; break;
      // A break is a real line in the document, and markdown's own spelling for
      // one (two trailing spaces) does not survive the trip back: a paragraph
      // run joins its lines with a space.
      case 'BR':               out += '<br>'; break;
      case 'IMG':              out += '![' + (el.getAttribute('alt') ?? '') + '](' + (el.getAttribute('src') ?? '') + ')'; break;
      case 'A': {
        const href = el.getAttribute('href') ?? '';
        out += href ? '[' + inner() + '](' + href + ')' : inner();
        break;
      }
      default: out += inner();
    }
  }
  return out;
}

/** A list and everything nested in it, as markdown lines. */
function listToMarkdown(list: Element, depth: number, out: string[]): void {
  const ordered = list.nodeName === 'OL';
  let n = 1;
  for (const li of Array.from(list.children)) {
    if (li.nodeName !== 'LI') continue;
    const nested = Array.from(li.children).filter(c => c.nodeName === 'UL' || c.nodeName === 'OL');
    const text = inlineToMarkdown(li, new Set<Node>(nested));
    // Two spaces per level, which is what markdownToHtml reads back.
    const marker = ordered ? n++ + '.' : '-';
    out.push('  '.repeat(depth) + marker + ' ' + text);
    nested.forEach(sub => listToMarkdown(sub, depth + 1, out));
  }
}

function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return table.outerHTML;
  const cells = (tr: Element) => Array.from(tr.children)
    .map(c => inlineToMarkdown(c).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim());
  const head = cells(rows[0]);
  const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
  for (const tr of rows.slice(1)) lines.push('| ' + cells(tr).join(' | ') + ' |');
  return lines.join('\n');
}

/** One top-level block of the document, as markdown. */
function blockToMarkdown(el: Element): string {
  if (needsRawHtml(el)) return el.outerHTML;

  const heading = HEADING_LEVEL[el.nodeName];
  if (heading) return '#'.repeat(heading) + ' ' + inlineToMarkdown(el);

  switch (el.nodeName) {
    case 'P':
      // An empty paragraph is the blank line between two others, and the join
      // below already puts one there.
      return inlineToMarkdown(el).trim();
    case 'UL': case 'OL': {
      const lines: string[] = [];
      listToMarkdown(el, 0, lines);
      return lines.join('\n');
    }
    case 'BLOCKQUOTE':
      return '> ' + inlineToMarkdown(el).trim();
    case 'PRE': {
      const body = el.textContent ?? '';
      // A fence has to be longer than anything inside it, or the block ends in
      // the middle of the code it was holding.
      const fence = body.includes('```') ? '~~~' : '```';
      return fence + '\n' + body + '\n' + fence;
    }
    case 'HR':
      return '---';
    case 'TABLE':
      return tableToMarkdown(el);
    case 'DIV':
      if (el.classList.contains('note-todo')) {
        const done = el.getAttribute('data-checked') === 'true';
        const indent = '  '.repeat(Number(el.getAttribute('data-indent') ?? 0) || 0);
        return indent + '- [' + (done ? 'x' : ' ') + '] ' + inlineToMarkdown(el);
      }
      return inlineToMarkdown(el).trim();
    default:
      return el.outerHTML;
  }
}

/**
 * A post's HTML as markdown source, for the editor's source view.
 *
 * The inverse of markdownToHtml(src, { source: true }) — not exactly, and it
 * cannot be: markdown has more than one spelling for most things and this picks
 * one. What it does guarantee is that nothing is *lost*, which is the property
 * the round trip actually needs. Anything without a markdown form comes back as
 * itself.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks: string[] = [];
  for (const child of Array.from(doc.body.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.nodeValue ?? '').trim();
      if (text) blocks.push(escapeMarkdown(text));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const md = blockToMarkdown(child as Element);
    if (md.trim()) blocks.push(md);
  }
  // One blank line between blocks, which is the separator every construct in
  // markdownToHtml reads as "this block has ended".
  return blocks.join('\n\n') + '\n';
}
