import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';
import { PROVIDERS, publicProviders, isProviderId, utilityModelFor } from '../lib/llm/providers';
import { sealSecret, last4 } from '../lib/llm/secretBox';
import { resolveCredential, toPublicCredential } from '../lib/llm/credentials';
import { completeChat, listRemoteModels, LlmError } from '../lib/llm/chat';
import { PROOFREAD_SYSTEM, parseProofread } from '../lib/llm/prompts';
import { PROOFREAD } from '../lib/llm/depth';
import { htmlToText } from '../lib/llm/htmlText';

const router = Router();
router.use(requireAuth);

// One person can only have so many models connected before the list stops being
// a list. Also bounds what a compromised account can stash in the table.
const MAX_CREDENTIALS = 8;
const MAX_KEY_LENGTH = 500;
const MAX_LABEL = 60;
const MAX_MODEL_ID = 120;

// Every call here spends the user's money, so the limit is about their bill as
// much as our load. Generous enough that a real research session never notices.
const askLimiter = perUserLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'That’s a lot of questions at once — give it a minute.',
});

// ── Providers ───────────────────────────────────────────────────────────────

router.get('/providers', (_req: AuthRequest, res: Response): void => {
  res.json({ providers: publicProviders() });
});

// ── Credentials ─────────────────────────────────────────────────────────────

router.get('/credentials', async (req: AuthRequest, res: Response): Promise<void> => {
  const rows = await prisma.llmCredential.findMany({
    where: { userId: req.userId! },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  res.json({ credentials: rows.map(toPublicCredential) });
});

interface CredentialInput {
  provider: unknown;
  label: unknown;
  apiKey: unknown;
  baseUrl: unknown;
  model: unknown;
  isDefault: unknown;
}

/**
 * Shared validation for create and update.
 *
 * `baseUrl` is checked for shape only. Whether it is *reachable* and whether it
 * resolves to a public address is settled at call time by chat.ts — a check
 * here would be a second implementation of the same rule that could drift from
 * the one that matters, and DNS can change between saving a key and using it.
 */
function validateCredential(body: Partial<CredentialInput>, provider: typeof PROVIDERS[keyof typeof PROVIDERS]): string | null {
  const { label, apiKey, baseUrl, model } = body;

  if (label !== undefined && (typeof label !== 'string' || label.length > MAX_LABEL)) {
    return `Label must be ${MAX_LABEL} characters or fewer`;
  }
  if (apiKey !== undefined && apiKey !== null) {
    if (typeof apiKey !== 'string' || apiKey.length > MAX_KEY_LENGTH) return 'That doesn’t look like an API key';
    if (provider.needsKey && !apiKey.trim()) return `${provider.label} needs an API key`;
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > MAX_MODEL_ID)) {
    return 'Choose a model';
  }
  if (provider.needsBaseUrl) {
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== 'string' || !baseUrl.trim()) return 'This provider needs a base URL';
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { return 'That base URL isn’t a valid URL'; }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return 'The base URL must be http:// or https://';
      }
    }
  } else if (typeof baseUrl === 'string' && baseUrl.trim()) {
    return `${provider.label} has a fixed endpoint — leave the base URL empty`;
  }
  return null;
}

router.post('/credentials', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body as Partial<CredentialInput>;
  if (!isProviderId(body.provider)) { res.status(400).json({ error: 'Unknown provider' }); return; }
  const provider = PROVIDERS[body.provider];

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : provider.defaultModel;

  const problem = validateCredential({ ...body, model }, provider);
  if (problem) { res.status(400).json({ error: problem }); return; }

  const count = await prisma.llmCredential.count({ where: { userId: req.userId! } });
  if (count >= MAX_CREDENTIALS) {
    res.status(400).json({ error: `You can connect up to ${MAX_CREDENTIALS} models. Remove one first.` });
    return;
  }

  const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const sealed = key ? sealSecret(key) : { cipher: '', iv: '', tag: '' };
  // The first key connected becomes the default whatever the request said —
  // otherwise a user could add one key, not tick the box, and find every AI
  // feature still saying nothing is connected.
  const isDefault = body.isDefault === true || count === 0;

  try {
    const created = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.llmCredential.updateMany({ where: { userId: req.userId! }, data: { isDefault: false } });
      }
      return tx.llmCredential.create({
        data: {
          userId: req.userId!,
          provider: provider.id,
          label: typeof body.label === 'string' ? body.label.trim() : '',
          keyCipher: sealed.cipher,
          keyIv: sealed.iv,
          keyTag: sealed.tag,
          keyLast4: last4(key),
          baseUrl: provider.needsBaseUrl && typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '',
          model,
          isDefault,
        },
      });
    });
    res.status(201).json(toPublicCredential(created));
  } catch (err) {
    logger.error(err, 'Create LLM credential error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/credentials/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.llmCredential.findFirst({
    where: { id: req.params.id, userId: req.userId! },
  });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  if (!isProviderId(existing.provider)) { res.status(400).json({ error: 'Unsupported provider' }); return; }

  const provider = PROVIDERS[existing.provider];
  const body = req.body as Partial<CredentialInput>;
  const problem = validateCredential(body, provider);
  if (problem) { res.status(400).json({ error: problem }); return; }

  const data: Record<string, unknown> = {};
  if (typeof body.label === 'string') data.label = body.label.trim();
  if (typeof body.model === 'string' && body.model.trim()) data.model = body.model.trim();
  if (provider.needsBaseUrl && typeof body.baseUrl === 'string') data.baseUrl = body.baseUrl.trim();

  // A key is only replaced when a new one is actually sent. An empty string is
  // a real instruction for a keyless endpoint (clear it), but for a provider
  // that needs one it was rejected by the validator above.
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim();
    const sealed = key ? sealSecret(key) : { cipher: '', iv: '', tag: '' };
    data.keyCipher = sealed.cipher;
    data.keyIv = sealed.iv;
    data.keyTag = sealed.tag;
    data.keyLast4 = last4(key);
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (body.isDefault === true) {
        await tx.llmCredential.updateMany({ where: { userId: req.userId! }, data: { isDefault: false } });
        data.isDefault = true;
      }
      return tx.llmCredential.update({ where: { id: existing.id }, data });
    });
    res.json(toPublicCredential(updated));
  } catch (err) {
    logger.error(err, 'Update LLM credential error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/credentials/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.llmCredential.findFirst({
    where: { id: req.params.id, userId: req.userId! },
    select: { id: true, isDefault: true },
  });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.llmCredential.delete({ where: { id: existing.id } });
      // Removing the default promotes the oldest survivor rather than leaving
      // the account with keys but nothing selected, which reads as "AI is off"
      // and is a confusing state to land in by deleting something else.
      if (existing.isDefault) {
        const next = await tx.llmCredential.findFirst({
          where: { userId: req.userId! },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (next) await tx.llmCredential.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Delete LLM credential error');
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Prove a key works, from the settings screen, before the user finds out during
 * a research session that it doesn't. Deliberately the smallest possible call.
 */
router.post('/credentials/:id/test', askLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cred = await resolveCredential(req.userId!, req.params.id);
    const reply = await completeChat({
      provider: cred.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model: cred.model,
      system: 'Reply with the single word: ready',
      turns: [{ role: 'user', content: 'Are you there?' }],
      maxTokens: 16,
    });
    res.json({ ok: true, reply: reply.trim().slice(0, 100) });
  } catch (err) {
    if (err instanceof LlmError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error(err, 'LLM credential test error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Model discovery ─────────────────────────────────────────────────────────

/**
 * Ask an OpenAI-compatible endpoint what it serves.
 *
 * Only for `compatible`: the hosted providers have a known catalogue in the
 * registry, and a self-hosted box serves whatever models it happens to have
 * pulled. Making someone type `llama3.1:8b-instruct-q4_K_M` from memory is
 * exactly the sort of thing this is meant to avoid.
 *
 * A POST rather than a GET because the base URL and key travel in the body, and
 * the point of this route is that it can be called *before* the credential is
 * saved — the picker on the add form needs the list while the form is still
 * being filled in.
 */
router.post('/models', askLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { provider: providerId, baseUrl, apiKey, credentialId } = req.body as Record<string, unknown>;

  let base = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  let key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let provider = isProviderId(providerId) ? PROVIDERS[providerId] : null;

  // Editing an existing credential: the key was never sent to the browser, so
  // the browser cannot send it back. Look it up instead.
  if (typeof credentialId === 'string' && credentialId) {
    try {
      const cred = await resolveCredential(req.userId!, credentialId);
      provider = cred.provider;
      base = base || cred.baseUrl;
      key = key || cred.apiKey;
    } catch (err) {
      if (err instanceof LlmError) { res.status(err.status).json({ error: err.message }); return; }
      throw err;
    }
  }

  if (!provider) { res.status(400).json({ error: 'Unknown provider' }); return; }
  if (!provider.canListModels) {
    // Not an error: the catalogue is the answer for these.
    res.json({ models: provider.models.map(m => m.id) });
    return;
  }
  if (!base) { res.status(400).json({ error: 'Enter the base URL first' }); return; }

  try {
    res.json({ models: await listRemoteModels(provider, base, key) });
  } catch (err) {
    if (err instanceof LlmError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error(err, 'LLM model list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Proofread ───────────────────────────────────────────────────────────────

const MAX_PROOFREAD_CHARS = 40_000;

/**
 * Not streamed: the result is a structured report, useless until it is whole,
 * and there is nothing to show progressively. The call is bounded by a small
 * max_tokens so it comes back inside the proxy's window.
 */
router.post('/proofread', askLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { title, body } = req.body as Record<string, unknown>;
  if (typeof body !== 'string' || !body.trim()) {
    res.status(400).json({ error: 'There’s nothing to proofread yet' });
    return;
  }

  // The editor sends its HTML; the model wants prose. Converting here rather
  // than in the client keeps the quotes in the report matched to the text the
  // user actually sees, since that is what the model was shown.
  const text = htmlToText(body).slice(0, MAX_PROOFREAD_CHARS);
  if (!text.trim()) {
    res.status(400).json({ error: 'There’s nothing to proofread yet' });
    return;
  }

  try {
    const cred = await resolveCredential(req.userId!, null);
    const heading = typeof title === 'string' && title.trim() ? `Title: ${title.trim()}\n\n` : '';
    // The cheap model, deliberately. Proofreading is mechanical — find the
    // typo, name the ambiguous pronoun — and running it on a reasoning model
    // costs many times more for no better catch rate. See utilityModelFor.
    const model = utilityModelFor(cred.provider, cred.model);
    const raw = await completeChat({
      provider: cred.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model,
      system: PROOFREAD_SYSTEM,
      turns: [{ role: 'user', content: `${heading}${text}` }],
      maxTokens: PROOFREAD.maxTokens,
      effort: PROOFREAD.effort,
    });

    const report = parseProofread(raw);
    if (!report) {
      res.status(502).json({ error: 'Your model’s reply didn’t come back in a form Newt could read. Try again.' });
      return;
    }
    res.json(report);
  } catch (err) {
    if (err instanceof LlmError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error(err, 'LLM proofread error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
