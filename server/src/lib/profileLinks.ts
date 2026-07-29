// The links a profile shows out to the rest of the web - Bluesky, GitHub, a
// personal site. Pure, so it can be unit-tested directly the way blog.ts is.
//
// The server does not keep a list of platforms. Which services exist, what they
// are called and what a handle on each looks like are presentation concerns that
// change often; the client owns that table (utils/profileLinks.ts) and renders
// an unknown platform id with a generic favicon rather than breaking. What the
// server owns is the part a client must not be trusted with: that the stored
// value is a bounded list of ordinary, clickable http(s) URLs.

export const MAX_PROFILE_LINKS = 8;
export const MAX_LINK_URL = 300;
const MAX_PLATFORM_ID = 24;

// Lowercase slug, the shape every id in the client's table takes. Constrained
// because it is interpolated into markup as a CSS class and an icon key.
const PLATFORM_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface ProfileLink {
  platform: string;
  url: string;
}

// A URL safe to put behind an anchor on a page other people load. http(s) only:
// `javascript:` is script injection and `data:` is a same-origin document, and
// neither is what anyone means by "my Bluesky".
function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LINK_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // A hostname with no dot is a bare label like `localhost` or an intranet name -
  // not something to publish on a profile other people read.
  if (!parsed.hostname.includes('.')) return null;
  return parsed.toString();
}

// Validate a whole submitted list. All-or-nothing: a single bad entry rejects
// the request rather than being silently dropped, so the owner is told which
// link the server would not take instead of finding it missing later.
//
// Returns the array to store, or null when the input isn't acceptable.
export function normalizeProfileLinks(raw: unknown): ProfileLink[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_PROFILE_LINKS) return null;

  const out: ProfileLink[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { platform, url } = entry as Record<string, unknown>;
    if (typeof platform !== 'string' || platform.length > MAX_PLATFORM_ID) return null;
    const id = platform.toLowerCase();
    if (!PLATFORM_RE.test(id)) return null;
    const href = normalizeUrl(url);
    if (!href) return null;
    // The same URL twice is a mistake, not a preference - it would render as two
    // identical icons. Later duplicates are dropped rather than rejected.
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ platform: id, url: href });
  }
  return out;
}

// Reading back out of the Json column. Anything that fails to look like a link
// list - a legacy value, a hand-edited row - reads as no links at all, which is
// the one failure mode that can't break a profile page.
export function readProfileLinks(raw: unknown): ProfileLink[] {
  return normalizeProfileLinks(raw) ?? [];
}
