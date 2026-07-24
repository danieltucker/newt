import { AppNotification } from '../types';

// Human-readable one-liner for a notification, given its type and actor.
export function notifText(n: Pick<AppNotification, 'type' | 'actor'>): string {
  const who = n.actor?.displayName ?? 'Someone';
  switch (n.type) {
    case 'friend_request': return `${who} sent you a friend request`;
    case 'friend_accept':  return `${who} accepted your friend request`;
    case 'comment_reply':  return `${who} replied to your comment`;
    case 'friend_comment': return `${who} shared a comment with friends`;
    default:               return who;
  }
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
