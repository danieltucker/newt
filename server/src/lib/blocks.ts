import prisma from './prisma';

// Blocking, as this app means it: a wall, not a mute.
//
// The Block row is directed — someone did the blocking, and only they can undo
// it — but every gate reads it from *both* sides. One row therefore makes two
// people mutually invisible: neither sees the other's comments or posts, neither
// can friend-request or reply to the other, neither turns up in the other's
// search. The blocked person is never told; from their side the other account
// simply stops existing.
//
// That symmetry is the whole point. A one-way block would still leave the
// blocked person free to read the thread and answer back, which is the behaviour
// people block to stop.

// Every userId walled off from this user, in either direction — the set to
// exclude from anything they read. One query; callers hold it for the request.
export async function blockWallOf(userId: string | undefined): Promise<Set<string>> {
  if (!userId) return new Set();
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.blockerId === userId ? r.blockedId : r.blockerId);
  }
  return ids;
}

// Is there a wall between these two, whichever way round it was raised? Used by
// the single-target gates (send a friend request, open one profile, reply to one
// comment) where fetching the whole wall would be wasteful.
export async function isWalledOff(a: string | undefined, b: string | undefined): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const found = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { id: true },
  });
  return found !== null;
}

// Which way round the wall runs, for the one surface that must tell them apart:
// the blocker's view of a profile they blocked shows an Unblock button, while
// the blocked person's view is an ordinary 404. Anything that leaked "you have
// been blocked" would hand back exactly the signal blocking exists to withhold.
export type WallDirection = 'none' | 'you-blocked-them' | 'they-blocked-you';

export async function wallDirection(viewerId: string | undefined, otherId: string): Promise<WallDirection> {
  if (!viewerId || viewerId === otherId) return 'none';
  const row = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: viewerId, blockedId: otherId },
        { blockerId: otherId, blockedId: viewerId },
      ],
    },
    select: { blockerId: true },
  });
  if (!row) return 'none';
  return row.blockerId === viewerId ? 'you-blocked-them' : 'they-blocked-you';
}

// ── Pure query fragments ────────────────────────────────────────────────────
// Kept pure (no Prisma import needed to test them) for the same reason
// visibilityWhere is: these decide who can read what, and that deserves unit
// tests that don't need a database.

// Prisma `where` fragment excluding rows authored by anyone behind the wall.
// Returns `{}` when there is no wall, so the common case adds nothing to the
// query — and crucially never emits `{ userId: { notIn: [] } }`, which is a
// no-op clause Prisma still has to plan.
export function notWalledWhere(wall: Set<string>, field = 'userId'): Record<string, unknown> {
  if (wall.size === 0) return {};
  return { [field]: { notIn: [...wall] } };
}

// The same fragment for a *nullable* author column, which `notWalledWhere`
// cannot serve. `NOT IN (...)` is three-valued in SQL: a NULL column yields
// NULL, not true, so those rows silently drop out of the result. Notification
// rows legitimately carry a null actor (a system notice belongs to no one), and
// losing them the moment the reader blocks anybody would be a real bug rather
// than a stricter filter.
export function notWalledNullableWhere(wall: Set<string>, field = 'actorId'): Record<string, unknown> {
  if (wall.size === 0) return {};
  return { OR: [{ [field]: null }, { [field]: { notIn: [...wall] } }] };
}

// The same idea for an already-fetched list: drop anything by a walled-off
// author. Used where the rows are merged in memory (a profile's activity feed)
// rather than filtered in SQL.
export function withoutWalled<T>(rows: T[], wall: Set<string>, authorIdOf: (row: T) => string | null | undefined): T[] {
  if (wall.size === 0) return rows;
  return rows.filter(r => {
    const id = authorIdOf(r);
    return !id || !wall.has(id);
  });
}
