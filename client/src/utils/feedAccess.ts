import { SuggestedFeed } from '../types';

export type FeedAccess = SuggestedFeed['access'];

/**
 * How a suggested feed's paywall is described where it's offered.
 *
 * Two states rather than one, because they lead to different decisions: a
 * metered publisher is worth following on the strength of the few reads it
 * gives you, and a subscriber-only one is worth following only if you pay or
 * you want the headlines. Flattening both to "paywalled" would make the first
 * sound like the second and quietly cost the reader some good feeds.
 *
 * Returns null for anything free, which is most of the list - the badge is the
 * exception, not a field every card fills in.
 */
export function accessBadge(access: FeedAccess): { label: string; title: string } | null {
  if (access === 'subscriber') {
    return {
      label: 'Subscription',
      title: 'Reading these articles requires a paid subscription. The feed still delivers headlines and summaries.',
    };
  }
  if (access === 'metered') {
    return {
      label: 'Partly paywalled',
      title: 'This publisher allows a few free articles, then asks for a subscription.',
    };
  }
  return null;
}
