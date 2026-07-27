// One-time migration of the old single markdown note (settings.notes) into the
// rich editor's HTML. Covers the block types the old slash menu produced;
// inline markdown is left as literal text. Runs once, on first open of a console
// that still has legacy content, so correctness here matters - a bug rewrites
// real note content with no undo.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let listBuf: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;

  const flushList = () => {
    if (listTag) { out.push(`<${listTag}>${listBuf.join('')}</${listTag}>`); listBuf = []; listTag = null; }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```/);
    if (fence) {
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(esc(lines[i])); i++; }
      i++; // closing fence
      out.push(`<pre>${code.join('\n') || '<br>'}</pre>`);
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushList();
      out.push(`<h${m[1].length}>${esc(m[2])}</h${m[1].length}>`);
    } else if ((m = line.match(/^\s*- \[( |x)\]\s+(.*)$/i))) {
      flushList();
      const checked = m[1].toLowerCase() === 'x';
      out.push(`<div class="note-todo" data-checked="${checked}">${esc(m[2]) || '<br>'}</div>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (listTag && listTag !== 'ul') flushList();
      listTag = 'ul';
      listBuf.push(`<li>${esc(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (listTag && listTag !== 'ol') flushList();
      listTag = 'ol';
      listBuf.push(`<li>${esc(m[1])}</li>`);
    } else if ((m = line.match(/^>\s+(.*)$/))) {
      flushList();
      out.push(`<blockquote>${esc(m[1])}</blockquote>`);
    } else if (/^\s*---\s*$/.test(line)) {
      flushList();
      out.push('<hr>');
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      out.push(`<p>${esc(line)}</p>`);
    }
    i++;
  }
  flushList();
  return out.join('') || '<p><br></p>';
}
