import { describe, it, expect } from 'vitest';
import { notWalledWhere, withoutWalled } from './blocks';

describe('notWalledWhere', () => {
  it('adds nothing when there is no wall', () => {
    // The common case. An empty `notIn` would be a clause Prisma still plans.
    expect(notWalledWhere(new Set())).toEqual({});
  });

  it('excludes every walled-off author', () => {
    expect(notWalledWhere(new Set(['a', 'b']))).toEqual({ userId: { notIn: ['a', 'b'] } });
  });

  it('can target a differently-named author column', () => {
    expect(notWalledWhere(new Set(['a']), 'actorId')).toEqual({ actorId: { notIn: ['a'] } });
  });

  it('never emits an empty notIn', () => {
    expect(JSON.stringify(notWalledWhere(new Set()))).not.toContain('notIn');
  });
});

describe('withoutWalled', () => {
  const rows = [
    { id: 1, userId: 'a' },
    { id: 2, userId: 'b' },
    { id: 3, userId: 'c' },
  ];

  it('returns the list untouched when there is no wall', () => {
    const out = withoutWalled(rows, new Set(), r => r.userId);
    expect(out).toBe(rows);   // same reference — no needless copy
  });

  it('drops rows authored by anyone behind the wall', () => {
    expect(withoutWalled(rows, new Set(['b']), r => r.userId).map(r => r.id)).toEqual([1, 3]);
  });

  it('keeps rows with no identifiable author rather than guessing', () => {
    // A tombstoned comment exposes no author; it holds up its replies and is
    // not somebody's speech, so a wall has nothing to say about it.
    const anon = [{ id: 9, userId: null as string | null }];
    expect(withoutWalled(anon, new Set(['b']), r => r.userId)).toHaveLength(1);
  });

  it('can empty the list entirely', () => {
    expect(withoutWalled(rows, new Set(['a', 'b', 'c']), r => r.userId)).toEqual([]);
  });
});
