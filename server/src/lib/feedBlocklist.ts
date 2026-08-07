import prisma from './prisma';
import logger from './logger';

// Domain blocking for feeds: which hosts this instance refuses to poll.
//
// Two rule shapes, matching the two questions actually asked (see BlockedDomain
// in schema.prisma):
//
//   'domain' — example.com blocks example.com and *.example.com
//   'suffix' — .xyz blocks every host ending at that label boundary
//
// The label-boundary part is the whole subtlety here. Naïve `host.endsWith(rule)`
// makes a rule for "example.com" block "notexample.com", and a rule for ".ru"
// block "example.peru"-style hosts wherever the string happens to line up. Both
// are silent over-blocks: nobody reports a feed they were never allowed to add.
// So matching is always done on whole labels, never on raw substrings.

export type BlockKind = 'domain' | 'suffix';

export interface BlockPattern {
  kind: BlockKind;
  pattern: string;
}

export interface BlockRule extends BlockPattern {
  id: string;
  note: string;
}

// A hostname is at most 253 characters; anything longer is not a rule anyone
// meant to write, and the column should not be a place to park a paragraph.
export const MAX_BLOCK_PATTERN = 253;
export const MAX_BLOCK_NOTE = 200;

/**
 * Turn whatever an admin typed into a stored rule, or null if it isn't one.
 *
 * Accepts a bare host, a full URL, or a host with a leading dot, because all
 * three are things people paste. A leading dot is the marker that distinguishes
 * the two kinds — `.xyz` is "the whole extension", `xyz` on its own would be a
 * single-label host, which is never a real feed origin and is far more likely to
 * be someone meaning the TLD. So a single label is read as a suffix either way,
 * and anything with a dot inside it is a domain unless explicitly prefixed.
 */
export function normalizeBlockPattern(raw: string): BlockPattern | null {
  let s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;

  // Paste tolerance: a URL, or a host with a path or credentials stuck to it.
  // Parsing rather than string-slicing so "https://user:pw@example.com:8443/rss"
  // reduces to the host and nothing else.
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    // No scheme, so URL() can't help. Strip the parts that would otherwise end
    // up inside the pattern: userinfo, port, path, query, fragment.
    s = s.split(/[/?#]/, 1)[0];
    const at = s.lastIndexOf('@');
    if (at !== -1) s = s.slice(at + 1);
    // A port, but not an IPv6 literal's colons — those are not blockable hosts
    // anyway (see the reject below), so a single trailing :digits is enough.
    s = s.replace(/:\d+$/, '');
  }

  const explicitSuffix = s.startsWith('.');
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s) return null;
  if (s.length > MAX_BLOCK_PATTERN) return null;

  // Collapse "www." the way canonicalFeedKey does, so a rule for www.example.com
  // and one for example.com aren't two rules that behave identically — with the
  // subdomain match, the shorter one already covers the longer.
  if (!explicitSuffix) s = s.replace(/^www\./, '');
  if (!s) return null;

  // Whole labels only: letters, digits, hyphens, separated by single dots. This
  // is also what keeps a pattern from being a regex, a wildcard, or a CIDR range
  // — none of which this matcher implements, and all of which would otherwise be
  // stored silently and then never match anything.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s)) return null;
  if (s.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) return null;

  // An IPv4 literal is not a domain rule and would behave surprisingly under the
  // subdomain match. Feeds on bare IPs are already refused by the SSRF guard for
  // private space, and a public one should be blocked by its hostname.
  if (/^\d+(\.\d+)*$/.test(s)) return null;

  const kind: BlockKind = explicitSuffix || !s.includes('.') ? 'suffix' : 'domain';
  return { kind, pattern: kind === 'suffix' ? `.${s}` : s };
}

/** Lowercased hostname of a URL, or null if it isn't a parseable http(s) one. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

/**
 * Does one rule cover this host?
 *
 * Both kinds compare whole labels. For 'domain' that means an exact host match
 * or a match after a dot; for 'suffix' the stored pattern already carries the
 * leading dot, so `endsWith` is a label-boundary test by construction.
 *
 * The kinds differ on the bare host deliberately, and it is the one thing to
 * know when writing a rule: `example.com` blocks example.com *and* its
 * subdomains, while `.example.com` blocks only what is under it. The suffix kind
 * does not special-case a dotless host (`.xyz` vs `xyz`) — ICANN prohibits
 * dotless domains, so no feed is served from one, and adding the case is what
 * made `.example.com` block its own parent.
 */
export function ruleMatchesHost(rule: BlockPattern, host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  if (rule.kind === 'suffix') return h.endsWith(rule.pattern);
  return h === rule.pattern || h.endsWith(`.${rule.pattern}`);
}

/** The first rule that covers `host`, or null. */
export function matchRule<T extends BlockPattern>(rules: T[], host: string): T | null {
  for (const rule of rules) {
    if (ruleMatchesHost(rule, host)) return rule;
  }
  return null;
}

// ── Rule cache ──────────────────────────────────────────────────────────────
// Every feed added and every feed refreshed asks this question, so the rule set
// is held in process rather than queried each time. It is small (tens of rows)
// and changes only when an admin edits it, which is also the only thing that has
// to invalidate it — see invalidateBlockCache, called from the admin routes.
//
// The TTL is the backstop for the multi-process case: another instance's write
// is not visible to this one's cache, so a rule added on one takes at most this
// long to bite on the others. A minute is well inside "an admin adds a rule and
// checks it worked".
const CACHE_TTL_MS = 60 * 1000;
let cached: BlockRule[] | null = null;
let cachedAt = 0;

export function invalidateBlockCache(): void {
  cached = null;
  cachedAt = 0;
}

export async function loadBlockRules(): Promise<BlockRule[]> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
  try {
    const rows = await prisma.blockedDomain.findMany({
      select: { id: true, pattern: true, kind: true, note: true },
      orderBy: { pattern: 'asc' },
    });
    cached = rows.map(r => ({
      id: r.id,
      pattern: r.pattern,
      kind: r.kind === 'suffix' ? 'suffix' : 'domain',
      note: r.note,
    }));
    cachedAt = now;
    return cached;
  } catch (err) {
    // A failed read must not become an open gate *or* a closed one. Returning the
    // last known rules (or nothing on a cold cache) keeps feeds working through a
    // database blip, which is the same posture every other feed path takes.
    logger.warn({ err }, 'Could not load blocked domains');
    return cached ?? [];
  }
}

/**
 * The rule blocking this URL, or null if nothing does.
 *
 * Callers gate on the *resolved* feed URL, not the one that was typed — a link
 * shortener or a redirect through a clean host would otherwise walk straight
 * past the rule.
 */
export async function blockedRuleFor(url: string): Promise<BlockRule | null> {
  const host = hostOf(url);
  if (!host) return null;
  return matchRule(await loadBlockRules(), host);
}

/**
 * Switch off every stored feed a newly-added rule covers.
 *
 * Blocking a domain has to mean something for the feeds already subscribed to
 * it, or the rule is only ever a gate on new additions and the server keeps
 * fetching the host it was just told not to. Existing subscriptions are left
 * alone: the feed simply stops producing, and the row is there to explain why.
 *
 * Matching happens here rather than in SQL because label-boundary matching isn't
 * expressible as a LIKE — and `LIKE '%example.com'` is precisely the over-broad
 * comparison ruleMatchesHost exists to avoid. The scan is bounded by the feed
 * count (hundreds), and this runs only when an admin edits the rules.
 *
 * Returns the number of feeds disabled.
 */
export async function applyBlockRule(rule: BlockPattern): Promise<number> {
  const feeds = await prisma.feed.findMany({
    where: { disabledAt: null },
    select: { id: true, fetchUrl: true },
  });

  const hits = feeds
    .filter(f => {
      const host = hostOf(f.fetchUrl);
      return host !== null && ruleMatchesHost(rule, host);
    })
    .map(f => f.id);

  if (hits.length === 0) return 0;

  await prisma.feed.updateMany({
    where: { id: { in: hits } },
    data: { disabledAt: new Date(), disabledReason: 'blocked' },
  });
  return hits.length;
}

/**
 * Feeds disabled by a rule that no longer exists.
 *
 * Removing a rule does not revive them automatically — the block may have been
 * added for a reason that outlived the rule, and quietly restarting fetches to a
 * host an admin once objected to is not a decision this should make on its own.
 * The admin panel uses this to offer the choice, which is why it reports the
 * feeds rather than acting on them.
 */
export async function feedsBlockedByNoRule(): Promise<{ id: string; fetchUrl: string }[]> {
  const [blocked, rules] = await Promise.all([
    prisma.feed.findMany({
      where: { disabledReason: 'blocked' },
      select: { id: true, fetchUrl: true },
    }),
    loadBlockRules(),
  ]);
  return blocked.filter(f => {
    const host = hostOf(f.fetchUrl);
    return host === null || !matchRule(rules, host);
  });
}

/** The message a user sees when their feed is refused. */
export function blockedMessage(rule: BlockPattern): string {
  return rule.kind === 'suffix'
    ? `Feeds from ${rule.pattern} addresses aren't allowed on this server`
    : `Feeds from ${rule.pattern} aren't allowed on this server`;
}
