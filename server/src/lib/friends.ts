import prisma from './prisma';

// Author/actor fields safe to expose on anyone — never email or anything private.
export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatar: true,
} as const;

export type PublicUser = {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
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
  };
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
