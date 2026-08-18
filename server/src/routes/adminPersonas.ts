import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { recordAdminAction, ADMIN_ACTIONS } from '../lib/adminAudit';
import { perUserLimiter } from '../lib/rateLimit';
import { completeChat, LlmError, Usage } from '../lib/llm/chat';
import {
  resolveSiteModel, siteModelConfigured, recordUsage, UsageKind, ResolvedSiteModel,
  envSiteModelSummary, allowlistedPrivateHosts,
} from '../lib/llm/siteModels';
import { articleContextFor, renderContext } from '../lib/llm/articleContext';
import { markdownToHtml } from '../lib/llm/markdown';
import {
  personaOptions, normalizePersonaConfig, personaVoicePrompt,
  COMMENT_TASK, REPLY_TASK, POST_TASK, IDENTITY_TASK,
  parseGeneratedPost, parseIdentity, PersonaConfig,
} from '../lib/llm/personaPrompts';
import {
  canonicalArticleKey, sanitizeCommentHtml, isHttpUrl, isBlankHtml,
} from '../lib/comments';
import {
  sanitizeBlogHtml, excerptOf, slugify, uniqueSlug, postUrlFor,
} from '../lib/blog';
import { invalidateBlogFeeds } from '../lib/blogFeed';
import { syncPostReferences } from '../lib/exploredPaths';

/**
 * Personas: accounts the instance runs, and the endpoints that make them write.
 *
 * Every route here is behind requireAdmin. That is not incidental — it is most
 * of the abuse story. A persona writes into threads real people are reading, so
 * the ability to summon one is the ability to put words in front of an audience
 * under a name that is not yours. Only the operator's own admins get that, and
 * every use of it lands in the audit log (see ADMIN_ACTIONS.personaGenerate).
 *
 * Kept out of routes/admin.ts, which is already 1,500 lines of moderation and
 * feed observability. Nothing here shares a helper with that file, and the two
 * concerns are unrelated: that one is about watching the instance, this one is
 * about the instance speaking.
 */

const router = Router();
router.use(requireAuth, requireAdmin);

/**
 * Generation is slow and costs the operator, so it is rate limited even though
 * only admins can reach it.
 *
 * The limit is per admin, not per instance. A shared cap would mean one admin
 * bulk-generating locks the others out, and the thing being protected is a
 * self-hosted box whose real constraint is that it serves one request at a time
 * — a queue, not a quota. This is here to stop a stuck client hammering it.
 */
const generateLimiter = perUserLimiter({
  windowMs: 60 * 60_000,
  max: 60,
  message: 'Too many persona generations in the last hour — give the model a moment.',
});

// Long enough for a few paragraphs of post, which is the largest of the four
// tasks. Comments and replies are far shorter; the ceiling is not the target.
const MAX_OUTPUT_TOKENS = 1200;

const PERSONA_SELECT = {
  id: true,
  voice: true,
  verbosity: true,
  formality: true,
  interests: true,
  guidance: true,
  active: true,
  siteModelId: true,
  siteModel: { select: { label: true, model: true, baseUrl: true } },
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { username: true } },
  user: {
    select: {
      id: true, username: true, firstName: true, lastName: true, avatar: true, isPersona: true,
      _count: { select: { comments: true, blogPosts: true } },
    },
  },
} as const;

type PersonaRow = {
  id: string; voice: string; verbosity: string; formality: string;
  interests: string[]; guidance: string; active: boolean;
  siteModelId: string | null;
  siteModel: { label: string; model: string; baseUrl: string } | null;
  createdAt: Date; updatedAt: Date;
  createdBy: { username: string } | null;
  user: {
    id: string; username: string; firstName: string | null; lastName: string | null;
    avatar: string | null; isPersona: boolean;
    _count: { comments: number; blogPosts: number };
  };
};

function toJson(row: PersonaRow) {
  const full = [row.user.firstName, row.user.lastName].filter(Boolean).join(' ').trim();
  return {
    id: row.id,
    voice: row.voice,
    verbosity: row.verbosity,
    formality: row.formality,
    interests: row.interests,
    guidance: row.guidance,
    active: row.active,
    siteModelId: row.siteModelId,
    // Resolved for display. Null means the persona follows the instance default,
    // which is a real state and not a missing value — the UI says "site default"
    // rather than leaving the cell blank.
    siteModel: row.siteModel
      ? { label: row.siteModel.label || row.siteModel.baseUrl, model: row.siteModel.model }
      : null,
    createdBy: row.createdBy?.username ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    user: {
      id: row.user.id,
      username: row.user.username,
      displayName: full || row.user.username,
      avatar: row.user.avatar,
      isPersona: row.user.isPersona,
    },
    counts: { comments: row.user._count.comments, posts: row.user._count.blogPosts },
  };
}

/** Turn an LlmError into its own status, and anything else into a 500. */
function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof LlmError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error(err, context);
  res.status(500).json({ error: 'Server error' });
}

interface GenerateInput {
  cfg: PersonaConfig;
  displayName: string;
  task: string;
  context: string;
  kind: UsageKind;
  /** Which endpoint to prefer. Null falls through to the instance default. */
  siteModelId?: string | null;
  personaId?: string | null;
}

/**
 * Ask the site model for one piece of text, in a persona's voice.
 *
 * Every generation funnels through here so that four things are decided once:
 * which endpoint answers, the voice prompt, the token ceiling, and the
 * `trusted` flag — which is set in `resolveSiteModel` and nowhere else.
 *
 * **Usage is recorded on both paths.** A failure is the more interesting row of
 * the two: "the box stopped answering at 6pm" is invisible in a success-only
 * log, and it is the question an operator running their own GPU actually has.
 * The record is written before the error is rethrown so the caller's own error
 * handling is unchanged.
 *
 * Timing is wall clock around the whole call, which on a single GPU is what
 * exposes model swapping — the same prompt at 2s and then 40s is Ollama
 * unloading one model to load another.
 */
async function generate(input: GenerateInput): Promise<string> {
  const model = await resolveSiteModel(input.siteModelId);
  const started = Date.now();
  // Populated by the provider if it reports counts at all; Ollama does only on
  // newer builds, so this legitimately stays undefined.
  let usage: Usage | undefined;

  try {
    const text = await completeChat({
      provider: model.provider,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      model: model.model,
      system: personaVoicePrompt(input.cfg, input.displayName),
      turns: [{ role: 'user', content: `${input.task}\n\n---\n\n${input.context}` }],
      maxTokens: MAX_OUTPUT_TOKENS,
      trusted: model.trusted,
      onUsage: u => { usage = u; },
    });

    const trimmed = text.trim();
    if (!trimmed) {
      // Counted as a failure, because from the operator's point of view it is
      // one: an endpoint that answers with nothing is not working, and a
      // success-shaped row here would hide a box that is silently failing to
      // load its model.
      throw new LlmError(
        'The model returned nothing. It may still be loading — try again in a moment.',
        502,
      );
    }

    await recordUsage({
      siteModel: model, kind: input.kind, outcome: 'success', usage,
      durationMs: Date.now() - started,
      personaId: input.personaId, personaName: input.displayName,
    });
    return trimmed;
  } catch (err) {
    await recordUsage({
      siteModel: model, kind: input.kind, outcome: 'failed', usage,
      durationMs: Date.now() - started,
      personaId: input.personaId, personaName: input.displayName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Strip the wrapper a model puts around text it was asked for bare.
 *
 * Models answer "write a comment" with `Here's a comment:` and a block quote
 * often enough that leaving it in would show up in threads. Only the outermost
 * pair of quotes is removed, and only when they wrap the *whole* string — a
 * comment that legitimately opens and closes on quoted speech is rare, but
 * mangling one would be worse than leaving a stray quote in.
 */
export function stripPreamble(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^(?:here(?:'s| is)[^\n:]{0,60}:|sure[,!][^\n]{0,60}:)\s*/i, '').trim();
  if (/^"[^"]*"$/.test(text) || /^“[^”]*”$/.test(text)) text = text.slice(1, -1).trim();
  return text;
}

/** Markdown from the model, as HTML the comment editor would have produced. */
function toCommentHtml(markdown: string): string {
  return sanitizeCommentHtml(markdownToHtml(stripPreamble(markdown)));
}

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * The dial tables and whether the instance can generate at all.
 *
 * `configured: false` is the state that matters: the admin UI uses it to explain
 * that OPERATOR_LLM_BASE_URL is unset rather than showing buttons that 400.
 */
router.get('/options', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      ...personaOptions(),
      operator: {
        configured: await siteModelConfigured(),
        // The legacy env endpoint, if one is set. Shown so an admin upgrading
        // from v1.22.0 can see what personas are currently running on before
        // they add a row that will supersede it.
        env: envSiteModelSummary(),
        // Which private hosts the environment permits. The panel needs this to
        // explain a refusal at the moment an address is typed, rather than at
        // first generation.
        privateHosts: allowlistedPrivateHosts(),
      },
    });
  } catch (err) {
    fail(res, err, 'Persona options error');
  }
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.persona.findMany({
      select: PERSONA_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ personas: (rows as PersonaRow[]).map(toJson) });
  } catch (err) {
    fail(res, err, 'List personas error');
  }
});

/**
 * A username nobody has, derived from one the model suggested.
 *
 * The suffix is only added on an actual collision, so the common case keeps the
 * name that was generated. Ten attempts then a random tail: a loop that could
 * spin forever on a pathological prefix is not worth the tidier name.
 */
async function freeUsername(base: string): Promise<string> {
  const root = base.replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'persona';
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? root : `${root}${i + 1}`;
    const taken = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${root}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Create a persona: an account plus its settings, in one transaction.
 *
 * The identity (username, display name, bio) is generated from the tone dials
 * unless the admin supplied one, because naming and writing a bio for seven
 * personas by hand is the part that gets abandoned. When the model is
 * unreachable or answers unusably, this falls back to a derived name rather than
 * failing — the dials are the part the admin actually chose, and losing the
 * whole creation over a flavour field would be the wrong trade.
 */
router.post('/', generateLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const cfg = normalizePersonaConfig(body as Partial<PersonaConfig>);
  const wantedName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 40) : '';
  const wantedUsername = typeof body.username === 'string'
    ? body.username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)
    : '';
  // Null, not undefined: null is the stored value meaning "use the instance
  // default", and it is also what the client sends when the picker is cleared.
  const siteModelId = typeof body.siteModelId === 'string' && body.siteModelId ? body.siteModelId : null;

  try {
    let displayName = wantedName;
    let username = wantedUsername;
    let bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 140) : '';

    // Only call the model for the parts the admin left blank.
    if (!displayName || !username) {
      try {
        const raw = await generate({
          cfg,
          displayName: displayName || 'this persona',
          task: IDENTITY_TASK,
          context:
            `Voice: ${cfg.voice}. Formality: ${cfg.formality}. Length: ${cfg.verbosity}.\n` +
            `Interests: ${cfg.interests.join(', ') || 'general'}.` +
            (cfg.guidance ? `\nExtra direction: ${cfg.guidance}` : ''),
          kind: 'identity',
          siteModelId,
        });
        const identity = parseIdentity(raw);
        if (identity) {
          displayName = displayName || identity.displayName;
          username = username || identity.username;
          bio = bio || identity.bio;
        }
      } catch (err) {
        // Logged, not surfaced: the persona is still creatable without it.
        logger.warn(err, 'Persona identity generation failed — falling back to a derived name');
      }
    }

    if (!displayName) displayName = cfg.interests[0] ? `${cfg.interests[0]} reader` : 'Persona';
    username = await freeUsername(username || slugify(displayName).replace(/-/g, '_'));

    // A persona never signs in. There is no login route that would accept this
    // account — no password is ever issued to anyone — but the column is NOT
    // NULL and a predictable value there would be a credential. Random bytes,
    // hashed like any other, so the row is indistinguishable from a real one to
    // anything that reads it and unusable to anything that tries it.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

    const created = await prisma.$transaction(async tx => {
      const user = await tx.user.create({
        data: {
          username,
          passwordHash,
          isPersona: true,
          firstName: displayName.slice(0, 40),
          // The bio goes in the same place a person's would. Personas get no
          // private surface of their own: everything about one is either public
          // or is configuration on the Persona row.
          settings: bio ? { bio } : {},
        },
        select: { id: true, username: true },
      });

      const persona = await tx.persona.create({
        data: { userId: user.id, ...cfg, siteModelId, createdById: req.userId! },
        select: PERSONA_SELECT,
      });

      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.personaCreate,
        targetType: 'persona',
        targetId: persona.id,
        targetLabel: user.username,
        metadata: { voice: cfg.voice, verbosity: cfg.verbosity, formality: cfg.formality },
      });

      return persona;
    });

    res.status(201).json(toJson(created as PersonaRow));
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'That username is already taken' });
      return;
    }
    fail(res, err, 'Create persona error');
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  try {
    const existing = await prisma.persona.findUnique({
      where: { id: req.params.id },
      select: { id: true, voice: true, verbosity: true, formality: true, interests: true, guidance: true, user: { select: { username: true } } },
    });
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

    // Merge over what is stored, so a PATCH of one dial doesn't reset the rest
    // to defaults — normalizePersonaConfig fills every field, so handing it a
    // bare body would silently blank the others.
    const cfg = normalizePersonaConfig({
      voice: (body.voice as string) ?? existing.voice,
      verbosity: (body.verbosity as string) ?? existing.verbosity,
      formality: (body.formality as string) ?? existing.formality,
      interests: (body.interests as string[]) ?? existing.interests,
      guidance: (body.guidance as string) ?? existing.guidance,
    });

    // Three-state, unlike every other field here: absent leaves the choice
    // alone, an id sets it, and an explicit null puts the persona back on the
    // instance default. `?? existing` would make "clear this" unexpressible.
    const modelPatch = 'siteModelId' in body
      ? { siteModelId: typeof body.siteModelId === 'string' && body.siteModelId ? body.siteModelId : null }
      : {};

    const updated = await prisma.$transaction(async tx => {
      const row = await tx.persona.update({
        where: { id: req.params.id },
        data: {
          ...cfg,
          ...modelPatch,
          ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
        },
        select: PERSONA_SELECT,
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.personaUpdate,
        targetType: 'persona',
        targetId: row.id,
        targetLabel: existing.user.username,
      });
      return row;
    });

    res.json(toJson(updated as PersonaRow));
  } catch (err) {
    fail(res, err, 'Update persona error');
  }
});

/**
 * Delete a persona and the account it speaks through.
 *
 * This takes its comments and posts with it, by the cascade already on User —
 * which is the intended behaviour and the reason the action is marked
 * destructive. A persona whose account survived would be an unlabelled orphan;
 * a persona row that survived its account would be settings pointing at nobody.
 */
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const persona = await prisma.persona.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true, user: { select: { username: true, _count: { select: { comments: true, blogPosts: true } } } } },
    });
    if (!persona) { res.status(404).json({ error: 'Not found' }); return; }

    await prisma.$transaction(async tx => {
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.personaDelete,
        targetType: 'persona',
        targetId: persona.id,
        targetLabel: persona.user.username,
        metadata: {
          comments: persona.user._count.comments,
          posts: persona.user._count.blogPosts,
        },
      });
      // Deleting the user cascades to the Persona row, its comments and posts.
      await tx.user.delete({ where: { id: persona.userId } });
    });

    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Delete persona error');
  }
});

// ── Generation ───────────────────────────────────────────────────────────────

/**
 * Load a persona that is allowed to write, or answer why not.
 *
 * `active` and the operator config are checked here rather than at each call
 * site so that pausing a persona, or never having set a model, reliably stops
 * all three verbs with the same message.
 *
 * **The model check comes first, before anything is looked up.** It was last
 * originally, and that put the most common failure on a new instance — nobody
 * has set OPERATOR_LLM_BASE_URL yet — behind whatever else happened to fail
 * first. In practice that meant an admin trying a persona on an article Newt
 * had no record of got "Newt has no record of that article", went off checking
 * the article, and never learned the real problem. Cheapest check, and the one
 * whose answer is most actionable, goes at the front.
 */
async function writablePersona(id: string) {
  if (!(await siteModelConfigured())) {
    throw new LlmError(
      'No site model is configured. Add one in Admin → Personas to use AI personas.',
      400,
    );
  }
  const row = await prisma.persona.findUnique({
    where: { id },
    select: {
      id: true, voice: true, verbosity: true, formality: true, interests: true,
      guidance: true, active: true, siteModelId: true,
      user: { select: { id: true, username: true, firstName: true, lastName: true } },
    },
  });
  if (!row) throw new LlmError('That persona no longer exists.', 404);
  if (!row.active) throw new LlmError('That persona is paused. Switch it back on to generate.', 409);
  return row;
}

function nameOf(u: { username: string; firstName: string | null; lastName: string | null }): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.username;
}

/**
 * POST /:id/comment — a root comment on an article.
 *
 * The comment is written as `public`, unlike a person's, which defaults to
 * `private`. A private persona comment would be visible only to the persona,
 * which is not a thing anybody would want; the whole point of summoning one is
 * that the thread gets a reply. Stated in the body all the same so the caller
 * can choose otherwise.
 */
router.post('/:id/comment', generateLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { url, articleTitle } = req.body as Record<string, unknown>;
  if (!isHttpUrl(url)) { res.status(400).json({ error: 'url must be an http(s) URL' }); return; }

  try {
    const persona = await writablePersona(req.params.id);
    // The persona's own id, so comment visibility is filtered by what *it* can
    // see — a persona has no friends, so this is public comments and its own.
    // Using the admin's id here would let a persona react to friends-only
    // comments it has no business reading. See articleContextFor.
    const ctx = await articleContextFor(url, persona.user.id);
    if (!ctx) { res.status(404).json({ error: 'Newt has no record of that article.' }); return; }

    const text = await generate({
      cfg: persona, displayName: nameOf(persona.user), task: COMMENT_TASK,
      context: renderContext(ctx), kind: 'comment',
      siteModelId: persona.siteModelId, personaId: persona.id,
    });
    const html = toCommentHtml(text);
    if (isBlankHtml(html)) {
      res.status(502).json({ error: 'The model returned an empty comment. Try again.' });
      return;
    }

    const key = canonicalArticleKey(url as string);
    const created = await prisma.$transaction(async tx => {
      const comment = await tx.comment.create({
        data: {
          userId: persona.user.id,
          articleKey: key,
          articleUrl: url as string,
          articleTitle: typeof articleTitle === 'string' ? articleTitle.slice(0, 500) : ctx.title.slice(0, 500),
          body: html,
          visibility: 'public',
        },
        select: { id: true },
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.personaGenerate,
        targetType: 'persona',
        targetId: persona.id,
        targetLabel: persona.user.username,
        metadata: { kind: 'comment', commentId: comment.id, url: (url as string).slice(0, 500) },
      });
      return comment;
    });

    res.status(201).json({ id: created.id, body: html });
  } catch (err) {
    fail(res, err, 'Persona comment error');
  }
});

/**
 * POST /:id/reply — a reply to one comment.
 *
 * The parent is read with its surrounding thread so the persona is not replying
 * into a vacuum, but the prompt marks which one it is answering: given an
 * article and a thread, a model will otherwise write about the article. See
 * REPLY_TASK.
 */
router.post('/:id/reply', generateLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { commentId } = req.body as Record<string, unknown>;
  if (typeof commentId !== 'string') { res.status(400).json({ error: 'commentId is required' }); return; }

  try {
    const persona = await writablePersona(req.params.id);

    const parent = await prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        id: true, body: true, articleKey: true, articleUrl: true, articleTitle: true,
        deletedAt: true, visibility: true,
        user: { select: { username: true, firstName: true, lastName: true } },
      },
    });
    if (!parent) { res.status(404).json({ error: 'That comment no longer exists.' }); return; }
    if (parent.deletedAt) { res.status(409).json({ error: 'That comment was deleted.' }); return; }
    // A persona may only answer something posted publicly. Replying to a
    // friends-only or private comment would put a reply — and the fact of the
    // comment's existence — in front of an audience its author chose to exclude,
    // and the persona is not a friend of anybody.
    if (parent.visibility !== 'public') {
      res.status(403).json({ error: 'A persona can only reply to public comments.' });
      return;
    }

    const ctx = await articleContextFor(parent.articleUrl, persona.user.id);
    const parentAuthor = nameOf(parent.user);
    const context =
      (ctx ? `${renderContext(ctx)}\n\n` : `Article: ${parent.articleTitle || parent.articleUrl}\n\n`) +
      `Replying to ${parentAuthor}:\n"""\n${htmlToPlain(parent.body).slice(0, 4000)}\n"""`;

    const text = await generate({
      cfg: persona, displayName: nameOf(persona.user), task: REPLY_TASK,
      context, kind: 'reply',
      siteModelId: persona.siteModelId, personaId: persona.id,
    });
    const html = toCommentHtml(text);
    if (isBlankHtml(html)) {
      res.status(502).json({ error: 'The model returned an empty reply. Try again.' });
      return;
    }

    const created = await prisma.$transaction(async tx => {
      const comment = await tx.comment.create({
        data: {
          userId: persona.user.id,
          articleKey: parent.articleKey,
          articleUrl: parent.articleUrl,
          articleTitle: parent.articleTitle,
          parentId: parent.id,
          body: html,
          visibility: 'public',
        },
        select: { id: true },
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.personaGenerate,
        targetType: 'persona',
        targetId: persona.id,
        targetLabel: persona.user.username,
        metadata: { kind: 'reply', commentId: comment.id, parentId: parent.id },
      });
      return comment;
    });

    res.status(201).json({ id: created.id, body: html, parentId: parent.id });
  } catch (err) {
    fail(res, err, 'Persona reply error');
  }
});

/**
 * POST /:id/post — a blog post about an article, under the persona's name.
 *
 * **Created as a draft** (`visibility: 'private'`), unlike the two comment
 * routes. The asymmetry is deliberate: a comment is one paragraph in a thread
 * and its context makes it obviously a reaction, while a post is a standalone
 * page with a title that gets a URL, an RSS entry in subscribers' folders and a
 * search-engine footprint. Publishing that unread is a different size of
 * mistake, so the admin opens it and presses publish.
 */
router.post('/:id/post', generateLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { url } = req.body as Record<string, unknown>;
  if (!isHttpUrl(url)) { res.status(400).json({ error: 'url must be an http(s) URL' }); return; }

  try {
    const persona = await writablePersona(req.params.id);
    const ctx = await articleContextFor(url, persona.user.id);
    if (!ctx) { res.status(404).json({ error: 'Newt has no record of that article.' }); return; }

    const raw = await generate({
      cfg: persona, displayName: nameOf(persona.user), task: POST_TASK,
      context: renderContext(ctx), kind: 'post',
      siteModelId: persona.siteModelId, personaId: persona.id,
    });
    const { title, body } = parseGeneratedPost(raw);
    const clean = sanitizeBlogHtml(markdownToHtml(body));
    if (isBlankHtml(clean)) {
      res.status(502).json({ error: 'The model returned an empty post. Try again.' });
      return;
    }

    const taken = new Set(
      (await prisma.blogPost.findMany({ where: { userId: persona.user.id }, select: { slug: true } }))
        .map(p => p.slug),
    );
    const slug = uniqueSlug(slugify(title), taken);
    const postUrl = postUrlFor(persona.user.username, slug);

    const created = await prisma.$transaction(async tx => {
      const post = await tx.blogPost.create({
        data: {
          userId: persona.user.id,
          title,
          slug,
          body: clean,
          excerpt: excerptOf(clean),
          tags: persona.interests.slice(0, 4),
          visibility: 'private',
          url: postUrl,
          articleKey: canonicalArticleKey(postUrl),
        },
        select: { id: true, title: true, slug: true, url: true },
      });
      await recordAdminAction(tx, {
        actorId: req.userId!,
        actorUsername: req.username ?? 'unknown',
        action: ADMIN_ACTIONS.personaGenerate,
        targetType: 'persona',
        targetId: persona.id,
        targetLabel: persona.user.username,
        metadata: { kind: 'post', postId: post.id, about: (url as string).slice(0, 500) },
      });
      return post;
    });

    // Which article this post is about, for its explored-paths list. Same call
    // the ordinary create makes, and it reads the stored body.
    await syncPostReferences(created.id, clean).catch(err =>
      logger.warn(err, 'Persona post reference sync failed'));

    // A draft is in nobody's feed yet, so there is nothing to invalidate until
    // it is published — the publish path in routes/blogs.ts does that.
    res.status(201).json({ ...created, visibility: 'private' });
  } catch (err) {
    fail(res, err, 'Persona post error');
  }
});

/**
 * The text of a stored comment, for showing a model what it is replying to.
 *
 * Deliberately not the sanitized HTML: the model does not need markup, and
 * feeding it tags invites it to answer in them. Kept local because it is a
 * different job from lib/llm/htmlText — that one is for article bodies and
 * preserves paragraph structure over long documents.
 */
function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default router;
