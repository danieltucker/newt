import { AppNotification } from '../types';

// What the actor did, without naming them - the predicate of the sentence
// notifText builds. Split out so the panel can render the name as a link to
// their profile and this part as plain text, instead of string-matching a
// prefix back out of a finished sentence.
//
// Returns '' when the type has nothing to add beyond the name, which is also
// how a notification type this build doesn't know about degrades: the name
// alone, rather than a blank row.
export function notifAction(type: AppNotification['type']): string {
  switch (type) {
    case 'friend_request': return 'sent you a friend request';
    case 'friend_accept':  return 'accepted your friend request';
    case 'comment_reply':  return 'replied to your comment';
    case 'friend_comment': return 'shared a comment with friends';
    case 'friend_post':    return 'shared a blog post with friends';
    // Moderator-only, and deliberately actorless: the subject is the report,
    // not the person who filed it.
    case 'report_new':     return 'was reported for review';
    // Admin-only. The new account *is* the actor, so this one reads with a name
    // in front of it the way the friend notifications do.
    case 'user_new':       return 'created an account';
    // Admin-only and actorless, like a report: a feed is not a person.
    case 'feed_failing':   return 'is failing to load';
    // The end state of the one above: the refresher has stopped polling it. Said
    // as a completed action, because it is one - and it is the alert that means
    // articles have stopped arriving for everyone subscribed.
    case 'feed_disabled':  return 'was switched off after repeated failures';
    default:               return '';
  }
}

// Who a notification is about, for display. Falls back when the actor is gone
// (deleted account) or was never set.
export function notifActor(n: Pick<AppNotification, 'type' | 'actor'>): string {
  if (n.actor) return n.actor.displayName;
  // The two actorless admin types each name their own subject, so that the
  // sentence says what happened rather than "Someone was reported for review".
  if (n.type === 'report_new') return 'Content';
  if (n.type === 'feed_failing' || n.type === 'feed_disabled') return 'A feed';
  return 'Someone';
}

// Human-readable one-liner for a notification, given its type and actor.
export function notifText(n: Pick<AppNotification, 'type' | 'actor'>): string {
  const who = notifActor(n);
  const action = notifAction(n.type);
  return action ? `${who} ${action}` : who;
}

// Compact relative time ("just now", "5m ago", "3d ago", or a date past a week).
export function relTime(iso: string, nowMs = Date.now()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const mins = Math.floor((nowMs - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
