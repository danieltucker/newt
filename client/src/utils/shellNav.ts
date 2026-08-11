// The avatar menu, which is the only list the app bar hangs off now.
//
// Everything about you - your profile, your posts, your settings - is under the
// avatar, which is where people look for their own things. The hamburger that
// used to carry those destinations holds nothing but the bookmarks rail, and
// only on viewports too narrow to show that rail beside the body.
//
// The list lives here rather than inline in ShellBar because what appears is
// conditional (admin-only entries, signed-out visitors), and that gating is
// worth testing without mounting a component.

export interface ShellMenuItem {
  /** Stable key; also what ShellBar switches on for action items. */
  id: string;
  label: string;
  /** Rendered in the destructive colour and separated from the rest. */
  danger?: boolean;
}

/** What the avatar menu offers. `isAdmin` adds the console; signed-out gets sign-in. */
export function accountMenuItems(opts: {
  isAdmin?: boolean;
  signedIn?: boolean;
  /**
   * Whether the account has an AI model connected. Research only appears once
   * one is — a menu row that leads to "you need to set this up first" is an
   * advert, and this menu is for your own things, not for what you could buy.
   */
  hasModel?: boolean;
}): ShellMenuItem[] {
  const { isAdmin = false, signedIn = true, hasModel = false } = opts;

  if (!signedIn) return [{ id: 'signin', label: 'Sign in' }];

  // No people entry: friends moved onto the profile's own Friends tab, and the
  // bell in the bar covers notifications. Both would be duplicates here.
  //
  // Posts is the blog manager - your drafts as well as what's published - which
  // is why it belongs beside Profile rather than on the profile's public Posts
  // tab. Bare labels throughout: the menu hangs off your own avatar, so "My" on
  // every row would be saying it three times.
  const items: ShellMenuItem[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'myblog', label: 'Posts' },
  ];
  // Above Settings rather than below it: Research is somewhere you go, and
  // Settings is the row people expect at the bottom of a list like this.
  if (hasModel) items.push({ id: 'research', label: 'Research' });
  items.push({ id: 'settings', label: 'Settings' });
  if (isAdmin) items.push({ id: 'admin', label: 'Admin' });
  items.push({ id: 'signout', label: 'Sign out', danger: true });
  return items;
}
