// Sites whose feed can't be found by asking the page for it.
//
// Generic discovery (feedDiscovery.ts) is the right default and covers most of
// the web: fetch the address, read its <link rel="alternate">, fall back to the
// usual paths. These are the places that defeat it, each for its own reason —
// and each of them is somewhere people actually want to follow, so "no feed
// found at youtube.com" is a wrong answer rather than a limitation.
//
// Verified against the live sites 2026-08-07; the notes on each say what was
// observed, because the reason a rule exists is the thing that stops it being
// "simplified" back into a bug.

/** Feed addresses to try for one source, in order. First non-empty one wins. */
export interface PlatformFeed {
  candidates: string[];
  /** Named in the failure message when none of them resolve. */
  source: string;
}

/** Reads at most `maxBytes` of a URL. Injected so this module fetches nothing
 *  itself — it keeps the SSRF gate and the byte ceiling in one place, and makes
 *  the mapping testable without a network. */
export type FetchText = (url: string, maxBytes?: number) => Promise<string | null>;

// A YouTube channel page is 1–3 MB of inlined JSON and the canonical <link> sits
// around 730 KB into it, well past the 500 KB generic discovery reads. That is
// the entire reason YouTube needs a rule here.
const YT_PAGE_BYTES = 1_000_000;

const YT_CHANNEL_ID = /^UC[\w-]{22}$/;

function host(target: URL): string {
  return target.hostname.replace(/^www\./, '').toLowerCase();
}

function isHost(target: URL, domain: string): boolean {
  const h = host(target);
  return h === domain || h.endsWith(`.${domain}`);
}

/** Path segments with the empty ones dropped, so a trailing slash changes nothing. */
function segments(target: URL): string[] {
  return target.pathname.split('/').filter(Boolean);
}

export function youtubeFeedFor(kind: 'channel_id' | 'user' | 'playlist_id', value: string): string {
  return `https://www.youtube.com/feeds/videos.xml?${kind}=${encodeURIComponent(value)}`;
}

/**
 * The mapping that needs no network: everything derivable from the address.
 *
 * Split from the async resolver below so it can be tested as what it is — a
 * pure function from one URL to another.
 */
export function staticPlatformFeed(target: URL): PlatformFeed | null {
  const segs = segments(target);

  // ── YouTube ──
  if (isHost(target, 'youtube.com')) {
    // Already the feed. Recognised so re-adding one, or pasting one from
    // somewhere else, doesn't take the slow path through a channel page.
    if (target.pathname === '/feeds/videos.xml') {
      return { candidates: [target.toString()], source: 'YouTube' };
    }
    const list = target.searchParams.get('list');
    if (list) return { candidates: [youtubeFeedFor('playlist_id', list)], source: 'YouTube playlist' };
    // /channel/UC… is the canonical form and needs nothing looked up.
    if (segs[0] === 'channel' && segs[1] && YT_CHANNEL_ID.test(segs[1])) {
      return { candidates: [youtubeFeedFor('channel_id', segs[1])], source: 'YouTube' };
    }
    // /user/<name> is the pre-2017 form. Still served, and the feed endpoint
    // still accepts ?user=, so it costs no lookup either.
    if (segs[0] === 'user' && segs[1]) {
      return { candidates: [youtubeFeedFor('user', segs[1])], source: 'YouTube' };
    }
    // /@handle needs the channel id, which only the page knows — see
    // resolveYouTubeHandle. (/c/<name> is gone: youtube.com/c/Computerphile
    // answers 404 now, so it is deliberately not handled.)
    return null;
  }

  // ── Bluesky ──
  // bsky.app does advertise its RSS in the page head, so generic discovery
  // already finds it. This is here to go straight there instead: one request
  // rather than two, and it doesn't depend on their single-page app continuing
  // to render that tag server-side.
  if (isHost(target, 'bsky.app') && segs[0] === 'profile' && segs[1]) {
    return { candidates: [`https://bsky.app/profile/${segs[1]}/rss`], source: 'Bluesky' };
  }

  // ── Reddit ──
  // Reddit advertises no feed link at all and its feeds hang off a path suffix
  // (/.rss) rather than a well-known path, so both halves of generic discovery
  // miss. Note Reddit rate-limits hard — a 429 on a burst was easy to reproduce
  // — but a feed polled once every 30 minutes sits well inside that.
  if (isHost(target, 'reddit.com')) {
    if (segs[0] === 'r' && segs[1]) {
      return { candidates: [`https://www.reddit.com/r/${segs[1]}/.rss`], source: 'Reddit' };
    }
    if ((segs[0] === 'user' || segs[0] === 'u') && segs[1]) {
      return { candidates: [`https://www.reddit.com/user/${segs[1]}/.rss`], source: 'Reddit' };
    }
    return null;
  }

  // ── GitHub ──
  // A repo's releases are what people mean by "follow this project"; its commits
  // are the answer for one that doesn't cut releases. Both are tried because a
  // young repo with no releases yet would otherwise resolve to an empty feed and
  // be rejected as broken.
  if (isHost(target, 'github.com') && segs.length >= 2 && !GITHUB_RESERVED.has(segs[0])) {
    const [owner, repo] = segs;
    return {
      candidates: [
        `https://github.com/${owner}/${repo}/releases.atom`,
        `https://github.com/${owner}/${repo}/commits.atom`,
      ],
      source: 'GitHub',
    };
  }

  return null;
}

// Paths under github.com that aren't <owner>/<repo>. Not exhaustive — a wrong
// guess here costs one 404 and a fall through to generic discovery, so this only
// needs to catch the ones somebody might realistically paste.
const GITHUB_RESERVED = new Set([
  'orgs', 'settings', 'notifications', 'explore', 'topics', 'trending',
  'marketplace', 'sponsors', 'features', 'pricing', 'about', 'login', 'search',
]);

/**
 * A YouTube @handle's channel id, read off its page.
 *
 * Only `<link rel="canonical">` and `<meta itemprop="identifier">` are trusted.
 * The obvious-looking `"channelId":"UC…"` in the inlined JSON is **not** the
 * channel you asked for — on youtube.com/@mkbhd the first such match belongs to
 * a recommended channel in the sidebar, so scraping it subscribes you to
 * somebody else. Verified 2026-08-07.
 */
export async function resolveYouTubeHandle(target: URL, fetchText: FetchText): Promise<string | null> {
  const html = await fetchText(target.toString(), YT_PAGE_BYTES);
  if (!html) return null;
  const canonical = html.match(/<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/i);
  if (canonical) return canonical[1];
  const identifier = html.match(/<meta\s+itemprop="identifier"\s+content="(UC[\w-]{22})"/i);
  return identifier ? identifier[1] : null;
}

/**
 * The feed for a known platform address, or null to let generic discovery try.
 *
 * Returning null rather than an error is the contract that matters: this is an
 * optimisation and a set of special cases, never a gate. An unrecognised
 * youtube.com URL still gets the ordinary treatment.
 */
export async function platformFeed(target: URL, fetchText: FetchText): Promise<PlatformFeed | null> {
  const direct = staticPlatformFeed(target);
  if (direct) return direct;

  if (isHost(target, 'youtube.com')) {
    const segs = segments(target);
    const handle = segs.find(s => s.startsWith('@'));
    if (handle) {
      const channelId = await resolveYouTubeHandle(target, fetchText);
      if (channelId) {
        return { candidates: [youtubeFeedFor('channel_id', channelId)], source: 'YouTube' };
      }
    }
  }

  return null;
}
