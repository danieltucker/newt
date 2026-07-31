import { describe, it, expect } from 'vitest';
import { accountMenuItems } from './shellNav';

// navMenuItems is gone with the hamburger's destination list: My posts and My
// profile moved here, and home is the mark in the corner. The hamburger holds
// only the bookmarks rail now, which is markup rather than a list to gate.
describe('accountMenuItems', () => {
  it('lists the account actions for an ordinary user', () => {
    const ids = accountMenuItems({}).map(i => i.id);
    expect(ids).toEqual(['profile', 'myblog', 'settings', 'signout']);
  });

  // The route stayed /blog so nobody's saved link broke, and the label lost its
  // "My" when it moved off the hamburger and under your own avatar.
  it('calls the blog manager Posts', () => {
    const item = accountMenuItems({}).find(i => i.id === 'myblog');
    expect(item?.label).toBe('Posts');
  });

  it('offers nothing of yours to a signed-out visitor', () => {
    const ids = accountMenuItems({ signedIn: false }).map(i => i.id);
    expect(ids).not.toContain('myblog');
    expect(ids).not.toContain('profile');
  });

  it('has no people entry - friends live on the profile, notifications on the bell', () => {
    for (const opts of [{}, { isAdmin: true }, { signedIn: false }]) {
      expect(accountMenuItems(opts).map(i => i.id)).not.toContain('people');
    }
  });

  it('adds the admin console only for admins', () => {
    expect(accountMenuItems({ isAdmin: true }).map(i => i.id)).toContain('admin');
    expect(accountMenuItems({ isAdmin: false }).map(i => i.id)).not.toContain('admin');
  });

  it('keeps sign out last and flagged as destructive', () => {
    const items = accountMenuItems({ isAdmin: true });
    const last = items[items.length - 1];
    expect(last.id).toBe('signout');
    expect(last.danger).toBe(true);
  });

  it('offers only sign in to a signed-out visitor', () => {
    expect(accountMenuItems({ signedIn: false }).map(i => i.id)).toEqual(['signin']);
    // Even an admin flag must not leak the console to a logged-out session.
    expect(accountMenuItems({ signedIn: false, isAdmin: true }).map(i => i.id))
      .toEqual(['signin']);
  });
});
