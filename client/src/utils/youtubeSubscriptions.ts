// Reading a YouTube subscription list out of a Google Takeout export.
//
// ── Why a file and not a "Connect YouTube" button ──
// YouTube will not tell anyone who you subscribe to without an OAuth grant
// through the YouTube Data API, which means a Google Cloud project, a client
// secret in the deployment, a consent screen in review, and a token to keep.
// That is a lot of machinery — and a standing read-scope on somebody's Google
// account — to fetch a list that changes a few times a year and that Takeout
// hands over as a 2 KB CSV. So: export it once, drop the file in, and the app
// never touches your Google account at all.
//
// Get the file from takeout.google.com → deselect all → YouTube and YouTube
// Music → "subscriptions" only. The CSV lands at
// YouTube and YouTube Music/subscriptions/subscriptions.csv.
//
// The file's own columns are `Channel ID, Channel URL, Channel title`. Parsed
// by header name rather than by position, because that order is Google's to
// change and the ids are recognisable enough to find without it.

export interface YouTubeChannel {
  channelId: string;
  title: string;
  /** The channel's video feed — the address actually subscribed to. */
  feedUrl: string;
}

const CHANNEL_ID = /^UC[\w-]{22}$/;

export function youtubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

/**
 * Whether what someone is typing into the add-feed box is a YouTube address.
 *
 * Only used to decide whether to *offer* the subscriptions import, so it errs
 * towards not interrupting: the cost of a miss is a hint that doesn't appear,
 * and the cost of a false positive is an unrelated panel opening up while
 * somebody is typing. Bare hostnames count, since the add box accepts those.
 */
export function isYouTubeAddress(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
}

/**
 * One CSV line into fields, honouring quotes.
 *
 * Channel titles are arbitrary text that people choose, so commas and quotes in
 * them are ordinary rather than exotic — splitting on ',' would cut a band
 * called "Earth, Wind & Fire" into two useless halves.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      // "" inside a quoted field is one literal quote, not the end of it.
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { quoted = false; continue; }
      field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { out.push(field); field = ''; continue; }
    field += c;
  }
  out.push(field);
  return out.map(f => f.trim());
}

/**
 * The channels in a Takeout subscriptions CSV.
 *
 * Anything unrecognisable is skipped rather than thrown over: this is a file a
 * person picked off their disk, and one malformed row out of two hundred should
 * cost that row, not the import. A file that yields nothing is how the caller
 * learns it was the wrong file.
 */
export function parseYouTubeSubscriptions(csv: string): YouTubeChannel[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  let idAt = header.findIndex(h => h === 'channel id');
  let titleAt = header.findIndex(h => h === 'channel title');

  // No recognisable header: either Google renamed the columns or this is a file
  // with no header at all. Fall back to finding the id column by what an id
  // looks like, which is the part that has to be right.
  const headerless = idAt === -1;
  if (headerless) {
    const first = splitCsvLine(lines[0]);
    idAt = first.findIndex(f => CHANNEL_ID.test(f));
    if (idAt === -1) return [];
    if (titleAt === -1) titleAt = first.length - 1;
  }

  const rows = headerless ? lines : lines.slice(1);
  const seen = new Set<string>();
  const channels: YouTubeChannel[] = [];
  for (const line of rows) {
    const fields = splitCsvLine(line);
    const channelId = fields[idAt] ?? '';
    if (!CHANNEL_ID.test(channelId) || seen.has(channelId)) continue;
    seen.add(channelId);
    channels.push({
      channelId,
      // A channel with no title still subscribes fine — the feed carries its own,
      // and the server falls back to it when the subscription's name is blank.
      title: (fields[titleAt] ?? '').slice(0, 100),
      feedUrl: youtubeFeedUrl(channelId),
    });
  }
  return channels;
}
