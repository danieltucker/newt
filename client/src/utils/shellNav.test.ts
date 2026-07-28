import { describe, it, expect } from 'vitest';
import { navMenuItems, accountMenuItems } from './shellNav';

describe('navMenuItems', () => {
  it('always offers home, blog and profile', () => {
    const ids = navMenuItems({ username: 'sam', path: '/' }).map(i => i.id);
    expect(ids).toEqual(['home', 'myblog', 'profile']);
  });

  it('labels home with the product name, which ShellBar pairs with the mark', () => {
    const home = navMenuItems({ username: 'sam', path: '/blog' })[0];
    expect(home).toMatchObject({ id: 'home', label: 'Newt', to: '/' });
  });

  // The route stayed /blog so nobody's saved link broke; only the word changed.
  it('calls the section Posts, whatever the route is still called', () => {
    const item = navMenuItems({ username: 'sam', path: '/' }).find(i => i.id === 'myblog');
    expect(item).toMatchObject({ label: 'My posts', to: '/blog' });
  });

  it('points the profile entry at the signed-in user', () => {
    const items = navMenuItems({ username: 'sam', path: '/' });
    expect(items.find(i => i.id === 'profile')?.to).toBe('/u/sam');
  });

  it('encodes usernames that need it', () => {
    const items = navMenuItems({ username: 'a b/c', path: '/' });
    expect(items.find(i => i.id === 'profile')?.to).toBe('/u/a%20b%2Fc');
  });

  it('marks exactly the entry matching the current path', () => {
    const current = (path: string) =>
      navMenuItems({ username: 'sam', path }).filter(i => i.current).map(i => i.id);

    expect(current('/')).toEqual(['home']);
    expect(current('/blog')).toEqual(['myblog']);
    expect(current('/u/sam')).toEqual(['profile']);
  });

  it('keeps the blog marked while writing - the composer is part of that section', () => {
    const current = (path: string) =>
      navMenuItems({ username: 'sam', path }).filter(i => i.current).map(i => i.id);

    expect(current('/blog/new')).toEqual(['myblog']);
    expect(current('/blog/abc123')).toEqual(['myblog']);
  });

  it('treats a trailing slash as the same page', () => {
    const items = navMenuItems({ username: 'sam', path: '/blog/' });
    expect(items.find(i => i.id === 'myblog')?.current).toBe(true);
  });

  it('marks nothing when the path is some other page', () => {
    // A post - /u/sam/a-slug - is not the profile, and not the blog manager.
    const items = navMenuItems({ username: 'sam', path: '/u/sam/hello-world' });
    expect(items.some(i => i.current)).toBe(false);
  });
});

describe('accountMenuItems', () => {
  it('lists the account actions for an ordinary user', () => {
    const ids = accountMenuItems({}).map(i => i.id);
    expect(ids).toEqual(['profile', 'settings', 'signout']);
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
