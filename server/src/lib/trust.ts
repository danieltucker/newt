import prisma from './prisma';

// Trust levels: how much *reach* an account has, not what it is allowed to do.
//
// The distinction is the whole design. A hard age gate ("no commenting for 3
// days") taxes the one honest new user far more than the spammer, who simply
// registers a batch of accounts today and uses them next week. So nothing here
// forbids an action. A day-old account can comment, post and send friend
// requests from its first minute — it just cannot do any of them *fast*. What
// grows with trust is throughput, which is the only thing an abuser actually
// needs and the thing a real person barely notices.
//
// The other half of the problem is that an account currently costs nothing:
// registration is open and `email` is nullable and unverified, so age alone
// gates nothing — you can mint a hundred accounts now and wait. Until there is a
// mail transport to verify addresses with, TOTP enrolment is the stand-in cost:
// it is per-account manual work with an authenticator app, which is exactly the
// step nobody automates for a spam farm. Turning on 2FA therefore promotes an
// account immediately, regardless of age.

export type TrustLevel = 'new' | 'established' | 'trusted';

// How long an account stays 'new'. Deliberately short: this is a burst damper on
// the first session, not a probation period.
export const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;

export interface TrustInput {
  createdAt: Date;
  totpEnabled: boolean;
}

export function trustLevelOf(user: TrustInput, now: Date = new Date()): TrustLevel {
  // 2FA is the cost signal that a verified email would otherwise provide, so it
  // promotes straight past the age check rather than stacking with it.
  if (user.totpEnabled) return 'trusted';
  return now.getTime() - user.createdAt.getTime() >= NEW_ACCOUNT_MS ? 'established' : 'new';
}

export interface ReachLimits {
  friendRequestsPerHour: number;
  commentsPerMinute: number;
  commentsPerHour: number;
}

// 'established' intentionally equals the limits that applied to everyone before
// this existed — so the ladder is not a tightening for ordinary users, only a
// damper on hour-old accounts and a reward for enrolling in 2FA.
const LIMITS: Record<TrustLevel, ReachLimits> = {
  new:         { friendRequestsPerHour: 5,  commentsPerMinute: 3,  commentsPerHour: 15 },
  established: { friendRequestsPerHour: 30, commentsPerMinute: 8,  commentsPerHour: 60 },
  trusted:     { friendRequestsPerHour: 60, commentsPerMinute: 12, commentsPerHour: 120 },
};

export function reachLimitsFor(level: TrustLevel): ReachLimits {
  return LIMITS[level];
}

// ── Lookup ──────────────────────────────────────────────────────────────────
// Everything above is pure and unit-tested. Only this part touches the database.

// Trust is read on every rate-limited write, so it is cached rather than queried
// each time. The TTL is short because the only transition that matters in a hurry
// is 'new' -> 'established', and being an hour late to widen someone's limits is
// harmless. Enabling 2FA is the impatient case, so that path clears the entry
// explicitly instead of waiting this out.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { level: TrustLevel; at: number }>();

export function clearTrustCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export async function trustLevelFor(userId: string | undefined): Promise<TrustLevel> {
  // No identified user means no earned reach — fail to the tightest bucket.
  if (!userId) return 'new';

  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.level;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, totpEnabled: true },
  });
  // A missing user is not a reason to hand out full throughput.
  const level = user ? trustLevelOf(user) : 'new';
  cache.set(userId, { level, at: Date.now() });
  return level;
}

export async function limitsForUser(userId: string | undefined): Promise<ReachLimits> {
  return reachLimitsFor(await trustLevelFor(userId));
}

// ── The same ladder, as a where clause ───────────────────────────────────────

/**
 * Whose content Newt will actively put in front of a search engine: everyone at
 * 'established' or above, which is everybody except accounts under a day old
 * that have not enrolled in 2FA.
 *
 * This is trustLevelOf's rule again, written as a Prisma filter because the
 * sitemap and the tag pages have to apply it to every author at once rather than
 * one at a time. **The two must stay in step** — if the ladder changes what earns
 * 'established', this changes with it. It lives here, next to the function it
 * mirrors, precisely so that is hard to forget.
 *
 * Why gate this when there is deliberately no per-user "hide from search"
 * switch? Because they are different axes. That decision was about a user's
 * choice over their own content, and nothing here touches it: a new account's
 * public post still has an indexable page at its own URL, still unfurls, and is
 * still readable by anyone with the link. What it does not get is Newt handing
 * the URL to Google, or a slot on a browsable hub page, on its first day.
 *
 * Registration is open and unverified. Without this, a spam run costs nothing
 * and the damage — a domain that teaches crawlers it is full of junk — lands on
 * every other author on the instance rather than on the spammer.
 */
export function indexableAuthorWhere(now: Date = new Date()) {
  return {
    bannedAt: null,
    OR: [
      // 2FA promotes immediately, exactly as it does above: it is the
      // per-account manual cost a spam farm does not pay.
      { totpEnabled: true },
      { createdAt: { lte: new Date(now.getTime() - NEW_ACCOUNT_MS) } },
    ],
  };
}
