import { describe, it, expect } from 'vitest';
import { trustLevelOf, reachLimitsFor, NEW_ACCOUNT_MS } from './trust';

const now = new Date('2026-07-30T12:00:00Z');
const agedMs = (ms: number) => new Date(now.getTime() - ms);

describe('trustLevelOf', () => {
  it('starts a fresh account at the tightest level', () => {
    expect(trustLevelOf({ createdAt: now, totpEnabled: false }, now)).toBe('new');
  });

  it('promotes to established once the account is a day old', () => {
    expect(trustLevelOf({ createdAt: agedMs(NEW_ACCOUNT_MS), totpEnabled: false }, now)).toBe('established');
    expect(trustLevelOf({ createdAt: agedMs(NEW_ACCOUNT_MS - 1), totpEnabled: false }, now)).toBe('new');
  });

  // 2FA stands in for the email verification the server cannot yet do: it is the
  // only per-account cost available, so it must not also require waiting a day.
  it('promotes a brand-new account straight to trusted when 2FA is on', () => {
    expect(trustLevelOf({ createdAt: now, totpEnabled: true }, now)).toBe('trusted');
  });

  it('keeps an old account with 2FA at trusted, not merely established', () => {
    expect(trustLevelOf({ createdAt: agedMs(NEW_ACCOUNT_MS * 400), totpEnabled: true }, now)).toBe('trusted');
  });
});

describe('reachLimitsFor', () => {
  // The ladder only ever widens. If this inverts, a new account would get more
  // reach than an established one — the exact opposite of the point.
  it('is monotonic across levels', () => {
    const n = reachLimitsFor('new');
    const e = reachLimitsFor('established');
    const t = reachLimitsFor('trusted');
    for (const k of ['friendRequestsPerHour', 'commentsPerMinute', 'commentsPerHour'] as const) {
      expect(n[k]).toBeLessThan(e[k]);
      expect(e[k]).toBeLessThan(t[k]);
    }
  });

  // Introducing the ladder must not quietly throttle the users who were fine
  // before it existed: 'established' is the pre-existing limit set.
  it('leaves established accounts on the limits that applied before the ladder', () => {
    expect(reachLimitsFor('established')).toEqual({
      friendRequestsPerHour: 30, commentsPerMinute: 8, commentsPerHour: 60,
    });
  });

  it('still lets a new account participate rather than blocking it', () => {
    const n = reachLimitsFor('new');
    expect(n.friendRequestsPerHour).toBeGreaterThan(0);
    expect(n.commentsPerMinute).toBeGreaterThan(0);
  });
});
