// The avatar menu, which is the only list the app bar hangs off now.
//
// It is deliberately *not* a list of destinations any more. The navigation rail
// carries those - Today, Posts, Explore - and having them here too meant two
// places to look for the same row, with the menu winning by being nearer the
// pointer and the rail then reading as decoration.
//
// What is left is the split the rail cannot make: this is you and your
// configuration, and the rail is your content. Profile, Settings, the admin
// console and the way out. A reader looking for something to read goes left; a
// reader looking for their own account goes to the corner their own face is in.
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
}): ShellMenuItem[] {
  const { isAdmin = false, signedIn = true } = opts;

  if (!signedIn) return [{ id: 'signin', label: 'Sign in' }];

  // No people entry: friends moved onto the profile's own Friends tab, and the
  // bell in the bar covers notifications. Both would be duplicates here.
  //
  // No Posts and no Explore either, for the same reason by a different route -
  // both are places you go, and places you go are the rail's job. Posts in
  // particular used to be here because there was nowhere else to put the blog
  // manager; now there is.
  //
  // Bare labels throughout: the menu hangs off your own avatar, so "My" on
  // every row would be saying it three times.
  const items: ShellMenuItem[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'settings', label: 'Settings' },
  ];
  if (isAdmin) items.push({ id: 'admin', label: 'Admin' });
  items.push({ id: 'signout', label: 'Sign out', danger: true });
  return items;
}
