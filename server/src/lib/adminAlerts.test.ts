import { describe, it, expect } from 'vitest';
import {
  shouldAlertForFeed,
  FEED_FAILURE_ALERT_THRESHOLD,
  FEED_FAILURE_REALERT_MS,
} from './adminAlerts';

// The two notify* functions in this module are thin prisma writes; the decision
// they hang off is this predicate, and it is the part with edges worth pinning.
// Getting it wrong in either direction is a real bug: too eager and a flaky
// origin fills every admin's bell, too shy and a dead feed is never reported.

describe('shouldAlertForFeed', () => {
  const now = new Date('2026-08-05T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms);

  it('stays quiet below the threshold', () => {
    for (let n = 0; n < FEED_FAILURE_ALERT_THRESHOLD; n++) {
      expect(shouldAlertForFeed(n, null, now)).toBe(false);
    }
  });

  it('fires on the run that reaches the threshold', () => {
    expect(shouldAlertForFeed(FEED_FAILURE_ALERT_THRESHOLD, null, now)).toBe(true);
  });

  it('does not fire again straight away', () => {
    // The scheduler ticks every 5 minutes and a broken feed fails every tick.
    // Without the stamp check that is 288 notifications a day, per admin.
    expect(shouldAlertForFeed(FEED_FAILURE_ALERT_THRESHOLD + 1, ago(5 * 60_000), now)).toBe(false);
  });

  it('reminds once the re-alert window has passed', () => {
    expect(shouldAlertForFeed(20, ago(FEED_FAILURE_REALERT_MS + 1000), now)).toBe(true);
  });

  it('is exactly at the boundary of the re-alert window, not past it', () => {
    expect(shouldAlertForFeed(20, ago(FEED_FAILURE_REALERT_MS), now)).toBe(true);
    expect(shouldAlertForFeed(20, ago(FEED_FAILURE_REALERT_MS - 1), now)).toBe(false);
  });

  it('reports a feed that broke, was fixed, and broke again', () => {
    // Recovery clears failureAlertedAt (see noteSuccess in feedRefresh), so the
    // second break is a first alert rather than a suppressed repeat - even
    // though the last one was minutes ago.
    expect(shouldAlertForFeed(FEED_FAILURE_ALERT_THRESHOLD, null, now)).toBe(true);
  });

  it('never alerts on a healthy feed however recently one was sent', () => {
    // consecutiveFailures resets to 0 on success, which has to win over any
    // stamp still lying around.
    expect(shouldAlertForFeed(0, ago(FEED_FAILURE_REALERT_MS * 2), now)).toBe(false);
  });
});
