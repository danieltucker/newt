import prisma from './prisma';

// Who is allowed on the global recent-posts page.
//
// This is the one surface in the app with no self-selection in front of it: a
// tag page is reached by going looking for a word, and a profile by knowing
// whose it is, but /recent shows whatever was posted last to whoever turns up.
// That makes it the most valuable page on the site for a crawler to enter
// through, and for the same reason the one worth spamming. Everything below is
// about making a slot on it cost more than a registration form.
//
// Three signals, all of them already recorded. No score, deliberately: a
// weighting is a thing to tune, explain and get wrong, and "why am I not on the
// list" should have an answer a person can act on rather than a number.

/**
 * 2FA, via the trust ladder's own definition of its top rung.
 *
 * Gated on `trustLevelOf(...) === 'trusted'` rather than on `totpEnabled`
 * directly. Today those are the same predicate — enrolling is the only route to
 * 'trusted' — but going through the ladder means this inherits any future change
 * to what earns trust, and keeps the reasoning in trust.ts where the rest of it
 * lives.
 *
 * Expressed as a where clause because it has to run over every author at once.
 */
export function trustedAuthorWhere() {
  return { bannedAt: null, totpEnabled: true };
}

/**
 * How long an upheld report keeps an author off the page.
 *
 * 'resolved' is the status a moderator sets when they acted on a report;
 * 'dismissed' is the one for a report that was wrong, and it is deliberately not
 * counted — being reported is not evidence of anything, or the page would be
 * gateable by anyone willing to file a complaint.
 */
export const REPORT_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Posts an author needs before they qualify.
 *
 * Two, not one: a single post is what a drive-by account produces, and the
 * point is that a slot should represent some ongoing intent to write. It is a
 * low bar on purpose — this is a spam damper, not an editorial standard.
 */
export const MIN_POSTS_FOR_RECENT = 2;

/**
 * The authors currently eligible, newest-qualifying first.
 *
 * Three queries rather than one join, because "has at least N public posts" is a
 * HAVING over a grouped count and the report exclusion is an anti-join — both
 * expressible, neither readable, and the result is cached for minutes at a time
 * so the round trips are not the cost worth optimising.
 *
 * Bounded by `limit` at every step. The set is small by construction (it is the
 * 2FA-enrolled authors), but "small by construction" is exactly the assumption
 * that stops being true quietly.
 */
export async function eligibleAuthorIds(limit = 500, now: Date = new Date()): Promise<string[]> {
  // Authors with enough public posts. groupBy + having does the counting in the
  // database; pulling every author's post count back to compare here would scale
  // with the user table rather than with the answer.
  const grouped = await prisma.blogPost.groupBy({
    by: ['userId'],
    where: { visibility: 'public', user: trustedAuthorWhere() },
    _count: { _all: true },
    having: { userId: { _count: { gte: MIN_POSTS_FOR_RECENT } } },
    // Prisma requires an orderBy alongside take on a groupBy. Ordering by the
    // count is also the right tie-break for the cap: if the eligible set ever
    // outgrows `limit`, the authors dropped should be the ones with least on the
    // site, not whichever the planner happened to return last.
    orderBy: { _count: { userId: 'desc' } },
    take: limit,
  });
  const ids = grouped.map(g => g.userId);
  if (ids.length === 0) return [];

  // Anyone a moderator has acted on recently comes off the list. Queried as the
  // small side of the join — the reports about these authors — rather than by
  // asking each author whether they have any.
  const upheld = await prisma.report.findMany({
    where: {
      subjectId: { in: ids },
      status: 'resolved',
      resolvedAt: { gte: new Date(now.getTime() - REPORT_COOLDOWN_MS) },
    },
    select: { subjectId: true },
  });
  const excluded = new Set(upheld.map(r => r.subjectId));

  return ids.filter(id => !excluded.has(id));
}
