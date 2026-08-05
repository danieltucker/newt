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
export function inlineMarkdown(src: string): string {
  const code: string[] = [];
  // Pulled out and replaced by a placeholder built from a private-use
  // codepoint, which escapeHtml can never produce, so the emphasis and link
  // passes below cannot reach inside a span of code and rewrite it.
  let s = escapeHtml(src).replace(/`([^`]+)`/g, (_, body) => {
    code.push(body);
    return `\uE000C${code.length - 1}\uE000`;
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

  return s.replace(/\uE000C(\d+)\uE000/g, (_, i) => `<code>${code[Number(i)]}</code>`);
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

function renderTable(rows: string[][]): string {
  const [head, ...body] = rows;
  const cells = (r: string[], tag: 'th' | 'td') =>
    r.map(c => `<${tag}>${inlineMarkdown(c)}</${tag}>`).join('');
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
export function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (!line.trim()) { i++; continue; }

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
      out.push(`<h${level}>${inlineMarkdown(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Setext heading: a line underlined with === or ---. The --- case is only
    // a heading if there is text above it, otherwise the rule above claimed it.
    if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && line.trim()) {
      const level = lines[i + 1].trim().startsWith('=') ? 1 : 2;
      out.push(`<h${level}>${inlineMarkdown(line.trim())}</h${level}>`);
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
      out.push(renderTable(rows));
      continue;
    }

    // Quote. Consecutive > lines join into one block, and the markers are
    // stripped before the contents are run through the inline pass.
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      out.push(`<blockquote>${inlineMarkdown(body.join(' '))}</blockquote>`);
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
            items[items.length - 1].html += ` ${inlineMarkdown(lines[i].trim())}`;
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
          html: inlineMarkdown(todo ? todo[2] : m[3]),
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
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) para.push(lines[i++].trim());   // never loop forever
    out.push(`<p>${inlineMarkdown(para.join(' '))}</p>`);
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
