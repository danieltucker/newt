/**
 * Screening a comment.
 *
 * ── Shadow mode is the default, and that is a product decision, not caution ──
 *
 * A task starts with `enforce` off, meaning every comment is scored and nothing
 * is acted on. The reason is that nobody — including whoever wrote the prompt —
 * knows whether an 8B model on this instance's actual traffic is any good until
 * they have watched it be wrong for a week. Turning enforcement on before that
 * is a guess, and the cost of guessing wrong is hidden comments by real people.
 *
 * What makes shadow mode worth having rather than a formality is that the
 * verdicts are stored either way (AiJob.verdict), so the override rate — how
 * often an admin disagrees — is a number that exists before anything is
 * enforced. That is the only real evidence that the model earns its keep.
 *
 * ── The strongest automated action is a reversible hide ──
 *
 * Never a delete, and never a ban. See the Verdict type for why. `hide` sets
 * Comment.hiddenAt, which an admin can clear to get the comment back intact;
 * nothing here may touch `deletedAt`, which is the author's irreversible
 * tombstone and means something else entirely.
 */

import prisma from '../prisma';
import logger from '../logger';
import { completeChat, LlmError } from '../llm/chat';
import { resolveSiteModel, recordUsage } from '../llm/siteModels';
import { htmlToText } from '../llm/htmlText';
import { systemPromptFor, readTrigger } from './tasks';
import { MODERATE_PROMPT_DEFAULT, MODERATE_FORMAT, parseScreening } from './prompts';
import { registerHandler, enqueue, enabledTasks } from './queue';

/** A verdict is one word and a sentence. It does not need room to think aloud. */
const MODERATE_TOKENS = 800;
/** Longer than this and the tail is not what makes a comment abusive. */
const MAX_COMMENT_CHARS = 4_000;

export async function runModerateJob(job: {
  taskId: string;
  subjectId: string;
}): Promise<{ note?: string; verdict?: string; category?: string; confidence?: number }> {
  const task = await prisma.aiTask.findUnique({
    where: { id: job.taskId },
    select: { prompt: true, siteModelId: true, label: true, trigger: true },
  });
  if (!task) return { note: 'task no longer exists' };

  const comment = await prisma.comment.findUnique({
    where: { id: job.subjectId },
    select: { id: true, body: true, deletedAt: true, articleTitle: true, user: { select: { username: true } } },
  });
  // Deleted between posting and screening. Not a failure — the outcome the
  // screen might have asked for has already happened.
  if (!comment || comment.deletedAt) return { note: 'comment is gone' };

  const text = htmlToText(comment.body).slice(0, MAX_COMMENT_CHARS).trim();
  if (!text) return { note: 'comment has no text' };

  const model = await resolveSiteModel(task.siteModelId);
  const started = Date.now();
  let usage;

  let raw: string;
  try {
    raw = await completeChat({
      provider: model.provider,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      model: model.model,
      trusted: model.trusted,
      system: systemPromptFor(task.prompt, MODERATE_PROMPT_DEFAULT) + MODERATE_FORMAT,
      // Fenced and labelled as material, which the safety floor tells the model
      // to treat as inert. A comment is the single most likely place in this app
      // for somebody to try instructing the screen that is reading them.
      turns: [{
        role: 'user',
        content: `<comment author="${comment.user?.username ?? 'someone'}" on="${comment.articleTitle.slice(0, 200)}">\n${text}\n</comment>`,
      }],
      maxTokens: MODERATE_TOKENS,
      effort: 'low',
      onUsage: u => { usage = u; },
    });
    await recordUsage({
      siteModel: model, kind: 'moderate', outcome: 'success', usage,
      durationMs: Date.now() - started, taskId: job.taskId, taskLabel: task.label,
    });
  } catch (err) {
    await recordUsage({
      siteModel: model, kind: 'moderate', outcome: 'failed', usage,
      durationMs: Date.now() - started, taskId: job.taskId, taskLabel: task.label,
      error: err instanceof LlmError ? err.message : String(err),
    });
    throw err;
  }

  const screening = parseScreening(raw);
  // Deliberately a throw, not an "allow". An endpoint returning gibberish must
  // not be indistinguishable in the log from one that approved the comment.
  if (!screening) throw new Error('the model did not return a readable verdict');

  const { enforce } = readTrigger(task.trigger);

  if (enforce && screening.verdict === 'hide') {
    await prisma.comment.update({
      where: { id: comment.id },
      data: {
        hiddenAt: new Date(),
        hiddenReason: `${screening.category || 'flagged'}: ${screening.reason}`.slice(0, 500),
      },
    });
    logger.warn({ commentId: comment.id, category: screening.category }, 'Comment hidden by moderation task');
  }

  return {
    verdict: screening.verdict,
    category: screening.category,
    confidence: screening.confidence,
    note: enforce
      ? screening.reason
      : `[shadow, not enforced] ${screening.reason}`,
  };
}

/**
 * Queue a screening for a comment that was just posted.
 *
 * Called after the response has gone out, never before it: a community where
 * posting a comment blocks on a GPU is one where posting feels broken, and the
 * screen has nothing useful to say in the 200ms a person will wait.
 *
 * Failures here are swallowed. A moderation task that cannot be queued must not
 * turn into a failed comment post — the comment is the user's, the screening is
 * the operator's, and only one of those two people is waiting.
 */
export async function screenNewComment(commentId: string): Promise<void> {
  try {
    const tasks = await enabledTasks('moderate');
    for (const task of tasks) {
      await enqueue({
        taskId: task.id,
        trigger: 'comments',
        articleKey: '',
        articleUrl: '',
        subjectId: commentId,
        // Every comment is its own subject, so the article-level dedupe would
        // be wrong here — it would screen the first comment on a piece and
        // nothing after it.
        force: true,
      });
    }
  } catch (err) {
    logger.error(err, 'Could not queue comment screening');
  }
}

registerHandler('moderate', async job => {
  logger.info({ jobId: job.id, commentId: job.subjectId }, 'Running moderation job');
  return runModerateJob(job);
});
