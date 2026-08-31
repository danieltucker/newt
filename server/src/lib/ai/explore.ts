/**
 * Generating an explore about an article.
 *
 * The output is a `ResearchThread` with `origin: 'auto'` and no owner, which is
 * what puts it in the article's Explored paths section rather than in a comment
 * thread. That section already existed, is already indexed by `sourceKey`, and
 * already carries the visibility vocabulary this needs — so the whole feature
 * is a row in a table that was built for it, which is most of the argument for
 * doing it this way instead of as a comment.
 *
 * **Whether it goes public without review depends on what asked for it.** A
 * thread is a page with a URL, an entry in the article's public section and a
 * search footprint, so it is a different size of mistake from a comment — but
 * an admin pressing "Explore this" has already made the judgement the review
 * step collects, and asking them to approve their own request afterwards is a
 * second signature on one decision. So the default publishes button-triggered
 * threads immediately and holds the unattended ones. See TriggerConfig.autoPublish
 * and publishesImmediately, which is the only place that policy is read.
 */

import prisma from '../prisma';
import logger from '../logger';
import { completeChat, LlmError } from '../llm/chat';
import { resolveSiteModel, recordUsage } from '../llm/siteModels';
import { publicArticleContext, renderContext } from '../llm/articleContext';
import { systemPromptFor, readTrigger, publishesImmediately } from './tasks';
import { EXPLORE_PROMPT_DEFAULT, EXPLORE_TITLE_PROMPT, cleanTitle } from './prompts';
import { registerHandler } from './queue';
import { canonicalArticleKey } from '../comments';

/**
 * Budget for one generated thread.
 *
 * Roomier than the old IDEAS ceiling because this one is prose rather than a
 * bounded list, and the ceiling covers thinking as well as answer on a
 * reasoning model — the trap that made Ideas fail on local models. Still small
 * enough that a runaway generation cannot occupy the GPU for ten minutes.
 */
const EXPLORE_TOKENS = 4_000;
/** A title is six words. Anything more is the model explaining itself. */
const TITLE_TOKENS = 100;

/**
 * Too thin to be worth a generation.
 *
 * Below this there is a headline and a sentence, and what comes back is the
 * model's prior knowledge of the topic dressed as a reading of the piece. An
 * empty Explored-paths section is better than one full of that.
 */
const MIN_TEXT_CHARS = 400;

export async function runExploreJob(job: {
  taskId: string;
  articleUrl: string;
  trigger: string;
}): Promise<{ threadId?: string; note?: string }> {
  const task = await prisma.aiTask.findUnique({
    where: { id: job.taskId },
    select: { prompt: true, siteModelId: true, label: true, trigger: true },
  });
  if (!task) return { note: 'task no longer exists' };

  // The no-viewer path, and the reason auto-explore is safe to publish. See
  // publicArticleContext: there is no argument here that could widen it to a
  // reader's private notes, because there is no reader.
  const ctx = await publicArticleContext(job.articleUrl);
  if (!ctx) return { note: 'no public record of that article' };
  if (ctx.text.length < MIN_TEXT_CHARS) {
    return { note: `article text too thin (${ctx.text.length} chars)` };
  }

  const model = await resolveSiteModel(task.siteModelId);
  const material = renderContext(ctx);

  const body = await generate({
    model,
    taskId: job.taskId,
    taskLabel: task.label,
    system: systemPromptFor(task.prompt, EXPLORE_PROMPT_DEFAULT),
    user: material,
    maxTokens: EXPLORE_TOKENS,
  });
  if (!body.trim()) return { note: 'the model returned nothing' };

  // Second call, and cheap. Worth it because the title is what the article page
  // shows in the Explored paths list — the thread's whole presence there is one
  // line of text, and "Exploring an article" in that line is indistinguishable
  // from a bug.
  const rawTitle = await generate({
    model,
    taskId: job.taskId,
    taskLabel: task.label,
    system: EXPLORE_TITLE_PROMPT,
    user: material,
    maxTokens: TITLE_TOKENS,
  }).catch(() => '');

  // Whether this one goes straight out. Decided from the task config *and*
  // the trigger that produced the job: a thread somebody asked for by pressing
  // a button has already had its human moment, while one the nightly pass
  // chose has not. See publishesImmediately.
  const publish = publishesImmediately(readTrigger(task.trigger), job.trigger);

  const thread = await prisma.researchThread.create({
    data: {
      userId: null,
      origin: 'auto',
      siteModelId: model.id,
      title: cleanTitle(rawTitle, ctx.title),
      sourceUrl: ctx.url,
      sourceTitle: ctx.title,
      sourceKey: canonicalArticleKey(ctx.url),
      // The Explored paths query filters on visibility, so 'private' is the
      // review queue and needs no separate flag. sharedAt is what that list
      // orders on, so it is set together with the visibility or a published
      // thread sorts to the epoch.
      visibility: publish ? 'public' : 'private',
      ...(publish ? { sharedAt: new Date() } : {}),
      messages: {
        create: [
          // The opening turn is stored as the assistant's, with no user turn
          // before it. Nobody asked a question here, and inventing one — "Tell
          // me about this article" — would put words in a reader's mouth in a
          // transcript that is going to be published.
          { role: 'assistant', body, sources: [] },
        ],
      },
    },
    select: { id: true },
  });

  return {
    threadId: thread.id,
    note: publish
      ? `published · generated from ${ctx.source}`
      : `awaiting review · generated from ${ctx.source}`,
  };
}

/** One call, logged to the usage table whichever way it goes. */
async function generate(input: {
  model: Awaited<ReturnType<typeof resolveSiteModel>>;
  taskId: string;
  taskLabel: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const started = Date.now();
  let usage;
  try {
    const text = await completeChat({
      provider: input.model.provider,
      apiKey: input.model.apiKey,
      baseUrl: input.model.baseUrl,
      model: input.model.model,
      trusted: input.model.trusted,
      system: input.system,
      turns: [{ role: 'user', content: input.user }],
      maxTokens: input.maxTokens,
      effort: 'medium',
      onUsage: u => { usage = u; },
    });
    await recordUsage({
      siteModel: input.model, kind: 'explore', outcome: 'success', usage,
      durationMs: Date.now() - started, taskId: input.taskId, taskLabel: input.taskLabel,
    });
    return text;
  } catch (err) {
    await recordUsage({
      siteModel: input.model, kind: 'explore', outcome: 'failed', usage,
      durationMs: Date.now() - started, taskId: input.taskId, taskLabel: input.taskLabel,
      error: err instanceof LlmError ? err.message : String(err),
    });
    throw err;
  }
}

registerHandler('explore', async job => {
  logger.info({ jobId: job.id, url: job.articleUrl }, 'Running explore job');
  return runExploreJob(job);
});
