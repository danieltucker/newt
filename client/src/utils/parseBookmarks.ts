export interface ParsedBookmark {
  name: string;
  domain: string;
  color: string;
}

const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

function deriveColor(domain: string): string {
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function parseBookmarkHTML(html: string): ParsedBookmark[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set<string>();
  const results: ParsedBookmark[] = [];

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('http://') && !href.startsWith('https://')) continue;

    let domain: string;
    try {
      const u = new URL(href);
      // Host, not hostname: a port is part of the address for anything not on
      // 80/443, which on an exported bookmarks file means the things on your own
      // network. And an http:// address keeps its scheme for the same reason the
      // add-link dialog keeps it - scheme-less is read back as https, so
      // dropping it imported a tile that pointed at a port nothing answers on.
      domain = u.host.replace(/^www\./, '');
      if (u.protocol === 'http:') domain = `http://${domain}`;
    } catch {
      continue;
    }
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);

    // The scheme is plumbing, not a name - a tile called "http://nas" would be
    // the only one in the grid shouting its protocol.
    const label = domain.replace(/^http:\/\//, '');
    const name = a.textContent?.trim() || label;
    results.push({ name, domain, color: deriveColor(domain) });
  }

  return results;
}
