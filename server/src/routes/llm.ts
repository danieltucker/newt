import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';
import { PROVIDERS, publicProviders, isProviderId, utilityModelFor } from '../lib/llm/providers';
import { sealSecret, last4 } from '../lib/llm/secretBox';
import { resolveCredential, toPublicCredential } from '../lib/llm/credentials';
import { completeChat, listRemoteModels, LlmError } from '../lib/llm/chat';
import {
  PROOFREAD_SYSTEM, parseProofread, IDEAS_SYSTEM, parseIdeas, IdeaPick,
  RELEVANCE_SYSTEM, parseRelevance,
} from '../lib/llm/prompts';
import { PROOFREAD, IDEAS, RELEVANCE } from '../lib/llm/depth';
import { htmlToText } from '../lib/llm/htmlText';
import { articleContextFor, renderContext } from '../lib/llm/articleContext';
import { articleTextFor } from '../lib/llm/articleText';
import { draftLinks } from '../lib/llm/draftLinks';
import { aiPrefs, gatherFeedContext } from '../lib/llm/feedPlanner';
import { renderFeedContext, FeedHit } from '../lib/llm/feedContext';
import { canonicalArticleKey } from '../lib/comments';
import { MAX_BLOG_TITLE } from '../lib/blog';

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

// ── Ideas for a post ────────────────────────────────────────────────────────

/** The brief itself: a paragraph about what the author wants to write. */
const MAX_BRIEF = 2_000;
/** How much of the draft goes in. Well past the point where a draft has a shape. */
const MAX_DRAFT_CHARS = 20_000;
/**
 * How many of the draft's own links are read.
 *
 * Each one is a page fetch and up to MAX_LINK_CHARS of prompt, and they are
 * taken in document order — so this is "the first three things the author
 * anchored the piece on", which is the right three to have. Beyond that the
 * material stops being about the post and starts being a bill.
 */
const MAX_LINKS = 3;
/**
 * Per linked page. Much tighter than Explore's article budget, deliberately:
 * this pass needs to know what a page argues, not to be able to quote it, and
 * three articles at Explore's ceiling would be more context than the entire
 * rest of the request put together.
 */
const MAX_LINK_CHARS = 6_000;

/** One related article as the composer renders it. */
interface RelatedJson {
  title: string;
  url: string;
  source: string;
  pubDate: string | null;
  /** The model's line on why it is worth reading. Empty when it didn't pick. */
  why: string;
}

/**
 * What the author has already gathered, as prompt material.
 *
 * Prefers what Newt holds — a feed item, a post, a saved article — and falls
 * back to reading the page for a link that is merely pasted, which most links
 * in a draft are. Both paths are the ones Explore uses, so both are behind the
 * same SSRF gate and the same cache.
 *
 * Comments are dropped even when the stored context has them. Other people's
 * replies are worth having when the question is about an article; when the
 * question is "what should I write", they are a different conversation.
 */
async function linkedContext(url: string, userId: string): Promise<string | null> {
  const stored = await articleContextFor(url, userId).catch(() => null);
  if (stored && stored.text) {
    return renderContext({ ...stored, text: stored.text.slice(0, MAX_LINK_CHARS), comments: [] });
  }

  const key = canonicalArticleKey(url);
  const fetched = key ? await articleTextFor(url, key).catch(() => '') : '';
  if (!fetched) return null;
  return renderContext({
    title: stored?.title ?? '',
    url,
    text: fetched.slice(0, MAX_LINK_CHARS),
    source: 'fetched',
    comments: [],
  });
}

/** How much of an article the relevance screen is shown before it decides. */
const MAX_SCREEN_SNIPPET = 400;

/**
 * A candidate article, on its way to the author.
 *
 * The hit is carried whole rather than flattened straight into RelatedJson,
 * because the relevance screen below needs the snippet — the title alone is not
 * enough to tell an article about this subject from an article that shares a
 * proper noun with it.
 */
interface Candidate {
  hit: FeedHit;
  why: string;
}

/**
 * The model's picks, joined back onto the articles it was actually shown.
 *
 * The model returns URLs and a line about each; the title, publication and date
 * come from the search hit, never from the reply. That is what makes a
 * hallucinated URL impossible to display: anything not in `hits` has no row to
 * join to and is dropped, rather than reaching the author as a plausible-looking
 * link to a piece that does not exist.
 */
function joinPicks(picks: IdeaPick[], hits: FeedHit[]): Candidate[] {
  const byUrl = new Map(hits.map(h => [h.url, h]));
  const chosen: Candidate[] = [];
  const used = new Set<string>();

  for (const pick of picks) {
    const hit = byUrl.get(pick.url);
    if (!hit || used.has(hit.url)) continue;
    used.add(hit.url);
    chosen.push({ hit, why: pick.why });
  }
  return chosen;
}

/**
 * Ask the cheap model which of these are actually worth the author's time.
 *
 * A second opinion, deliberately separate from the model that produced the
 * angles: see RELEVANCE_SYSTEM for why the first pass is not a relevance check
 * even when it looks like one. The screen may keep none, and that is a result
 * rather than a failure.
 *
 * Returns null when the screen did not happen — the call threw, or the reply
 * could not be read. The caller decides what an unscreened list is worth, and
 * the answer is not the same for a list a model chose and a list that fell out
 * of `ts_rank`.
 */
async function screenRelevance(
  cred: Awaited<ReturnType<typeof resolveCredential>>,
  subject: string,
  candidates: Candidate[],
): Promise<Candidate[] | null> {
  const lines = [`<brief>`, subject.slice(0, 2_000), `</brief>`, '', '<articles>'];
  candidates.forEach(({ hit }, i) => {
    const when = hit.pubDate ? hit.pubDate.slice(0, 10) : 'undated';
    lines.push('');
    lines.push(`${i + 1}. ${hit.title} — ${hit.source || 'unknown source'}, ${when}`);
    if (hit.snippet) lines.push(hit.snippet.slice(0, MAX_SCREEN_SNIPPET));
  });
  lines.push('</articles>');

  try {
    const model = utilityModelFor(cred.provider, cred.model);
    const raw = await completeChat({
      provider: cred.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model,
      system: RELEVANCE_SYSTEM,
      turns: [{ role: 'user', content: lines.join('\n') }],
      maxTokens: RELEVANCE.maxTokens,
      effort: RELEVANCE.effort,
    });

    const kept = parseRelevance(raw, candidates.length);
    if (!kept) {
      logger.info({ reply: raw.slice(0, 200) }, 'Ideas: relevance screen could not be read');
      return null;
    }
    // The screen's own line wins where it wrote one: it is the judgement that
    // decided the article survives, so it is the one that should explain it.
    return kept.map(({ n, why }) => ({
      hit: candidates[n - 1].hit,
      why: why || candidates[n - 1].why,
    }));
  } catch (err) {
    logger.info({ err }, 'Ideas: relevance screen failed');
    return null;
  }
}

/**
 * The related-articles list, screened.
 *
 * Two ways in and one way out. Normally the ideas model has picked some, and
 * those go to the screen. When it picked none — a formatting slip, or a reply
 * that put the list under a key nobody asked for — the search hits go instead,
 * because the author asked for related articles from their feed and these are
 * them; losing the lot to a stray key would be the wrong way to fail.
 *
 * If the screen itself does not happen, the picks stand and the fallback does
 * not. A list a model chose while looking at the brief has been through one
 * judgement; a list that fell out of a keyword search has been through none,
 * and unjudged keyword matches are the thing this whole path exists to stop
 * reaching the author.
 */
async function relatedArticles(
  cred: Awaited<ReturnType<typeof resolveCredential>>,
  subject: string,
  picks: IdeaPick[],
  hits: FeedHit[],
): Promise<RelatedJson[]> {
  const chosen = joinPicks(picks, hits);
  const candidates = chosen.length > 0 ? chosen : hits.slice(0, 5).map(hit => ({ hit, why: '' }));
  if (candidates.length === 0) return [];

  const screened = await screenRelevance(cred, subject, candidates);
  const final = screened ?? chosen;

  return final.map(({ hit, why }) => ({
    title: hit.title, url: hit.url, source: hit.source, pubDate: hit.pubDate, why,
  }));
}

/**
 * Ideas for a post that hasn't been written.
 *
 * The composer's other end of Explore. Explore is for a question you want
 * answered; this is for a piece you want to write, and the difference in the
 * output is the point — it comes back as angles and questions and things to
 * read, never as prose, because the moment it returns prose the post stops
 * being the author's. See IDEAS_SYSTEM.
 *
 * Four sources of material, in ascending order of cost: the brief, the draft as
 * it stands, the pages the draft links to, and a planned search of the author's
 * own feed. Every one of them past the first is optional and every one of them
 * fails soft — a dead link, or a feed search that finds nothing, leaves a
 * thinner answer rather than an error.
 *
 * Not streamed, for the same reason proofreading isn't: the result is a
 * structured report and there is nothing useful to show half of.
 */
router.post('/ideas', askLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { brief, title, body } = req.body as Record<string, unknown>;

  const askedFor = typeof brief === 'string' ? brief.trim().slice(0, MAX_BRIEF) : '';
  const html = typeof body === 'string' ? body : '';
  const draft = htmlToText(html).slice(0, MAX_DRAFT_CHARS).trim();
  const heading = typeof title === 'string' ? title.trim().slice(0, MAX_BLOG_TITLE) : '';
  // Either half is enough to work from: an author with a blank page has only
  // the brief, and one who has been writing for an hour may reasonably expect
  // "what else could I say here" to need no further explanation.
  if (!askedFor && !draft && !heading) {
    res.status(400).json({ error: 'Say what you’re thinking of writing about' });
    return;
  }

  try {
    const cred = await resolveCredential(req.userId!, null);
    const prefs = await aiPrefs(req.userId!);

    // What the feed planner is given. The brief leads, because it is what the
    // author means to write about; the draft only stands in when there isn't
    // one, since a long draft's opening is not necessarily what the rest of it
    // is reaching for.
    const subject = [heading, askedFor || draft.slice(0, 1_000)].filter(Boolean).join('\n');

    const links = draftLinks(html, MAX_LINKS);
    // In parallel with the feed search: three page fetches and a planner call
    // one after another is most of ten seconds spent watching a spinner, and
    // none of the four needs anything from the others.
    const [linkBlocks, feedHits] = await Promise.all([
      Promise.all(links.map(url => linkedContext(url, req.userId!))),
      gatherFeedContext(req.userId!, cred, subject, prefs, () => {}),
    ]);
    const linked = linkBlocks.filter((b): b is string => b !== null);

    const parts: string[] = [];
    if (linked.length > 0) parts.push('<linked>', ...linked, '</linked>');
    if (feedHits.length > 0) parts.push(renderFeedContext(feedHits));
    if (heading || draft) {
      parts.push(heading ? `<draft title="${heading.replace(/"/g, "'")}">` : '<draft>');
      parts.push(draft || '[a title and nothing else so far]', '</draft>');
    }
    // Last, so the thing being asked for is the last thing read.
    parts.push('<brief>', askedFor || '[no brief given — go on the draft alone]', '</brief>');

    const raw = await completeChat({
      provider: cred.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model: cred.model,
      system: IDEAS_SYSTEM,
      turns: [{ role: 'user', content: parts.join('\n') }],
      maxTokens: IDEAS.maxTokens,
      effort: IDEAS.effort,
    });

    const report = parseIdeas(raw);
    if (!report) {
      res.status(502).json({ error: 'Your model’s reply didn’t come back in a form Newt could read. Try again.' });
      return;
    }

    res.json({
      summary: report.summary,
      angles: report.angles,
      questions: report.questions,
      related: await relatedArticles(cred, subject, report.related, feedHits),
      // So the panel can say what it read. An author who linked three pieces
      // and is told one was read knows the others were unreachable, which is
      // worth knowing before deciding whether a thin answer is the model's
      // fault. Tried rather than found, and capped at MAX_LINKS like the fetch
      // itself: claiming to have read "all the links in your draft" would be a
      // lie on the fourth one.
      linksRead: linked.length,
      linksTried: links.length,
    });
  } catch (err) {
    if (err instanceof LlmError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error(err, 'LLM ideas error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
