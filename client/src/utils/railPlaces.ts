/**
 * What the navigation rail offers, and which row is the one you're looking at.
 *
 * The rail is content and nothing else. Settings, the admin console and your
 * own account row are not here - they live in the avatar menu, which is the
 * other half of a deliberate split: the rail is where you keep things and the
 * corner is who you are. See shellNav for that side of it, and the test that
 * holds the two lists apart.
 *
 * Separate from the rail component for the same reason shellNav is separate
 * from ShellBar: what appears is conditional (Explore needs a model) and which
 * row highlights is a matching problem, and both are worth testing without
 * mounting a rail.
 *
 * Icons are not here. They are JSX and this is a .ts file, but that split is
 * also the right one: which places exist is a rule, what they look like is the
 * rail's business — the same division shellNav already draws.
 */

import { EXPLORE_PATH, isExplorePath } from './researchUrl';

export interface RailPlace {
  /** Stable key; also what the rail keys its icon off. */
  id: string;
  label: string;
  /** Where the row goes. */
  href: string;
}

/**
 * The destinations, in rail order.
 *
 * Three of the six places the proposal describes are missing on purpose: Feed,
 * Reading and Bookmarks have no addresses yet. A row that navigates nowhere is
 * worse than a row that isn't there, so each one arrives with its route rather
 * than ahead of it.
 */
export function railPlaces(opts: { hasModel?: boolean } = {}): RailPlace[] {
  const places: RailPlace[] = [
    { id: 'today', label: 'Today', href: '/' },
    // The blog manager, drafts included - not the profile's public Posts tab.
    // Same distinction the avatar menu already draws.
    { id: 'posts', label: 'Posts', href: '/blog' },
  ];
  // Gated exactly as the avatar menu gates it: a row leading to "you need to
  // set this up first" is an advert, and the rail is for where you can go.
  if (opts.hasModel) places.push({ id: 'explore', label: 'Explore', href: EXPLORE_PATH });
  return places;
}

/**
 * Which row to light up for a pathname, or null for somewhere the rail doesn't
 * name.
 *
 * Null is a real answer and the common one: a profile, a post, a site page or a
 * tag hub is somewhere you arrived from a link, and lighting up Today because
 * nothing else matched would tell the reader they are somewhere they are not.
 *
 * Settings and the admin console return null too, and that is the point rather
 * than an omission. They are not in the rail - they belong to the avatar menu,
 * on the other side of the line between your content and your account - so
 * there is no row for them to light.
 *
 * Matching is by prefix where the place owns a subtree - /blog/new and
 * /blog/<id> are both Posts - and exact where it does not. Today is the only
 * exact match, because '/' is a prefix of everything.
 */
export function activeRailPlace(path: string): string | null {
  if (path === '/' || path === '') return 'today';
  if (path === '/blog' || path.startsWith('/blog/')) return 'posts';
  if (isExplorePath(path)) return 'explore';
  return null;
}
