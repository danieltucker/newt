import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { recordAdminAction, ADMIN_ACTIONS } from '../lib/adminAudit';
import { perUserLimiter } from '../lib/rateLimit';
import { isHttpUrl, canonicalArticleKey } from '../lib/comments';
import { siteModelConfigured } from '../lib/llm/siteModels';
import {
  TASK_KINDS, isTaskKind, MAX_PROMPT, MAX_LABEL, AUTO_PUBLISH,
  readTrigger, writeTrigger, defaultTrigger, publishesImmediately,
} from '../lib/ai/tasks';
import { EXPLORE_PROMPT_DEFAULT, MODERATE_PROMPT_DEFAULT } from '../lib/ai/prompts';
import { enqueue, queueStats } from '../lib/ai/queue';
import { runScheduledPass } from '../lib/ai/triggers';
import { listModels, pullModel, deleteModel, currentPull } from '../lib/ai/ollama';

/**
 * Admin → AI. The tasks the instance runs, the queue behind them, and the
 * models on the operator's own box.
 *
 * This replaced adminPersonas.ts. The route surface shrank a lot in the swap:
 * that file had four generate verbs, an identity generator and a username
 * uniqueness loop, all of which existed to maintain the illusion of an account.
 * What is left is configuration, a queue, and one button.
 */

const router = Router();
router.use(requireAuth, requireAdmin);

/** Reaching a box costs time and can hang. Throttled per admin, as the probes are. */
const probeLimiter = perUserLimiter({
  windowMs: 10 * 60_000,
  max: 60,
  message: 'Too many model-box requests — wait a moment.',
});

const DEFAULT_PROMPTS: Record<string, string> = {
  explore: EXPLORE_PROMPT_DEFAULT,
  moderate: MODERATE_PROMPT_DEFAULT,
};

/**
 * The prompt to store, given what was submitted.
 *
 * An empty box means "use the default", and the default is **written into the
 * row** rather than left to be substituted at generation time. Two reasons, and
 * the second is the one that matters:
 *
 *  - What the admin sees is what runs. A task whose prompt field is blank is
 *    one whose actual instructions live in a source file they cannot read, and
 *    the first thing anybody wants to do with a prompt is edit it.
 *  - **A stored default cannot change underneath them.** If the row held an
 *    empty string, shipping a better default in some later release would
 *    silently rewrite the instructions of every task already running — which is
 *    a change to what the instance says, made by an upgrade, that nobody chose.
 *
 * Clearing the box and saving therefore means "reset to today's default", which
 * is a useful verb and the only sensible reading of an empty submission.
 *
 * systemPromptFor's own fallback stays as a floor beneath this: a row that ends
 * up blank by some other route still generates rather than sending an empty
 * system prompt.
 */
function promptToStore(submitted: unknown, kind: string): string {
  const written = typeof submitted === 'string' ? submitted.trim().slice(0, MAX_PROMPT) : '';
  return written || DEFAULT_PROMPTS[kind] || '';
}

function fail(res: Response, err: unknown, msg: string): void {
  logger.error(err, msg);
  res.status(500).json({ error: 'Server error' });
}

const TASK_SELECT = {
  id: true, kind: true, label: true, prompt: true, siteModelId: true,
  trigger: true, enabled: true, createdAt: true,
  siteModel: { select: { label: true, model: true } },
} as const;

type TaskRow = {
  id: string; kind: string; label: string; prompt: string; siteModelId: string | null;
  trigger: unknown; enabled: boolean; createdAt: Date;
  siteModel: { label: string; model: string } | null;
};

function toJson(row: TaskRow) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    prompt: row.prompt,
    siteModelId: row.siteModelId,
    siteModel: row.siteModel ? { label: row.siteModel.label, model: row.siteModel.model } : null,
    // Normalised on the way out as well as in, so the panel renders the clamped
    // thresholds rather than whatever is literally stored. A form showing 1 for
    // a field whose floor is 3 invites an admin to "fix" a value that is
    // already being read as 3.
    trigger: readTrigger(row.trigger),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What the panel needs to draw itself before anything is configured. */
router.get('/options', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      kinds: TASK_KINDS,
      defaultPrompts: DEFAULT_PROMPTS,
      defaultTrigger: defaultTrigger(),
      autoPublishOptions: AUTO_PUBLISH,
      configured: await siteModelConfigured(),
      limits: { prompt: MAX_PROMPT, label: MAX_LABEL },
    });
  } catch (err) {
    fail(res, err, 'AI options error');
  }
});

router.get('/tasks', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.aiTask.findMany({
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      select: TASK_SELECT,
    });
    res.json({ tasks: rows.map(toJson) });
  } catch (err) {
    fail(res, err, 'List AI tasks error');
  }
});

router.post('/tasks', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (!isTaskKind(body.kind)) {
    res.status(400).json({ error: 'kind must be explore or moderate' });
    return;
  }
  try {
    const row = await prisma.$transaction(async tx => {
      const created = await tx.aiTask.create({
        data: {
          kind: body.kind as string,
          label: typeof body.label === 'string' ? body.label.trim().slice(0, MAX_LABEL) : '',
          prompt: promptToStore(body.prompt, body.kind as string),
          siteModelId: typeof body.siteModelId === 'string' && body.siteModelId ? body.siteModelId : null,
          trigger: writeTrigger(body.trigger) as object,
          enabled: body.enabled !== false,
          createdById: req.userId!,
        },
        select: TASK_SELECT,
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.aiTaskCreate,
        targetType: 'aiTask',
        targetId: created.id,
        targetLabel: created.label || created.kind,
        metadata: { kind: created.kind },
      });
      return created;
    });
    res.status(201).json(toJson(row));
  } catch (err) {
    fail(res, err, 'Create AI task error');
  }
});

router.patch('/tasks/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  try {
    const existing = await prisma.aiTask.findUnique({
      where: { id: req.params.id },
      select: { id: true, label: true, kind: true, prompt: true, trigger: true },
    });
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

    const row = await prisma.$transaction(async tx => {
      const updated = await tx.aiTask.update({
        where: { id: req.params.id },
        data: {
          ...(typeof body.label === 'string' ? { label: body.label.trim().slice(0, MAX_LABEL) } : {}),
          // Only when the field was sent at all: a PATCH that omits it — the
          // Pause and Resume buttons — must not rewrite the prompt.
          ...(typeof body.prompt === 'string' ? { prompt: promptToStore(body.prompt, existing.kind) } : {}),
          ...('siteModelId' in body
            ? { siteModelId: typeof body.siteModelId === 'string' && body.siteModelId ? body.siteModelId : null }
            : {}),
          ...('trigger' in body ? { trigger: writeTrigger(body.trigger) as object } : {}),
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        },
        select: TASK_SELECT,
      });

      // The metadata names what changed rather than the whole row. Two fields
      // matter enough to call out by name: the prompt, because it is the thing
      // that decides what the instance says, and `enforce`, because it is the
      // switch between scoring comments and hiding them.
      const before = readTrigger(existing.trigger);
      const after = readTrigger(updated.trigger);
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.aiTaskUpdate,
        targetType: 'aiTask',
        targetId: updated.id,
        targetLabel: updated.label || updated.kind,
        metadata: {
          promptChanged: typeof body.prompt === 'string' && body.prompt.trim() !== existing.prompt,
          enforceChanged: before.enforce !== after.enforce,
          enforce: after.enforce,
          autoPublishChanged: before.autoPublish !== after.autoPublish,
          autoPublish: after.autoPublish,
        },
      });
      return updated;
    });
    res.json(toJson(row));
  } catch (err) {
    fail(res, err, 'Update AI task error');
  }
});

router.delete('/tasks/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await prisma.aiTask.findUnique({
      where: { id: req.params.id },
      select: { id: true, label: true, kind: true, _count: { select: { jobs: true } } },
    });
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }

    await prisma.$transaction(async tx => {
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.aiTaskDelete,
        targetType: 'aiTask',
        targetId: row.id,
        targetLabel: row.label || row.kind,
        metadata: { jobs: row._count.jobs },
      });
      // Jobs cascade. The generated *threads* do not — AiJob.threadId is a plain
      // string, so deleting the task that produced a published explore leaves
      // the explore standing, which is the right way round: a reader following a
      // link should not lose the page because an admin tidied up a config row.
      await tx.aiTask.delete({ where: { id: row.id } });
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Delete AI task error');
  }
});

// ── Running things ──────────────────────────────────────────────────────────

/**
 * The admin button on an article: explore this now.
 *
 * `force` skips the already-handled dedupe, because a human pressing the button
 * a second time has said something the dedupe cannot know — that the first
 * result was not good enough.
 */
router.post('/tasks/:id/run', async (req: AuthRequest, res: Response): Promise<void> => {
  const { url } = req.body as Record<string, unknown>;
  if (!isHttpUrl(url)) { res.status(400).json({ error: 'url must be an http(s) URL' }); return; }

  try {
    const task = await prisma.aiTask.findUnique({
      where: { id: req.params.id },
      select: { id: true, kind: true, enabled: true, label: true, trigger: true },
    });
    if (!task) { res.status(404).json({ error: 'Not found' }); return; }
    if (task.kind !== 'explore') { res.status(400).json({ error: 'Only an explore task can be run on an article.' }); return; }
    if (!task.enabled) { res.status(409).json({ error: 'That task is switched off.' }); return; }
    if (!(await siteModelConfigured())) {
      res.status(400).json({ error: 'No site model is configured. Add one in Admin → AI → Models.' });
      return;
    }

    const result = await enqueue({
      taskId: task.id,
      trigger: 'admin',
      articleKey: canonicalArticleKey(url as string),
      articleUrl: url as string,
      force: true,
    });
    // Whether the finished thread will publish itself is decided by config the
    // person pressing the button cannot see, so it travels back with the
    // acknowledgement rather than being a surprise on the article page.
    res.status(202).json({
      ...result,
      willPublish: publishesImmediately(readTrigger(task.trigger), 'admin'),
    });
  } catch (err) {
    fail(res, err, 'Run AI task error');
  }
});

/** Fire the nightly pass by hand, so an admin can see what it would pick up. */
router.post('/scheduled-pass', probeLimiter, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json(await runScheduledPass());
  } catch (err) {
    fail(res, err, 'Scheduled pass error');
  }
});

// ── The queue ───────────────────────────────────────────────────────────────

router.get('/jobs', async (req: AuthRequest, res: Response): Promise<void> => {
  const { status, kind } = req.query as Record<string, string | undefined>;
  try {
    const rows = await prisma.aiJob.findMany({
      where: {
        ...(status && status !== 'all' ? { status } : {}),
        ...(kind ? { task: { kind } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, status: true, trigger: true, articleUrl: true, subjectId: true,
        threadId: true, note: true, verdict: true, category: true, confidence: true,
        attempts: true, createdAt: true, finishedAt: true,
        task: { select: { id: true, kind: true, label: true } },
      },
    });
    res.json({
      jobs: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null })),
      stats: await queueStats(),
    });
  } catch (err) {
    fail(res, err, 'List AI jobs error');
  }
});

/**
 * Publish a generated explore.
 *
 * The human decision in the loop, and the reason a generated thread is created
 * private. Sets `sharedAt` the way the owner's own share does, because the
 * explored-paths list orders on it — a thread published today should not appear
 * at the position of the day it was generated.
 */
router.post('/threads/:id/publish', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const thread = await prisma.researchThread.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, origin: true, visibility: true, sourceUrl: true },
    });
    if (!thread) { res.status(404).json({ error: 'Not found' }); return; }
    // Only generated threads. A person's private explore is not an admin's to
    // publish, and this route running on one would be the single worst bug in
    // the feature — see the ExploreShareModal note on what a transcript holds.
    if (thread.origin !== 'auto') {
      res.status(403).json({ error: 'That thread belongs to a person. Only its author can share it.' });
      return;
    }

    await prisma.$transaction(async tx => {
      await tx.researchThread.update({
        where: { id: thread.id },
        data: { visibility: 'public', sharedAt: new Date() },
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.aiPublish,
        targetType: 'aiTask',
        targetId: thread.id,
        targetLabel: thread.title,
        metadata: { url: thread.sourceUrl.slice(0, 500) },
      });
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Publish generated explore error');
  }
});

/** Discard a generated explore outright. Only ever a generated one. */
router.delete('/threads/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const thread = await prisma.researchThread.findUnique({
      where: { id: req.params.id },
      select: { id: true, origin: true },
    });
    if (!thread) { res.status(404).json({ error: 'Not found' }); return; }
    if (thread.origin !== 'auto') {
      res.status(403).json({ error: 'That thread belongs to a person.' });
      return;
    }
    await prisma.researchThread.delete({ where: { id: thread.id } });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Delete generated explore error');
  }
});

// ── The operator's own model box ────────────────────────────────────────────

/**
 * What this endpoint has downloaded, and what is in VRAM right now.
 *
 * A null `models` is the ordinary answer for anything that is not Ollama, not
 * an error — see listModels. The panel hides itself on it rather than showing a
 * failure for a Groq endpoint that is working perfectly.
 */
router.get('/models/:siteModelId', probeLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await prisma.siteModel.findUnique({
      where: { id: req.params.siteModelId },
      select: { baseUrl: true },
    });
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }

    res.json({
      models: await listModels(row.baseUrl),
      pulling: currentPull(),
    });
  } catch (err) {
    fail(res, err, 'List local models error');
  }
});

/** Progress of the running pull, if any. Polled by the panel while one runs. */
router.get('/models/pull/status', async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ pulling: currentPull() });
});

/**
 * Start a pull.
 *
 * Answers 202 and lets it run: a multi-gigabyte download cannot be an HTTP
 * round trip, and the panel polls `pull/status` for progress. Audited before
 * the download starts rather than after it finishes, so a pull that is still
 * running — or that took the box down — is still attributable.
 */
router.post('/models/:siteModelId/pull', probeLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { model } = req.body as Record<string, unknown>;
  if (typeof model !== 'string' || !model.trim()) {
    res.status(400).json({ error: 'A model name is required' });
    return;
  }
  const name = model.trim().slice(0, 200);

  try {
    const row = await prisma.siteModel.findUnique({
      where: { id: req.params.siteModelId },
      select: { id: true, baseUrl: true, label: true },
    });
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    if (currentPull()) {
      res.status(409).json({ error: `A pull of ${currentPull()?.model} is already running.` });
      return;
    }

    await prisma.$transaction(async tx => {
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.modelPull,
        targetType: 'siteModel',
        targetId: row.id,
        targetLabel: row.label || row.baseUrl,
        metadata: { model: name },
      });
    });

    // Deliberately not awaited. The response goes now; the download runs on.
    void pullModel(row.baseUrl, name, () => { /* progress is read via currentPull */ })
      .then(result => {
        if (result.ok) logger.info({ model: name }, 'Model pull finished');
        else logger.error({ model: name, error: result.error }, 'Model pull failed');
      });

    res.status(202).json({ started: true, model: name });
  } catch (err) {
    fail(res, err, 'Pull model error');
  }
});

router.delete('/models/:siteModelId/:model', probeLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await prisma.siteModel.findUnique({
      where: { id: req.params.siteModelId },
      select: { id: true, baseUrl: true, label: true },
    });
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }

    const name = decodeURIComponent(req.params.model);
    const result = await deleteModel(row.baseUrl, name);
    if (!result.ok) { res.status(502).json({ error: result.error }); return; }

    await prisma.$transaction(async tx => {
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.modelDelete,
        targetType: 'siteModel',
        targetId: row.id,
        targetLabel: row.label || row.baseUrl,
        metadata: { model: name },
      });
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Delete local model error');
  }
});

export default router;
