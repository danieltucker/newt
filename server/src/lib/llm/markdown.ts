/**
 * Markdown to the HTML the rich editor speaks.
 *
 * Written here rather than pulled in as a dependency, and that is a deliberate
 * trade worth stating. The input is not arbitrary markdown from the internet:
 * it is one model's answer to "reply with a post body", produced under a prompt
 * that asks for headings, paragraphs and lists. The subset below covers what
 * that actually produces. A full CommonMark implementation would handle setext
 * headings, reference links, nested block quotes and HTML passthrough — none of
 * which appear here, all of which would be code to carry.
 *
 * Two things make the narrow subset safe rather than merely small:
 *
 *  · Everything is escaped first, so any HTML in the source is text by the time
 *    the block rules run. There is no passthrough path.
 *  · The result still goes through sanitizeBlogHtml at the call site, which is
 *    the same allowlist every human-authored post is held to.
 *
 * Anything this doesn't recognise degrades to a paragraph of its own literal
 * text, which is legible and editable — the failure mode is a stray asterisk in
 * the composer, not a broken post.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Emphasis, links and the rest — applied to already-escaped text. */
function spans(escaped: string): string {
  return escaped
    // Links. The URL is re-checked here even though sanitize-html will check it
    // again: keeping a javascript: URL out of the string entirely is cheaper to
    // reason about than relying on a later pass to strip it.
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
      /^https?:\/\//i.test(href) ? `<a href="${href}">${label}</a>` : label)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    // Single-character emphasis last, and only when the delimiters hug a
    // non-space — otherwise a * used as a bullet or a stray _ in a file name
    // swallows half a paragraph.
    .replace(/(^|[\s(])\*(\S[^*\n]*\S|\S)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_(\S[^_\n]*\S|\S)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
}

/**
 * Inline formatting for one line.
 *
 * Code spans are handled by splitting on backticks rather than by substituting
 * placeholders and putting them back: the odd-numbered segments of that split
 * *are* the code spans, so they can be escaped and wrapped directly while the
 * even ones get the emphasis rules. No sentinel means no way for a sentinel to
 * collide with the text it was hiding in.
 *
 * An odd-indexed segment is only code if something follows it — that is what
 * says its opening backtick was closed. A trailing unpaired backtick therefore
 * lands on an odd segment with nothing after it, which is rendered as prose
 * with the backtick put back by hand: `split` consumed it, and losing a
 * character the author typed is worse than not formatting it.
 */
function inline(raw: string): string {
  const parts = raw.split('`');
  return parts
    .map((part, i) => {
      const isDelimited = i % 2 === 1;
      const isClosed = i < parts.length - 1;
      if (isDelimited && isClosed) return `<code>${escapeHtml(part)}</code>`;
      return `${isDelimited ? '`' : ''}${spans(escapeHtml(part))}`;
    })
    .join('');
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  const ordered = /^\s*\d+[.)]\s+/;
  const unordered = /^\s*[-*+]\s+/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (!line.trim()) { i++; continue; }

    // Fenced code. Everything to the closing fence is literal, including lines
    // that would otherwise look like headings or list items.
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // past the closing fence, or past the end if it never came
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading. H1 is demoted to H2: the post's title is its own field and is
    // rendered as the page heading, so an H1 in the body would be a second one.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.max(2, heading[1].length);
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule. Tested before lists, since "- - -" also matches a bullet.
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { out.push('<hr>'); i++; continue; }

    // Block quote — consecutive `>` lines join into one quote.
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${inline(body.join(' ').trim())}</p></blockquote>`);
      continue;
    }

    // Lists. Ordered and unordered are the same loop with a different test and
    // wrapper; nesting is deliberately not supported — see the header.
    const isOrdered = ordered.test(line);
    if (isOrdered || unordered.test(line)) {
      const test = isOrdered ? ordered : unordered;
      const tag = isOrdered ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < lines.length && test.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(test, '').trim())}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // Paragraph: everything up to the next blank line or block-level opener.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !ordered.test(lines[i]) &&
      !unordered.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}
