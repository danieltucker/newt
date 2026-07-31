import { describe, it, expect } from 'vitest';
import {
  displayNameOf, toPublicUser, PublicUser,
  friendPairKey, isDeclineCooldownActive, DECLINE_COOLDOWN_MS,
} from './friends';

const base: PublicUser = { id: 'u1', username: 'jdoe', firstName: null, lastName: null, avatar: null };

describe('displayNameOf', () => {
  it('uses the full name when present', () => {
    expect(displayNameOf({ ...base, firstName: 'Jane', lastName: 'Doe' })).toBe('Jane Doe');
  });
  it('uses just the first or last name when only one is set', () => {
    expect(displayNameOf({ ...base, firstName: 'Jane' })).toBe('Jane');
    expect(displayNameOf({ ...base, lastName: 'Doe' })).toBe('Doe');
  });
  it('falls back to the username when no name is set', () => {
    expect(displayNameOf(base)).toBe('jdoe');
  });
});

describe('toPublicUser', () => {
  it('exposes only safe fields and a derived display name', () => {
    const out = toPublicUser({ ...base, firstName: 'Jane', lastName: 'Doe', avatar: 'data:abc' });
    expect(out).toEqual({ id: 'u1', username: 'jdoe', displayName: 'Jane Doe', avatar: 'data:abc' });
    // No private fields leak through
    expect(out).not.toHaveProperty('firstName');
    expect(out).not.toHaveProperty('email');
  });
});

describe('friendPairKey', () => {
  // The property the unique constraint depends on: whoever asks whom, one pair
  // has one key. Without this, A->B and B->A are different rows and the database
  // cannot tell that they are the same relationship.
  it('is the same whichever way round the pair is given', () => {
    expect(friendPairKey('a', 'b')).toBe(friendPairKey('b', 'a'));
    expect(friendPairKey('zeta', 'alpha')).toBe(friendPairKey('alpha', 'zeta'));
  });

  it('sorts the two ids so the key is deterministic', () => {
    expect(friendPairKey('b', 'a')).toBe('a:b');
  });

  it('gives different pairs different keys', () => {
    expect(friendPairKey('a', 'b')).not.toBe(friendPairKey('a', 'c'));
  });

  // cuids share a prefix and differ later, so ordering must not depend on length
  it('distinguishes ids that share a prefix', () => {
    expect(friendPairKey('cka1', 'cka12')).toBe('cka1:cka12');
    expect(friendPairKey('cka12', 'cka1')).toBe('cka1:cka12');
  });
});

describe('isDeclineCooldownActive', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const declined = (respondedAt: Date | null) => ({
    status: 'declined', requesterId: 'asker', respondedAt,
  });

  it('holds off the declined requester inside the window', () => {
    const justNow = new Date(now.getTime() - 1000);
    expect(isDeclineCooldownActive(declined(justNow), 'asker', now)).toBe(true);
  });

  it('lets the requester try again once the window has passed', () => {
    const old = new Date(now.getTime() - DECLINE_COOLDOWN_MS - 1);
    expect(isDeclineCooldownActive(declined(old), 'asker', now)).toBe(false);
  });

  // The case the cooldown must not break: you turned someone down, then changed
  // your mind. Declining must never lock the *decliner* out of asking.
  it('never holds off the person who did the declining', () => {
    const justNow = new Date(now.getTime() - 1000);
    expect(isDeclineCooldownActive(declined(justNow), 'decliner', now)).toBe(false);
  });

  it('does not apply to pending or accepted rows', () => {
    const justNow = new Date(now.getTime() - 1000);
    expect(isDeclineCooldownActive({ ...declined(justNow), status: 'pending' }, 'asker', now)).toBe(false);
    expect(isDeclineCooldownActive({ ...declined(justNow), status: 'accepted' }, 'asker', now)).toBe(false);
  });

  // A declined row with no timestamp has no window to measure, so it must not
  // become a permanent lockout.
  it('does not lock out forever when respondedAt is missing', () => {
    expect(isDeclineCooldownActive(declined(null), 'asker', now)).toBe(false);
  });
});
