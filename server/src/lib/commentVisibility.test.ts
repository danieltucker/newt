import { describe, it, expect } from 'vitest';
import { isVisibility, visibilityWhere } from './commentVisibility';

describe('isVisibility', () => {
  it('accepts the three valid tiers', () => {
    expect(isVisibility('public')).toBe(true);
    expect(isVisibility('friends')).toBe(true);
    expect(isVisibility('private')).toBe(true);
  });
  it('rejects anything else', () => {
    for (const v of ['Public', 'friend', '', 'all', null, undefined, 3, {}]) {
      expect(isVisibility(v)).toBe(false);
    }
  });
});

describe('visibilityWhere', () => {
  const me = 'user-1';

  it('shows only your own comments when public is hidden and you have no friends', () => {
    expect(visibilityWhere(me, false, new Set())).toEqual({ OR: [{ userId: me }] });
  });

  it('adds public comments when public is shown', () => {
    expect(visibilityWhere(me, true, new Set())).toEqual({
      OR: [{ userId: me }, { visibility: 'public' }],
    });
  });

  it("adds friends' friends-only comments when you have friends", () => {
    const where = visibilityWhere(me, true, new Set(['a', 'b']));
    expect(where.OR).toContainEqual({ userId: me });
    expect(where.OR).toContainEqual({ visibility: 'public' });
    expect(where.OR).toContainEqual({ visibility: 'friends', userId: { in: ['a', 'b'] } });
  });

  it('never leaks friends-only comments when you have no friends', () => {
    const where = visibilityWhere(me, true, new Set());
    expect(JSON.stringify(where)).not.toContain('friends');
  });

  it('still hides other people\'s public comments when opted out, but keeps friends', () => {
    const where = visibilityWhere(me, false, new Set(['a']));
    expect(where.OR).toContainEqual({ userId: me });
    expect(where.OR).toContainEqual({ visibility: 'friends', userId: { in: ['a'] } });
    expect(where.OR).not.toContainEqual({ visibility: 'public' });
  });

  it('gives an anonymous viewer public comments only — never an unscoped userId clause', () => {
    const where = visibilityWhere(undefined, true, new Set());
    expect(where).toEqual({ OR: [{ visibility: 'public' }] });
    // The dangerous case: `{ userId: undefined }` would match every row.
    expect(JSON.stringify(where)).not.toContain('userId');
  });
});
