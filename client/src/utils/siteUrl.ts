// Routing helpers for site pages: /s/<domain>.
//
// The domain is the path, unencoded, because a hostname is already URL-safe and
// a readable /s/arstechnica.com is half the point - it is a link you can guess,
// paste and recognise. Mirrors server/src/routes/sites.ts normalizeDomain; the
// two must agree, or a link built here 400s there.

const PREFIX = '/s/';

// Lowercase, no scheme, no `www.`, no path. Accepts either a bare hostname or a
// whole URL, since callers have one or the other depending on which card the
// click came from.
export function siteDomainOf(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

export function sitePathFor(domainOrUrl: string): string {
  return PREFIX + siteDomainOf(domainOrUrl);
}

// The domain a /s/<domain> path names, or null if the path isn't one. A
// malformed host is rejected here rather than routed and left to fail on the
// server: the page has nothing to render without a domain.
export function parseSitePath(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const raw = pathname.slice(PREFIX.length).replace(/\/+$/, '');
  if (!raw || raw.includes('/')) return null;
  const domain = siteDomainOf(decodeURIComponent(raw));
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) ? domain : null;
}
