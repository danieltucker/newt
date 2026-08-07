import prisma from './prisma';
import logger from './logger';

// Notifications that go to every admin rather than to a person, delivered
// through the same bell as everything else.
//
// The pattern is notifyAdminsOfReport in routes/reports.ts, which came first and
// which these follow deliberately: one Notification row per admin, banned admins
// skipped, and the whole thing best-effort. An alert that fails must never take
// the operation that triggered it down with it — a signup that 500s because the
// bell couldn't be rung is a far worse bug than a signup nobody was told about.
//
// The bell is the only channel there is: this server has no SMTP, no webhook and
// no push. If email is wanted later, this file is the seam to add it behind —
// the callers know nothing about how an admin is reached.

async function adminIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { isAdmin: true, bannedAt: null },
    select: { id: true },
  });
  return admins.map(a => a.id);
}

/**
 * A new account was created.
 *
 * The new user is the actor, so the alert links to their profile — which is the
 * first thing you want when the point of knowing is to see who just arrived.
 * They're also excluded from their own alert, for the case where the instance's
 * very first account is an admin registering themselves.
 */
export async function notifyAdminsOfSignup(newUserId: string, username: string): Promise<void> {
  try {
    const ids = (await adminIds()).filter(id => id !== newUserId);
    if (ids.length === 0) return;
    await prisma.notification.createMany({
      data: ids.map(id => ({
        userId: id,
        type: 'user_new',
        actorId: newUserId,
        articleTitle: `@${username}`,
      })),
    });
  } catch (err) {
    logger.warn({ err, username }, 'Could not notify admins of a new signup');
  }
}

/**
 * A feed has failed enough times in a row to be worth reporting.
 *
 * Actorless, like a report alert: the subject is the feed, and there is no
 * person to attribute it to. Rate limiting is the caller's job — see
 * shouldAlertForFeed, which is what stops a permanently dead feed refilling the
 * bell on every scheduler tick.
 */
export async function notifyAdminsOfFeedFailure(
  feedUrl: string,
  title: string,
  failures: number,
): Promise<void> {
  try {
    const ids = await adminIds();
    if (ids.length === 0) return;
    const label = title || feedUrl;
    await prisma.notification.createMany({
      data: ids.map(id => ({
        userId: id,
        type: 'feed_failing',
        actorId: null,
        articleTitle: `${label} — ${failures} failed checks in a row`,
        articleUrl: feedUrl,
      })),
    });
  } catch (err) {
    logger.warn({ err, feedUrl }, 'Could not notify admins of a failing feed');
  }
}

/**
 * A feed has been switched off after failing for long enough.
 *
 * Deliberately not rate-limited the way notifyAdminsOfFeedFailure is: this
 * happens once per feed, and it is the message that says articles have stopped
 * arriving for everyone subscribed to it. Suppressing it behind the daily
 * re-alert window would hide the only alert that reports a state change rather
 * than a continuing condition.
 */
export async function notifyAdminsOfFeedDisabled(
  feedUrl: string,
  title: string,
  failures: number,
): Promise<void> {
  try {
    const ids = await adminIds();
    if (ids.length === 0) return;
    const label = title || feedUrl;
    await prisma.notification.createMany({
      data: ids.map(id => ({
        userId: id,
        type: 'feed_disabled',
        actorId: null,
        articleTitle: `${label} — switched off after ${failures} failed checks`,
        articleUrl: feedUrl,
      })),
    });
  } catch (err) {
    logger.warn({ err, feedUrl }, 'Could not notify admins of a disabled feed');
  }
}

// One bad fetch is not news: origins time out, CDNs hiccup, and the refresher
// already treats a stale window as backoff. Three consecutive misses means about
// an hour and a half of a feed not working, which is a real fault.
export const FEED_FAILURE_ALERT_THRESHOLD = 3;

// How long a still-broken feed stays quiet after it has been reported. It is
// worth a reminder eventually — a feed nobody fixed is still broken — but daily,
// not every five minutes.
export const FEED_FAILURE_REALERT_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a failure that has just been recorded should ring the bell.
 *
 * Fires on the run crossing the threshold, then at most once a day while the
 * feed stays broken. `alertedAt` is cleared on recovery (see feedRefresh), so a
 * feed that breaks, is fixed, and breaks again is reported both times.
 */
export function shouldAlertForFeed(
  consecutiveFailures: number,
  failureAlertedAt: Date | null,
  now = Date.now(),
): boolean {
  if (consecutiveFailures < FEED_FAILURE_ALERT_THRESHOLD) return false;
  if (!failureAlertedAt) return true;
  return now - failureAlertedAt.getTime() >= FEED_FAILURE_REALERT_MS;
}
