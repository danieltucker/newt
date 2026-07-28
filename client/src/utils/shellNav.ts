// The two menus the compact app bar hangs off. The hamburger answers "where can
// I go", the avatar answers "what can I do to my account" - the split Reddit
// uses, and the one that keeps either list short enough to read at a glance.
//
// Both lists live here rather than inline in ShellBar because what appears is
// conditional (admin-only entries, the you-are-here marker, signed-out
// visitors), and that gating is worth testing without mounting a component.

import { profilePathFor } from './profileUrl';

export interface ShellMenuItem {
  /** Stable key; also what ShellBar switches on for action items. */
  id: string;
  label: string;
  /** Present on items that are a destination. Absent means it runs an action. */
  to?: string;
  /** True for the entry describing the page already on screen. */
  current?: boolean;
  /** Rendered in the destructive colour and separated from the rest. */
  danger?: boolean;
}

/** Where the hamburger can take you. */
export function navMenuItems(opts: { username: string; path: string }): ShellMenuItem[] {
  const { username, path } = opts;
  const profile = profilePathFor(username);

  // Trailing slashes are equivalent for the purpose of "am I here already":
  // navigate() pushes the canonical form, but a pasted URL may carry one.
  const here = (to: string) => {
    const norm = (s: string) => (s.length > 1 ? s.replace(/\/+$/, '') : s);
    return norm(path) === norm(to);
  };

  // The composer lives under /blog too, and it is reached *from* the blog
  // manager - so while you are writing, "My blog" is still the section you are
  // in. Matching the prefix rather than the exact path keeps the marker on.
  const inBlog = path === '/blog' || path.startsWith('/blog/');

  return [
    // Labelled with the product name, not the route - ShellBar pairs it with
    // the mark, and "Newt" beside the logo reads as home in a way "New tab"
    // (which is also a browser action) does not.
    { id: 'home', label: 'Newt', to: '/', current: here('/') },
    { id: 'myblog', label: 'My posts', to: '/blog', current: inBlog },
    { id: 'profile', label: 'My profile', to: profile, current: here(profile) },
  ];
}

/** What the avatar menu offers. `isAdmin` adds the console; signed-out gets sign-in. */
export function accountMenuItems(opts: {
  isAdmin?: boolean;
  signedIn?: boolean;
}): ShellMenuItem[] {
  const { isAdmin = false, signedIn = true } = opts;

  if (!signedIn) return [{ id: 'signin', label: 'Sign in' }];

  // No people entry: friends moved onto the profile's own Friends tab, and the
  // bell in the bar covers notifications. Both would be duplicates here.
  const items: ShellMenuItem[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'settings', label: 'Settings' },
  ];
  if (isAdmin) items.push({ id: 'admin', label: 'Admin' });
  items.push({ id: 'signout', label: 'Sign out', danger: true });
  return items;
}
