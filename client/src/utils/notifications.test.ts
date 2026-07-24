import { describe, it, expect } from 'vitest';
import { notifText, relTime } from './notifications';

const actor = { id: 'u1', username: 'jdoe', displayName: 'Jane Doe', avatar: null };

describe('notifText', () => {
  it('describes each notification type with the actor name', () => {
    expect(notifText({ type: 'friend_request', actor })).toBe('Jane Doe sent you a friend request');
    expect(notifText({ type: 'friend_accept', actor })).toBe('Jane Doe accepted your friend request');
    expect(notifText({ type: 'comment_reply', actor })).toBe('Jane Doe replied to your comment');
    expect(notifText({ type: 'friend_comment', actor })).toBe('Jane Doe shared a comment with friends');
  });
  it('falls back to "Someone" when the actor is missing', () => {
    expect(notifText({ type: 'friend_request', actor: null })).toBe('Someone sent you a friend request');
  });
});

describe('relTime', () => {
  const now = new Date('2026-07-24T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('renders recent times relatively', () => {
    expect(relTime(ago(30_000), now)).toBe('just now');
    expect(relTime(ago(5 * 60_000), now)).toBe('5m ago');
    expect(relTime(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(relTime(ago(2 * 86_400_000), now)).toBe('2d ago');
  });
  it('falls back to a calendar date past a week', () => {
    expect(relTime(ago(10 * 86_400_000), now)).toMatch(/[A-Z][a-z]{2} \d+/);
  });
  it('returns an empty string for an invalid date', () => {
    expect(relTime('not-a-date', now)).toBe('');
  });
});
