import { describe, it, expect } from 'vitest';
import { accountMenuItems } from './shellNav';
import { railPlaces } from './railPlaces';

// navMenuItems is gone with the hamburger's destination list, and the menu's own
// destinations went the same way when the navigation rail arrived: Posts and
// Explore are places, and places belong in the rail. What is left here is you
// and your configuration.
describe('accountMenuItems', () => {
  it('lists the account actions for an ordinary user', () => {
    const ids = accountMenuItems({}).map(i => i.id);
    expect(ids).toEqual(['profile', 'settings', 'signout']);
  });

  it('offers nothing of yours to a signed-out visitor', () => {
    const ids = accountMenuItems({ signedIn: false }).map(i => i.id);
    expect(ids).not.toContain('profile');
    expect(ids).not.toContain('settings');
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

// The whole point of the split: one row must never be offered in both places.
// Two ways to reach the same screen is how Posts ended up under a photo of your
// face in the first place.
describe('the menu and the rail do not overlap', () => {
  it('shares no id with the rail, for any account', () => {
    const menu = new Set(accountMenuItems({ isAdmin: true }).map(i => i.id));
    for (const place of railPlaces({ hasModel: true })) {
      expect(menu.has(place.id)).toBe(false);
    }
  });

  it('keeps destinations out of the menu and account rows out of the rail', () => {
    const menu = accountMenuItems({ isAdmin: true }).map(i => i.id);
    expect(menu).not.toContain('today');
    expect(menu).not.toContain('posts');
    expect(menu).not.toContain('explore');

    const rail = railPlaces({ hasModel: true }).map(p => p.id);
    expect(rail).not.toContain('settings');
    expect(rail).not.toContain('admin');
    expect(rail).not.toContain('signout');
    expect(rail).not.toContain('profile');
  });
});
