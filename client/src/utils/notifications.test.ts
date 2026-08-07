import { describe, it, expect } from 'vitest';
import { notifText, notifAction, notifActor, relTime } from './notifications';
import { NotificationType } from '../types';

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

describe('notifAction', () => {
  // The panel renders the name as a profile link and this part as plain text,
  // so the split has to hold: name + ' ' + action must reproduce notifText.
  it('composes back into the full sentence', () => {
    const types: NotificationType[] = [
      // 'user_new' belongs in this list and not the actorless one below: the new
      // account is the actor, so the admin's alert reads "Jane Doe created an
      // account" with the name linking to the profile.
      'friend_request', 'friend_accept', 'comment_reply', 'friend_comment', 'friend_post', 'user_new',
    ];
    for (const type of types) {
      expect(notifText({ type, actor })).toBe(`Jane Doe ${notifAction(type)}`);
    }
  });

  it('never names the actor - that half belongs to notifActor', () => {
    const types: NotificationType[] = [
      'friend_request', 'friend_accept', 'comment_reply', 'friend_comment', 'friend_post',
      'report_new', 'user_new', 'feed_failing', 'feed_disabled',
    ];
    for (const type of types) {
      expect(notifAction(type)).not.toMatch(/Jane|Someone/);
    }
  });

  it('degrades to the name alone for a type this build does not know', () => {
    expect(notifAction('mystery_event' as NotificationType)).toBe('');
    expect(notifText({ type: 'mystery_event' as NotificationType, actor })).toBe('Jane Doe');
  });
});

describe('notifActor', () => {
  it('uses the actor display name when there is one', () => {
    expect(notifActor({ type: 'comment_reply', actor })).toBe('Jane Doe');
  });

  it('says "Someone" for an ordinary notification with no actor', () => {
    expect(notifActor({ type: 'comment_reply', actor: null })).toBe('Someone');
  });

  it('says "Content" for a report notice, which is actorless by design', () => {
    // Report notifications deliberately carry no actor, so that a moderator who
    // blocked the reporter still sees the report. "Someone was reported for
    // review" would read as though a person had been identified.
    expect(notifActor({ type: 'report_new', actor: null })).toBe('Content');
    expect(notifText({ type: 'report_new', actor: null })).toBe('Content was reported for review');
  });

  it('says "A feed" for a failing-feed alert, which is actorless too', () => {
    // Same reasoning as the report notice, for a different reason there is no
    // actor: a feed isn't a person. "Someone is failing to load" is nonsense.
    expect(notifActor({ type: 'feed_failing', actor: null })).toBe('A feed');
    expect(notifText({ type: 'feed_failing', actor: null })).toBe('A feed is failing to load');
  });

  it('says "A feed" for the switched-off alert too', () => {
    // The terminal state of the one above, and the alert that actually means
    // articles have stopped arriving - it must not degrade to a bare name.
    expect(notifActor({ type: 'feed_disabled', actor: null })).toBe('A feed');
    expect(notifText({ type: 'feed_disabled', actor: null }))
      .toBe('A feed was switched off after repeated failures');
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
