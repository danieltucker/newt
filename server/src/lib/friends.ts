import prisma from './prisma';

// Author/actor fields safe to expose on anyone — never email or anything private.
export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatar: true,
  // Carried on every public shape of a user, not fetched where a badge happens
  // to be drawn. Disclosure that an author is an AI persona has to be a property
  // of "here is a user" — the moment it is opt-in per surface, some surface will
  // be added later that forgets it, and the failure mode of forgetting is an
  // undisclosed AI account. See User.isPersona in schema.prisma.
  isPersona: true,
} as const;

export type PublicUser = {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  isPersona?: boolean;
};

export function displayNameOf(u: PublicUser): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.username;
}

export function toPublicUser(u: PublicUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: displayNameOf(u),
    avatar: u.avatar,
    isPersona: u.isPersona === true,
  };
}

// How long a declined request locks out the person who was declined. The lockout
// is one-directional: it stops the *declined* requester from asking again, but
// the person who declined can still send their own request (see friendPairKey's
// note on flipping the row), because changing your mind about someone you turned
// down is the legitimate case this must not break.
export const DECLINE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// A Friendship row is directed — someone asked, someone was asked — but the
// *relationship* it represents is not. `@@unique([requesterId, addresseeId])`
// only constrains the direction, which left a real hole: A→B and B→A issued at
// the same moment both pass the "does a row already exist?" read (neither sees
// the other's uncommitted insert) and both then insert successfully, because they
// are different tuples. The result is two pending rows for one pair, and
// accepting either leaves the other pending forever.
//
// Ordering the two ids into a single key gives the pair one identity the database
// can enforce. Both directions collapse onto the same value, so the second writer
// loses on a unique violation instead of creating a duplicate — which turns an
// unfixable data-integrity bug into a P2002 the route can handle by re-reading.
export function friendPairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// Is this declined row still inside its cooldown for the given would-be
// requester? Only the person who was previously declined is held off.
export function isDeclineCooldownActive(
  row: { status: string; requesterId: string; respondedAt: Date | null },
  requesterId: string,
  now: Date = new Date(),
): boolean {
  if (row.status !== 'declined') return false;
  if (row.requesterId !== requesterId) return false; // the decliner may ask back
  if (!row.respondedAt) return false;
  return now.getTime() - row.respondedAt.getTime() < DECLINE_COOLDOWN_MS;
}

// The set of userIds this user is accepted friends with, from either side of the
// relationship. Used by the comments visibility rule and the friends UI.
export async function friendIdsOf(userId: string): Promise<Set<string>> {
  const rows = await prisma.friendship.findMany({
    where: {
      status: 'accepted',
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    select: { requesterId: true, addresseeId: true },
  });
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.requesterId === userId ? r.addresseeId : r.requesterId);
  }
  return ids;
}
