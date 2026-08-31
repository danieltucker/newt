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
  // AI tasks. Editing one changes a system prompt the instance will run
  // unattended, which is the whole of what an admin controls here, so the
  // config actions are recorded as carefully as the generations were.
  //
  // `ai.run` is the one action in this table that is *routine*: it fires on
  // every job the queue completes. That was true of `persona.generate` before
  // it and for the same reason — it is what answers "who told it to publish
  // that", and the answer being "the nightly pass, under this prompt" is
  // exactly as worth recording as a person having pressed a button.
  aiTaskCreate: 'task.create',
  aiTaskUpdate: 'task.update',
  aiTaskDelete: 'task.delete',
  aiRun: 'task.run',
  // Publishing a generated explore. Separate from ai.run because it is the
  // human decision in the loop: a thread is a page with a URL and a search
  // footprint, and the row that says who made it public is the one that
  // matters six months later.
  aiPublish: 'task.publish',
  // Pulling or deleting a model on the operator's own box. Destructive-adjacent
  // in both directions — a pull writes gigabytes to the host's disk, a delete
  // takes a model out from under whatever was configured to use it.
  modelPull: 'model.pull',
  modelDelete: 'model.purge',
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
  'comment' | 'blogPost' | 'user' | 'report' | 'feed' | 'domain' | 'persona' | 'siteModel' | 'aiTask';

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
  // Personas were removed in v1.28.0 and these four verbs are no longer
  // written. They stay because the rows do: an audit trail that renders its own
  // history as blank cells is worse than one carrying four dead keys, which is
  // the same bargain actionLabel's fallback makes below.
  'persona.create': 'Created persona',
  'persona.update': 'Edited persona',
  'persona.delete': 'Deleted persona',
  'persona.generate': 'Persona wrote',
  'task.create': 'Created AI task',
  'task.update': 'Edited AI task',
  'task.delete': 'Deleted AI task',
  'task.run': 'AI task ran',
  'task.publish': 'Published generated explore',
  'model.pull': 'Downloaded a model',
  'model.purge': 'Deleted a downloaded model',
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
    // A local model delete takes gigabytes off the operator's disk and pulls
    // the model out from under whatever was configured to use it. Nothing in
    // Newt can put it back — only another multi-gigabyte download can.
    || action === ADMIN_ACTIONS.modelDelete
    // Retained so historical persona.delete rows still render as destructive.
    // That verb is no longer written; see ACTION_LABELS.
    || action === 'persona.delete';
}
