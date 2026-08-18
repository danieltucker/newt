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
  reportResolve: 'report.resolve',
  reportDismiss: 'report.dismiss',
  feedDisable: 'feed.disable',
  feedEnable: 'feed.enable',
  feedDelete: 'feed.delete',
  domainBlock: 'domain.block',
  domainUnblock: 'domain.unblock',
  // Personas. Creating one mints an account, and every generation puts words
  // under a name real readers will reply to — so both are recorded here rather
  // than only in the content itself. `persona.generate` is the one action in
  // this table that is *routine*: it fires on every comment, reply and post a
  // persona writes, which is exactly why it is worth having when someone asks
  // "who told it to say that".
  personaCreate: 'persona.create',
  personaUpdate: 'persona.update',
  personaDelete: 'persona.delete',
  personaGenerate: 'persona.generate',
  // The instance's own model endpoints. Recorded because changing which model
  // the site writes with, or pointing it at a different box, is a change to what
  // the server does on the network — not a preference.
  // `model.*`, not `siteModel.*`: the target half of these names is lowercase
  // throughout the table (`post.unpublish` for a BlogPost), and the audit view
  // groups on that prefix. The label below is what carries the full noun.
  siteModelCreate: 'model.create',
  siteModelUpdate: 'model.update',
  siteModelDelete: 'model.delete',
} as const;

export type AdminActionName = (typeof ADMIN_ACTIONS)[keyof typeof ADMIN_ACTIONS];

export type AdminTargetType =
  'comment' | 'blogPost' | 'user' | 'report' | 'feed' | 'domain' | 'persona' | 'siteModel';

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
  'report.resolve': 'Upheld report',
  'report.dismiss': 'Dismissed report',
  'feed.disable': 'Switched off feed',
  'feed.enable': 'Switched feed back on',
  'feed.delete': 'Deleted feed',
  'domain.block': 'Blocked domain',
  'domain.unblock': 'Unblocked domain',
  'persona.create': 'Created persona',
  'persona.update': 'Edited persona',
  'persona.delete': 'Deleted persona',
  'persona.generate': 'Persona wrote',
  'model.create': 'Added site model',
  'model.update': 'Edited site model',
  'model.delete': 'Removed site model',
};

export function actionLabel(action: string): string {
  // An unknown verb still renders legibly rather than as a blank cell — rows
  // written by an older build must survive a rename here.
  return ACTION_LABELS[action] ?? action;
}

// Whether an action destroyed something irreversibly, which the UI flags.
// Disabling a feed is not here on purpose: it is the reversible half of the
// pair, and flagging it the same as a delete would make the safe action look as
// alarming as the unsafe one.
export function isDestructive(action: string): boolean {
  return action === ADMIN_ACTIONS.commentDelete
    || action === ADMIN_ACTIONS.userDelete
    || action === ADMIN_ACTIONS.feedDelete
    // Deleting a persona takes its account with it, and with the account go its
    // posts and comments — the same reach as user.delete, which is why it sits
    // with the destructive ones rather than with the other persona verbs.
    || action === ADMIN_ACTIONS.personaDelete;
}
