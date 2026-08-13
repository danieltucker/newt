// Also the swatches offered when naming a folder, so a folder picked by hand
// and a tile coloured from its domain come out of the same set.
export const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

export function deriveColor(domain: string): string {
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Host only - strips protocol, www, and any path/query. Used for favicons,
// colour derivation, and anywhere we want to display just the site.
export function parseDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0];
  if (!s.includes('.') || s.length < 3) return null;
  return s;
}

// Full link target - host plus any path/query, so a bookmark can point at
// github.com/danieltucker, not only github.com. The host is lowercased (hosts
// are case-insensitive) but the path is kept exactly as typed. Returns null when
// there's no valid host.
//
// A typed `http://` survives; `https://` does not. Scheme-less is the normal
// stored form and bookmarkHref reads it as https, so keeping the default would
// only put "https://" in front of every tile's subtitle. But http is not the
// default and cannot be inferred: a router or a NAS at 192.168.1.15 serves plain
// http, and stripping the scheme the user typed sent them to an https port that
// isn't listening - with no way to say otherwise.
export function parseLink(input: string): string | null {
  const trimmed = input.trim();
  const insecure = /^http:\/\//i.test(trimmed);
  const stripped = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const cut = stripped.search(/[/?#]/);
  const host = (cut === -1 ? stripped : stripped.slice(0, cut)).toLowerCase();
  if (!host.includes('.') || host.length < 3) return null;
  const rest = (cut === -1 ? '' : stripped.slice(cut)).replace(/\/+$/, '');
  return (insecure ? 'http://' : '') + host + rest;
}

export function deriveName(domain: string): string {
  // An address has no first label worth naming a tile after - a LAN bookmark
  // for 192.168.1.15 was arriving called "192". The address itself is the only
  // honest default; the user can rename it.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(domain)) return domain;
  const label = domain.split('.')[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Where a bookmark tile navigates. `domain` is normally scheme-less (parseLink
// strips it), so https:// is prepended - but a few bookmarks are created by the
// server rather than typed in, and those carry a full URL. Prefixing one of
// those gave links like https://http//host/u/name, so pass an absolute URL
// through untouched.
export function bookmarkHref(domain: string): string {
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

export function faviconUrl(domain: string): string {
  // Callers may pass a full link (host + path); the favicon service only wants
  // the host, so strip anything after it.
  const host = domain.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  return `/api/v1/util/favicon?domain=${encodeURIComponent(host)}`;
}
