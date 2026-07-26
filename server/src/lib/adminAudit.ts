import { Prisma } from '@prisma/client';

// The vocabulary of things an admin can do. Dotted `<target>.<verb>` so the
// audit view can group by prefix, and a closed set so a typo in a route handler
// is a compile error rather than a row nobody can filter for.
export const ADMIN_ACTIONS = {
  commentDelete: 'comment.delete',
  postUnpublish: 'post.unpublish',
  userBan: 'user.ban',
  userUnban: 'user.unban',
  userPromote: 'user.promote',
  userDemote: 'user.demote',
  userDelete: 'user.delete',
} as const;

export type AdminActionName = (typeof ADMIN_ACTIONS)[keyof typeof ADMIN_ACTIONS];

export type AdminTargetType = 'comment' | 'blogPost' | 'user';

export interface AdminActionInput {
  actorId: string;
  actorUsername: string;
  action: AdminActionName;
  targetType: AdminTargetType;
  targetId: string;
  /** Human-readable identity of the target, read *before* the action ran. */
  targetLabel: string;
  metadata?: Prisma.InputJsonValue;
}

// Any Prisma client — the real one, or the transactional client handed to a
// $transaction callback. Every caller passes the latter: an admin action and
// its audit row commit together or not at all, so the table can never be
// missing something that happened.
type Db = Pick<Prisma.TransactionClient, 'adminAction'>;

export async function recordAdminAction(db: Db, input: AdminActionInput): Promise<void> {
  await db.adminAction.create({
    data: {
      actorId: input.actorId,
      actorUsername: input.actorUsername,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      metadata: input.metadata,
    },
  });
}

// ── Presentation ────────────────────────────────────────────────────────────
// Shared with the admin UI through the API response, so the wording of an
// action lives in one place instead of being re-derived in the client.
const ACTION_LABELS: Record<string, string> = {
  'comment.delete': 'Deleted comment',
  'post.unpublish': 'Unpublished post',
  'user.ban': 'Banned user',
  'user.unban': 'Unbanned user',
  'user.promote': 'Granted admin',
  'user.demote': 'Revoked admin',
  'user.delete': 'Deleted account',
};

export function actionLabel(action: string): string {
  // An unknown verb still renders legibly rather than as a blank cell — rows
  // written by an older build must survive a rename here.
  return ACTION_LABELS[action] ?? action;
}

// Whether an action destroyed something irreversibly, which the UI flags.
export function isDestructive(action: string): boolean {
  return action === ADMIN_ACTIONS.commentDelete || action === ADMIN_ACTIONS.userDelete;
}
