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

/**
 * Whether a bookmark's stored colour is still the one its domain derives.
 *
 * The edit dialog needs this to open in the right state: "auto", which follows
 * the domain, or a colour the owner picked. Getting it wrong is not cosmetic -
 * the dialog saves whatever it is showing, so an edit made to fix a typo in the
 * name used to write the derived colour back over a chosen one.
 *
 * A stored colour that happens to equal the derived one is auto. They are the
 * same colour today, and treating it as auto means it keeps following the
 * domain if the URL is retyped, which is the more useful of two identical
 * answers.
 */
export function isAutoColor(domain: string, color: string): boolean {
  if (!color) return true;
  const host = parseDomain(domain);
  return host !== null && deriveColor(host) === color;
}

// A host on its own is only a host if it looks like one, and what makes it look
// like one depends on whether a scheme was typed.
//
// Without a scheme the dot is the whole test: "figma.com" is an address and
// "figma" is a word, and there is nothing else to go on. Typing http:// or
// https:// settles it - that is a person saying "this is an address", so a
// single-label host is taken at its word. That is the LAN case: `http://nas`,
// `http://truenas:9000`, a machine on your own network with a name and no
// domain. Requiring a dot rejected those outright: the dialog's Add button
// simply stayed dead, with nothing said about why.
function looksLikeHost(host: string, explicitScheme: boolean): boolean {
  if (host.length < 3) return false;
  // A port is not part of the name being judged - `nas:9000` is one label.
  const name = host.replace(/:\d+$/, '');
  if (!name || /[^a-z0-9.:_-]/i.test(name)) return false;
  return explicitScheme ? !name.startsWith('.') && !name.endsWith('.') : name.includes('.');
}

// Host only - strips protocol, www, and any path/query. Used for favicons,
// colour derivation, and anywhere we want to display just the site.
export function parseDomain(input: string): string | null {
  const trimmed = input.trim();
  const explicit = /^https?:\/\//i.test(trimmed);
  let s = trimmed.toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split(/[/?#]/)[0];
  return looksLikeHost(s, explicit) ? s : null;
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
  const explicit = /^https?:\/\//i.test(trimmed);
  const insecure = /^http:\/\//i.test(trimmed);
  const stripped = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const cut = stripped.search(/[/?#]/);
  const host = (cut === -1 ? stripped : stripped.slice(0, cut)).toLowerCase();
  if (!looksLikeHost(host, explicit)) return null;
  const rest = (cut === -1 ? '' : stripped.slice(cut)).replace(/\/+$/, '');
  // https:// is dropped only when what's left still reads as an address on its
  // own, since that is the whole reason for dropping it - not printing
  // "https://" in front of every tile. A single-label host has nothing but the
  // scheme to say it is a host, so `https://nas:9000` keeps it; stripping it
  // stored a value this function would refuse to read back, which is what an
  // edit dialog opens with.
  const scheme = insecure ? 'http://' : looksLikeHost(host, false) ? '' : 'https://';
  return scheme + host + rest;
}

export function deriveName(domain: string): string {
  // An address has no first label worth naming a tile after - a LAN bookmark
  // for 192.168.1.15 was arriving called "192". The address itself is the only
  // honest default; the user can rename it.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(domain)) return domain;
  // The port goes with the address, not with the name: a machine called `nas`
  // reachable on 9000 is still called Nas.
  const label = domain.replace(/:\d+$/, '').split('.')[0];
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
