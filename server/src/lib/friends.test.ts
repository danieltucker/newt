import { describe, it, expect } from 'vitest';
import { displayNameOf, toPublicUser, PublicUser } from './friends';

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
