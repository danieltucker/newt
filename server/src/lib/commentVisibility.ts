// Pure helpers for comment visibility, kept out of the route file so they can be
// unit-tested without pulling in Express or Prisma.

export type Visibility = 'public' | 'friends' | 'private';
export const VISIBILITIES: Visibility[] = ['public', 'friends', 'private'];

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === 'string' && (VISIBILITIES as string[]).includes(v);
}

// Visibility rule, applied everywhere: your own comments always; everyone else's
// public ones unless you've opted out; and friends-only comments from people you
// are actually friends with. An undefined userId is an anonymous (logged-out)
// viewer — they get public comments only, and crucially no `{ userId }` clause,
// since `{ userId: undefined }` would match every row in Prisma.
export function visibilityWhere(userId: string | undefined, showPublic: boolean, friendIds: Set<string>) {
  const or: Record<string, unknown>[] = [];
  if (userId) or.push({ userId });
  if (showPublic) or.push({ visibility: 'public' });
  if (friendIds.size > 0) or.push({ visibility: 'friends', userId: { in: [...friendIds] } });
  return { OR: or };
}
