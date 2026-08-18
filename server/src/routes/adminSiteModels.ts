import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { recordAdminAction, ADMIN_ACTIONS } from '../lib/adminAudit';
import { perUserLimiter } from '../lib/rateLimit';
import { PROVIDERS } from '../lib/llm/providers';
import { completeChat, LlmError, Usage } from '../lib/llm/chat';
import { sealSecret } from '../lib/llm/secretBox';
import { resolveSafeAgent } from '../lib/isSafeUrl';
import { normalizeBase, privateHostPredicate, privateHostAllowlist } from '../lib/llm/operatorEnv';
import {
  toPublicSiteModel, envSiteModelSummary, usageStats, recordUsage,
  resolveSiteModel, USAGE_RETENTION_DAYS,
} from '../lib/llm/siteModels';
import nodeFetch from 'node-fetch';

/**
 * The endpoints the instance generates with, and what they have been doing.
 *
 * Admin-only throughout. Separate from adminPersonas because the two answer
 * different questions — that file is about *who* is writing, this one about
 * *what* answers when they do — and because an operator debugging a slow box
 * should not have to scroll past persona configuration to reach the latency
 * numbers.
 *
 * ── The security shape, restated because it is the whole design ──
 * An admin may name any endpoint here. A **public** one just works. A **private**
 * one works only if its host appears in OPERATOR_LLM_PRIVATE_HOSTS, which lives
 * in the environment and therefore needs shell access to change. So this router
 * can move the instance between models freely, and cannot widen what the server
 * is able to reach. See lib/llm/operatorEnv.ts.
 */

const router = Router();
router.use(requireAuth, requireAdmin);

/** Reaching out to an endpoint costs time and can hang; throttle it per admin. */
const probeLimiter = perUserLimiter({
  windowMs: 10 * 60_000,
  max: 60,
  message: 'Too many endpoint checks — wait a moment.',
});

const MAX_LABEL = 60;
const MAX_URL = 500;
const MAX_MODEL = 200;

function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof LlmError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error(err, context);
  res.status(500).json({ error: 'Server error' });
}

const SELECT = {
  id: true, label: true, baseUrl: true, model: true, keyLast4: true,
  isDefault: true, enabled: true, createdAt: true,
  createdBy: { select: { username: true } },
} as const;

/**
 * Check an address is one this server is willing to call, and say why not.
 *
 * Run at **write** time as well as at call time. The call-time check in
 * resolveTarget is the one that actually protects anything; this one exists so
 * that an admin typing a LAN address learns immediately that its host is not
 * allowlisted, rather than saving a row that looks fine and discovering it at
 * the first generation, possibly days later.
 */
async function checkEndpoint(baseUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { agent, reason } = await resolveSafeAgent(baseUrl, privateHostPredicate());
  if (agent) return { ok: true };

  const allowed = privateHostAllowlist();
  const hint = allowed.length
    ? `Allowed private hosts are: ${allowed.join(', ')}.`
    : 'No private hosts are allowlisted on this server.';
  return {
    ok: false,
    error:
      `That endpoint cannot be used: ${reason}. ` +
      `To use an address inside your network, add its host to OPERATOR_LLM_PRIVATE_HOSTS ` +
      `on the server and restart. ${hint}`,
  };
}

function validate(body: Record<string, unknown>, partial: boolean): string | null {
  const { label, baseUrl, model } = body;
  if (!partial || baseUrl !== undefined) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) return 'A base URL is required';
    if (baseUrl.length > MAX_URL) return `The base URL must be ≤${MAX_URL} characters`;
    try {
      const u = new URL(baseUrl.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The base URL must be http or https';
    } catch {
      return 'That base URL could not be parsed';
    }
  }
  if (!partial || model !== undefined) {
    if (typeof model !== 'string' || !model.trim()) return 'A model name is required';
    if (model.length > MAX_MODEL) return `The model name must be ≤${MAX_MODEL} characters`;
  }
  if (label !== undefined && (typeof label !== 'string' || label.length > MAX_LABEL)) {
    return `The label must be a string of ≤${MAX_LABEL} characters`;
  }
  return null;
}

/** The three sealed columns for a key, or the cleared trio for an empty one. */
function keyColumns(apiKey: string) {
  if (!apiKey) return { keyCipher: '', keyIv: '', keyTag: '', keyLast4: '' };
  const sealed = sealSecret(apiKey);
  return { ...sealed, keyLast4: apiKey.slice(-4) };
}

// ── Read ─────────────────────────────────────────────────────────────────────

router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.siteModel.findMany({ select: SELECT, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    res.json({
      models: rows.map(toPublicSiteModel),
      // The legacy environment endpoint, shown read-only so an admin can see
      // what personas run on before any row exists to supersede it.
      env: envSiteModelSummary(),
      privateHosts: privateHostAllowlist(),
      retentionDays: USAGE_RETENTION_DAYS,
    });
  } catch (err) {
    fail(res, err, 'List site models error');
  }
});

// ── Write ────────────────────────────────────────────────────────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const problem = validate(body, false);
  if (problem) { res.status(400).json({ error: problem }); return; }

  const baseUrl = normalizeBase(body.baseUrl as string);
  const check = await checkEndpoint(baseUrl);
  if (!check.ok) { res.status(400).json({ error: check.error }); return; }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // The first endpoint added becomes the default whatever the request says:
  // an instance whose only endpoint is not the default would generate nothing,
  // and nobody means to configure that.
  const existing = await prisma.siteModel.count();
  const wantDefault = existing === 0 || body.isDefault === true;

  try {
    const created = await prisma.$transaction(async tx => {
      if (wantDefault) await tx.siteModel.updateMany({ data: { isDefault: false } });
      const row = await tx.siteModel.create({
        data: {
          label: ((body.label as string) ?? '').trim().slice(0, MAX_LABEL),
          baseUrl,
          model: (body.model as string).trim().slice(0, MAX_MODEL),
          ...keyColumns(apiKey),
          isDefault: wantDefault,
          enabled: body.enabled !== false,
          createdById: req.userId!,
        },
        select: SELECT,
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.siteModelCreate,
        targetType: 'siteModel',
        targetId: row.id,
        targetLabel: row.label || row.baseUrl,
        metadata: { model: row.model, baseUrl: row.baseUrl },
      });
      return row;
    });
    res.status(201).json(toPublicSiteModel(created));
  } catch (err) {
    fail(res, err, 'Create site model error');
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const problem = validate(body, true);
  if (problem) { res.status(400).json({ error: problem }); return; }

  try {
    const existing = await prisma.siteModel.findUnique({
      where: { id: req.params.id },
      select: { id: true, label: true, baseUrl: true },
    });
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

    const data: Record<string, unknown> = {};
    if (typeof body.label === 'string') data.label = body.label.trim().slice(0, MAX_LABEL);
    if (typeof body.model === 'string') data.model = body.model.trim().slice(0, MAX_MODEL);
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;

    if (typeof body.baseUrl === 'string') {
      const baseUrl = normalizeBase(body.baseUrl);
      const check = await checkEndpoint(baseUrl);
      if (!check.ok) { res.status(400).json({ error: check.error }); return; }
      data.baseUrl = baseUrl;
    }

    // A key is only ever replaced or cleared, never read back. An omitted field
    // leaves the stored key alone; an empty string is an explicit "remove it",
    // which is the only way to move a formerly authenticated endpoint to a local
    // box that has no auth.
    if (typeof body.apiKey === 'string') Object.assign(data, keyColumns(body.apiKey.trim()));

    const updated = await prisma.$transaction(async tx => {
      if (body.isDefault === true) {
        await tx.siteModel.updateMany({ data: { isDefault: false } });
        data.isDefault = true;
      }
      const row = await tx.siteModel.update({
        where: { id: req.params.id }, data, select: SELECT,
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.siteModelUpdate,
        targetType: 'siteModel',
        targetId: row.id,
        targetLabel: row.label || row.baseUrl,
      });
      return row;
    });
    res.json(toPublicSiteModel(updated));
  } catch (err) {
    fail(res, err, 'Update site model error');
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await prisma.siteModel.findUnique({
      where: { id: req.params.id },
      select: { id: true, label: true, baseUrl: true, isDefault: true, _count: { select: { personas: true } } },
    });
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }

    await prisma.$transaction(async tx => {
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.siteModelDelete,
        targetType: 'siteModel',
        targetId: row.id,
        targetLabel: row.label || row.baseUrl,
        metadata: { personasAffected: row._count.personas },
      });
      // Personas on it fall back to the default (SET NULL), and its usage rows
      // survive with their denormalised label — see the schema.
      await tx.siteModel.delete({ where: { id: row.id } });

      // Losing the default leaves nothing marked, and resolveSiteModel would
      // then pick the oldest enabled row by accident rather than by choice.
      // Promote deliberately so the panel and the resolver agree.
      if (row.isDefault) {
        const next = await tx.siteModel.findFirst({
          where: { enabled: true }, orderBy: { createdAt: 'asc' }, select: { id: true },
        });
        if (next) await tx.siteModel.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });

    res.json({ ok: true, personasAffected: row._count.personas });
  } catch (err) {
    fail(res, err, 'Delete site model error');
  }
});

// ── Probing a box ────────────────────────────────────────────────────────────

/**
 * Ask an endpoint what models it serves.
 *
 * Takes a base URL in the body rather than an id, so the picker can list models
 * for an endpoint the admin is still typing and has not saved. That means the
 * URL is caller-supplied and must go through the same check as a stored one —
 * `privateHostPredicate` and nothing wider.
 */
router.post('/models', probeLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { baseUrl, apiKey } = req.body as Record<string, unknown>;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    res.status(400).json({ error: 'A base URL is required' }); return;
  }

  const base = normalizeBase(baseUrl);
  const check = await checkEndpoint(base);
  if (!check.ok) { res.status(400).json({ error: check.error }); return; }

  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const { agent } = await resolveSafeAgent(url, privateHostPredicate());
  if (!agent) { res.status(400).json({ error: 'That endpoint could not be reached.' }); return; }

  try {
    const headers: Record<string, string> = {};
    if (typeof apiKey === 'string' && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
    const upstream = await nodeFetch(url, { agent, headers, timeout: 10_000 } as Parameters<typeof nodeFetch>[1]);
    if (!upstream.ok) {
      res.status(502).json({ error: `The endpoint answered ${upstream.status} when asked for its models.` });
      return;
    }
    const body = await upstream.json() as { data?: { id?: unknown }[] };
    const models = (body.data ?? [])
      .map(m => (typeof m.id === 'string' ? m.id : ''))
      .filter(Boolean)
      .sort();
    res.json({ models });
  } catch {
    // No upstream detail on the wire — the same rule streamChat follows.
    res.status(502).json({ error: 'Could not read the model list from that endpoint.' });
  }
});

/**
 * Send one tiny prompt and report what came back.
 *
 * The only way to learn the thing an admin actually wants to know before
 * committing a persona to a box: does it answer, and how long does it take when
 * the model is cold? Logged to the usage table like any other call, tagged
 * `test`, so a box that fails only under real load still shows up in the history.
 */
router.post('/:id/test', probeLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const row = await prisma.siteModel.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }

    const model = await resolveSiteModel(req.params.id);
    const started = Date.now();
    // Captured like any other generation, so a test contributes to the same
    // tokens-per-second figure the Usage panel reports rather than showing up as
    // a call that mysteriously produced nothing.
    let usage: Usage | undefined;
    try {
      const text = await completeChat({
        provider: PROVIDERS.compatible,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        model: model.model,
        system: 'Reply with exactly the word: ready',
        turns: [{ role: 'user', content: 'Are you there?' }],
        maxTokens: 16,
        trusted: model.trusted,
        onUsage: u => { usage = u; },
      });
      const durationMs = Date.now() - started;
      await recordUsage({ siteModel: model, kind: 'test', outcome: 'success', durationMs, usage });
      res.json({ ok: true, durationMs, reply: text.trim().slice(0, 200) });
    } catch (err) {
      const durationMs = Date.now() - started;
      await recordUsage({
        siteModel: model, kind: 'test', outcome: 'failed', durationMs, usage,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  } catch (err) {
    fail(res, err, 'Test site model error');
  }
});

// ── Usage ────────────────────────────────────────────────────────────────────

router.get('/usage', async (req: AuthRequest, res: Response): Promise<void> => {
  const raw = Number(req.query.days);
  // Clamped rather than rejected: the window is a view control, and an out-of-
  // range value should show something sensible rather than an error.
  const days = Number.isFinite(raw) ? Math.min(USAGE_RETENTION_DAYS, Math.max(1, Math.floor(raw))) : 7;
  try {
    res.json(await usageStats(days));
  } catch (err) {
    fail(res, err, 'Site model usage error');
  }
});

export default router;
