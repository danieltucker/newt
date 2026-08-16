import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';
import { resolveCredential } from '../lib/llm/credentials';
import { streamChat, completeChat, LlmError, ChatTurn, Usage } from '../lib/llm/chat';
import { openSse } from '../lib/llm/sse';
import {
  researchSystemPrompt, splitSuggestions, titleFromQuestion,
  SUGGESTION_MARKER, CONDENSE_SYSTEM, parseCondensed,
  PLANNER_SYSTEM, parsePlan,
} from '../lib/llm/prompts';
import { articleContextFor, renderContext } from '../lib/llm/articleContext';
import { searchFeed, renderFeedContext, hasFeeds, FeedHit } from '../lib/llm/feedContext';
import { researchDepth, condenseDepth, PLANNER, isDepth, Depth } from '../lib/llm/depth';
import { utilityModelFor } from '../lib/llm/providers';
import { estimateCost } from '../lib/llm/cost';
import { markdownToHtml } from '../lib/llm/markdown';
import {
  sanitizeBlogHtml, slugify, uniqueSlug, postUrlFor, normalizeTags, MAX_BLOG_TITLE,
} from '../lib/blog';
import { canonicalArticleKey, isHttpUrl } from '../lib/comments';

const router = Router();
router.use(requireAuth);

const MAX_QUESTION = 8_000;
const MAX_THREADS = 500;
// How many articles one question may attach with /reference. Four is enough to
// ask "how do these three accounts differ?" and few enough that a single turn
// cannot quietly become the most expensive request the account has ever made:
// each one is a whole article, and they are all re-sent on every follow-up.
const MAX_REFS = 4;
// And how many distinct referenced articles the whole thread will carry into a
// replay. Without a ceiling a long conversation grows one article per question
// forever, and the twentieth follow-up pays for nineteen pieces nobody is still
// asking about.
const MAX_CONTEXT_REFS = 8;
// How much of a long conversation is replayed to the model. Older turns are
// dropped from the middle rather than summarized: a research thread's opening
// question frames everything, and the recent turns are what the next answer
// follows from — it is the material in between that goes stale first.
const MAX_REPLAYED_TURNS = 40;

const researchLimiter = perUserLimiter({
  windowMs: 60_000,
  max: 15,
  message: 'That’s a lot of research at once — give it a minute.',
});

interface ThreadRow {
  id: string;
  title: string;
  sourceUrl: string;
  sourceTitle: string;
  visibility: string;
  sharedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The tiers a thread can be on — the same three as comments and posts. */
const THREAD_VISIBILITIES = ['public', 'friends', 'private'] as const;

function isThreadVisibility(v: unknown): v is typeof THREAD_VISIBILITIES[number] {
  return typeof v === 'string' && (THREAD_VISIBILITIES as readonly string[]).includes(v);
}

function toThreadJson(t: ThreadRow) {
  return {
    id: t.id,
    title: t.title,
    sourceUrl: t.sourceUrl,
    sourceTitle: t.sourceTitle,
    visibility: t.visibility,
    sharedAt: t.sharedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** The shape the client renders a consulted article as. */
interface SourceJson {
  title: string;
  url: string;
  source: string;
  pubDate: string | null;
}

/**
 * Read the stored sources back defensively.
 *
 * The column is JSON, so nothing in the database guarantees its shape — and a
 * row written before the column existed defaults to `[]`. Anything that isn't a
 * recognisable source is dropped rather than passed through, since it reaches
 * the client as a link the reader is invited to click.
 */
function toSourcesJson(raw: unknown): SourceJson[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (typeof item !== 'object' || item === null) return [];
    const s = item as Record<string, unknown>;
    if (typeof s.url !== 'string' || !s.url) return [];
    return [{
      title: typeof s.title === 'string' ? s.title : '',
      url: s.url,
      source: typeof s.source === 'string' ? s.source : '',
      pubDate: typeof s.pubDate === 'string' ? s.pubDate : null,
    }];
  });
}

function toMessageJson(
  m: { id: string; role: string; body: string; suggestions: unknown; sources?: unknown; createdAt: Date },
) {
  return {
    id: m.id,
    role: m.role,
    body: m.body,
    suggestions: Array.isArray(m.suggestions) ? m.suggestions.filter(s => typeof s === 'string') : [],
    sources: toSourcesJson(m.sources),
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * The articles a reader attached to a question with /reference.
 *
 * Stored in the same `sources` column the feed search writes to, and in the same
 * shape — a referenced article and a found one are the same kind of thing to
 * everything downstream, and giving the reader's own picks a second column would
 * have meant a migration and two code paths to render one list of articles.
 *
 * Resolved through articleContextFor rather than trusted from the body, which is
 * what makes this safe to accept from a client: it is the same visibility check
 * the reader's own comment panel applies, so a URL nobody here has any record of
 * — or a friends-only post by someone who isn't a friend — resolves to nothing
 * and is silently dropped rather than fetched on the caller's behalf.
 */
async function resolveReferences(userId: string, raw: unknown): Promise<SourceJson[]> {
  if (!Array.isArray(raw)) return [];

  const urls: string[] = [];
  for (const candidate of raw) {
    if (urls.length >= MAX_REFS) break;
    if (typeof candidate !== 'string') continue;
    if (!isHttpUrl(candidate) || !canonicalArticleKey(candidate)) continue;
    if (!urls.includes(candidate)) urls.push(candidate);
  }
  if (urls.length === 0) return [];

  // The publisher and the date are what make a chip readable six weeks later,
  // and articleContextFor knows neither — it is built to answer "what does this
  // say", not "what is it called". So the card metadata comes from the feed row
  // alongside it, and its absence is not a reason to drop the reference: a
  // hand-saved link has a title and no feed to have come from.
  const resolved = await Promise.all(urls.map(async (url) => {
    const ctx = await articleContextFor(url, userId).catch(() => null);
    if (!ctx) return null;
    const item = await prisma.feedItem.findFirst({
      where: { linkKey: canonicalArticleKey(url) },
      orderBy: { pubDate: 'desc' },
      select: { pubDate: true, feed: { select: { title: true } } },
    }).catch(() => null);
    return {
      title: ctx.title,
      url: ctx.url,
      source: item?.feed?.title ?? '',
      pubDate: item?.pubDate ? item.pubDate.toISOString() : null,
    };
  }));

  return resolved.filter((s): s is SourceJson => s !== null);
}

/** Confirms the thread is this user's before anything else touches it. */
async function ownThread(userId: string, id: string) {
  return prisma.researchThread.findFirst({ where: { id, userId } });
}

interface AiPrefs {
  depth: Depth;
  feedSearch: boolean;
  showCost: boolean;
}

/**
 * The three AI preferences, read from the settings blob.
 *
 * Defaulted here rather than trusted from the client: these decide what gets
 * spent, so a stale or hand-edited value must land on the cheap side rather
 * than the expensive one.
 */
async function aiPrefs(userId: string): Promise<AiPrefs> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const s = (row?.settings ?? {}) as Record<string, unknown>;
  return {
    depth: isDepth(s.aiDepth) ? s.aiDepth : 'balanced',
    feedSearch: s.aiFeedSearch !== false,
    showCost: s.aiShowCost !== false,
  };
}

/**
 * Ask the cheap model what to look for, then go and look.
 *
 * Two calls' worth of latency before the real answer starts, which is the cost
 * of this being useful — so it is skipped entirely when the account has no
 * feeds, when the reader has turned it off, and whenever the planner says the
 * question isn't the kind a news archive answers.
 *
 * Every failure path returns an empty list. A feed search that goes wrong must
 * never take the question down with it: the answer is worse without the
 * articles, not impossible.
 *
 * Which is exactly why every step logs. Swallowing the failures is right, but
 * swallowing them silently made "the planner declined", "the planner call
 * threw" and "the search ran and matched nothing" indistinguishable from
 * outside — three very different problems that all look like the feature being
 * switched off. The log line is the only place the difference is visible, since
 * none of this is ever shown to the reader.
 *
 * At `info` rather than `debug` because the logger runs at `info` in production
 * (see lib/logger), and a diagnostic that only exists in development is no use
 * for the thing it was written to diagnose. The volume is fine: one line per
 * Explore turn, and every one of those turns is already paying for two model
 * calls.
 */
async function gatherFeedContext(
  userId: string,
  cred: Awaited<ReturnType<typeof resolveCredential>>,
  question: string,
  prefs: AiPrefs,
  onUsage: (u: Usage, model: string) => void,
): Promise<FeedHit[]> {
  if (!prefs.feedSearch) return [];
  try {
    if (!(await hasFeeds(userId))) return [];

    const utility = utilityModelFor(cred.provider, cred.model);
    const raw = await completeChat({
      provider: cred.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model: utility,
      system: PLANNER_SYSTEM,
      turns: [{ role: 'user', content: question.slice(0, 2_000) }],
      maxTokens: PLANNER.maxTokens,
      effort: PLANNER.effort,
      onUsage: u => onUsage(u, utility),
    });

    const queries = parsePlan(raw);
    if (queries.length === 0) {
      // Covers both a deliberate {"search": false} and a reply that could not be
      // parsed at all — worth telling apart, so the raw head goes in.
      logger.info({ userId, plan: raw.slice(0, 200) }, 'Feed search: planner returned no queries');
      return [];
    }

    const { hits, failed } = await searchFeed(userId, queries);
    logger.info({ userId, queries, failed, hits: hits.length }, 'Feed search');
    return hits;
  } catch (err) {
    logger.info({ err, userId }, 'Feed search failed');
    return [];
  }
}

// ── Threads ─────────────────────────────────────────────────────────────────

router.get('/threads', async (req: AuthRequest, res: Response): Promise<void> => {
  const threads = await prisma.researchThread.findMany({
    where: { userId: req.userId! },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  res.json({ threads: threads.map(toThreadJson) });
});

router.get('/threads/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const thread = await ownThread(req.userId!, req.params.id);
  if (!thread) { res.status(404).json({ error: 'Not found' }); return; }

  const messages = await prisma.researchMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ thread: toThreadJson(thread), messages: messages.map(toMessageJson) });
});

/**
 * Start a thread.
 *
 * Only the question is stored here — no model is called. The client then opens
 * the streaming reply endpoint, which is a separate request because a POST that
 * both creates a resource and holds an event stream open for two minutes is a
 * request you cannot retry: a dropped connection would leave the caller unable
 * to tell whether a thread was created.
 */
router.post('/threads', researchLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { question, url, refs } = req.body as Record<string, unknown>;
  if (typeof question !== 'string' || !question.trim()) {
    res.status(400).json({ error: 'What would you like to research?' });
    return;
  }
  if (question.length > MAX_QUESTION) {
    res.status(400).json({ error: 'That’s too long to start with — trim it down' });
    return;
  }

  const count = await prisma.researchThread.count({ where: { userId: req.userId! } });
  if (count >= MAX_THREADS) {
    res.status(400).json({ error: `You have ${MAX_THREADS} research threads. Delete some to start another.` });
    return;
  }

  // A thread started from an article carries the source so the conversation can
  // link back to what prompted it. The title comes from the article rather than
  // the question there, because "Research this" is not a title.
  let sourceUrl = '';
  let sourceTitle = '';
  if (isHttpUrl(url) && canonicalArticleKey(url)) {
    const ctx = await articleContextFor(url, req.userId!).catch(() => null);
    if (ctx) { sourceUrl = ctx.url; sourceTitle = ctx.title; }
  }

  // Articles the reader attached before sending. The thread's own source is
  // dropped from the list if it turns up there too — it is already the framing
  // for every turn, and rendering it twice in the opening question would spend
  // the article's whole length to say the same thing again.
  const references = (await resolveReferences(req.userId!, refs))
    .filter(r => r.url !== sourceUrl);

  try {
    const thread = await prisma.researchThread.create({
      data: {
        userId: req.userId!,
        title: sourceTitle || titleFromQuestion(question),
        sourceUrl,
        sourceTitle,
        // Stored now so "every explore about this article" is an indexed
        // lookup rather than a scan over sourceUrl. Empty for a thread started
        // from a bare question, which is exactly the set that never appears on
        // an article page.
        sourceKey: sourceUrl ? canonicalArticleKey(sourceUrl) : '',
        messages: {
          create: [{
            role: 'user',
            body: question.trim(),
            sources: references as unknown as Prisma.InputJsonValue,
          }],
        },
      },
    });
    const messages = await prisma.researchMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
    });
    res.status(201).json({ thread: toThreadJson(thread), messages: messages.map(toMessageJson) });
  } catch (err) {
    logger.error(err, 'Create research thread error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/threads/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const thread = await ownThread(req.userId!, req.params.id);
  if (!thread) { res.status(404).json({ error: 'Not found' }); return; }

  const { title, visibility } = req.body as Record<string, unknown>;

  // Both fields are optional, but a request that changes nothing is a mistake
  // worth reporting rather than a no-op to answer 200 to.
  const data: Prisma.ResearchThreadUpdateInput = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'Give it a title' });
      return;
    }
    data.title = title.trim().slice(0, 200);
  }

  if (visibility !== undefined) {
    if (!isThreadVisibility(visibility)) {
      res.status(400).json({ error: 'Not a visibility' });
      return;
    }
    // A thread with nothing in it has nothing to share, and an empty
    // conversation on an article page is worse than no entry at all.
    if (visibility !== 'private') {
      const answered = await prisma.researchMessage.count({
        where: { threadId: thread.id, role: 'assistant' },
      });
      if (answered === 0) {
        res.status(400).json({ error: 'Ask something first — there’s nothing to share yet.' });
        return;
      }
    }
    data.visibility = visibility;
    // Stamped the first time it leaves private and never moved again: this
    // orders the explored-paths list, and re-sharing a thread you briefly made
    // private should not jump it back to the top.
    if (visibility !== 'private' && !thread.sharedAt) data.sharedAt = new Date();
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const updated = await prisma.researchThread.update({
    where: { id: thread.id },
    // Renaming is not new activity, so updatedAt is left alone deliberately —
    // otherwise tidying up titles would reshuffle the whole sidebar.
    data,
  });
  res.json(toThreadJson(updated));
});

router.delete('/threads/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const thread = await ownThread(req.userId!, req.params.id);
  if (!thread) { res.status(404).json({ error: 'Not found' }); return; }
  await prisma.researchThread.delete({ where: { id: thread.id } });
  res.json({ ok: true });
});

// ── The conversation itself ─────────────────────────────────────────────────

/**
 * Rebuild the turns to send, with the article context folded into the opening
 * question rather than stored as a message of its own.
 *
 * Doing it at send time means the context is always the current state of the
 * article and its visible comments — a comment posted since the thread started
 * is included, and one that has since been deleted or hidden by a block is not.
 * Storing the rendered context as a row would have frozen a snapshot of other
 * people's words inside a private thread, which is not a thing to keep.
 *
 * The same applies to anything attached with /reference, with one addition:
 * those are rendered against the turn that attached them, and only once each.
 * A reader who references the same piece in three consecutive questions means
 * "still this one", not "send it three times".
 */
async function buildTurns(
  userId: string,
  thread: { id: string; sourceUrl: string },
): Promise<ChatTurn[]> {
  const rows = await prisma.researchMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'asc' },
  });

  if (rows.length === 0) return [];

  /**
   * Which referenced articles are worth a context lookup, walked newest-first.
   *
   * Newest-first because the ceiling has to fall on the articles the current
   * question is least likely to be about, and in a long thread that is the ones
   * attached longest ago. The thread's own source is excluded — it is rendered
   * separately below and would otherwise be sent twice.
   */
  const budget = new Set<string>();
  for (let i = rows.length - 1; i >= 0 && budget.size < MAX_CONTEXT_REFS; i--) {
    if (rows[i].role === 'assistant') continue;
    for (const ref of toSourcesJson(rows[i].sources)) {
      if (budget.size >= MAX_CONTEXT_REFS) break;
      if (ref.url === thread.sourceUrl) continue;
      budget.add(ref.url);
    }
  }

  const rendered = new Set<string>();
  let turns: ChatTurn[] = [];
  for (const row of rows) {
    const role: ChatTurn['role'] = row.role === 'assistant' ? 'assistant' : 'user';
    const blocks: string[] = [];
    if (role === 'user') {
      for (const ref of toSourcesJson(row.sources)) {
        if (!budget.has(ref.url) || rendered.has(ref.url)) continue;
        rendered.add(ref.url);
        const ctx = await articleContextFor(ref.url, userId).catch(() => null);
        if (ctx) blocks.push(renderContext(ctx));
      }
    }
    turns.push({
      role,
      content: blocks.length > 0 ? `${blocks.join('\n\n')}\n\n${row.body}` : row.body,
    });
  }

  if (thread.sourceUrl) {
    const ctx = await articleContextFor(thread.sourceUrl, userId).catch(() => null);
    if (ctx) {
      turns[0] = { role: 'user', content: `${renderContext(ctx)}\n\n${turns[0].content}` };
    }
  }

  if (turns.length > MAX_REPLAYED_TURNS) {
    // Keep the framing and the recent exchange, drop the middle, and say so —
    // silently omitting turns makes the model answer as if they never happened.
    //
    // A referenced article rendered into a dropped turn goes with it. That is
    // the right way round: the budget above is filled newest-first, so what
    // survives the trim is what the recent questions attached, and an article
    // that was only ever mentioned forty turns ago is not what the next answer
    // turns on.
    const head = turns.slice(0, 2);
    const tail = turns.slice(-(MAX_REPLAYED_TURNS - 3));
    turns = [
      ...head,
      { role: 'user', content: '[Earlier turns in this conversation have been omitted for length.]' },
      ...tail,
    ];
  }

  return turns;
}

/**
 * Ask for the next assistant turn, streamed.
 *
 * `question`, when present, is appended as a user turn first — so this one
 * endpoint serves both "answer the question I just typed" and "answer the
 * opening question of a thread that was created a moment ago".
 */
router.post('/threads/:id/messages', researchLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const thread = await ownThread(req.userId!, req.params.id);
  if (!thread) { res.status(404).json({ error: 'Not found' }); return; }

  const { question, credentialId, refs } = req.body as Record<string, unknown>;
  if (question !== undefined && question !== null) {
    if (typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'Type a question first' });
      return;
    }
    if (question.length > MAX_QUESTION) {
      res.status(400).json({ error: 'That message is too long' });
      return;
    }
  }

  let cred;
  try {
    cred = await resolveCredential(req.userId!, typeof credentialId === 'string' ? credentialId : null);
  } catch (err) {
    if (err instanceof LlmError) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }

  let userMessageId: string | null = null;
  let references: SourceJson[] = [];
  if (typeof question === 'string') {
    // Resolved and stored with the question, not with the answer: they are part
    // of what was asked, and buildTurns below reads them straight back off the
    // row it is about to replay.
    references = (await resolveReferences(req.userId!, refs))
      .filter(r => r.url !== thread.sourceUrl);
    const created = await prisma.researchMessage.create({
      data: {
        threadId: thread.id,
        role: 'user',
        body: question.trim(),
        sources: references as unknown as Prisma.InputJsonValue,
      },
    });
    userMessageId = created.id;
  }

  const turns = await buildTurns(req.userId!, thread);
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    res.status(400).json({ error: 'There’s nothing waiting for an answer' });
    return;
  }

  const prefs = await aiPrefs(req.userId!);
  const depth = researchDepth(prefs.depth);

  // Past this point the response is a stream, so failures are `error` events.
  const sse = openSse(res);
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  sse.send('meta', {
    userMessageId, model: cred.model, provider: cred.provider.id, depth: prefs.depth,
    // What was actually attached, which is not always what was asked for: a URL
    // this account has no record of resolves to nothing and is dropped. The
    // client draws its chips from this rather than from what it sent, so a
    // reference that didn't take stops claiming to be part of the question.
    references,
  });

  // Every call this turn makes, added up. The planner runs on the cheap model
  // and the answer on the chosen one, so they are priced separately and summed
  // — reporting only the second would under-state the turn.
  let spend = 0;
  const addUsage = (usage: Usage, model: string) => {
    const { usd } = estimateCost(cred.provider, model, usage);
    if (usd !== null) spend += usd;
  };

  // The question this turn is about, for the feed planner: what was just typed,
  // or the opening question when the thread has only just been created.
  const asked = typeof question === 'string' ? question : turns[turns.length - 1].content;

  const feedHits = await gatherFeedContext(req.userId!, cred, asked, prefs, addUsage);
  // Saved with the answer further down, so the citations are still there on a
  // thread opened weeks later. The search cannot be re-run to rebuild them: it
  // ranks a river that has moved on, and some of what was read has aged out of
  // the feed since.
  const sources: SourceJson[] = feedHits.map(h => ({
    title: h.title, url: h.url, source: h.source, pubDate: h.pubDate,
  }));
  if (feedHits.length > 0) {
    // Told to the client as it happens: a pause before the answer starts is
    // otherwise unexplained, and knowing which of your own articles were
    // consulted is most of what makes this trustworthy.
    sse.send('sources', { sources });
    // Appended to the *last* turn rather than the first: this is material for
    // the question being asked now, and next turn's search will find different
    // articles. Putting it in the cached opening turn would freeze one
    // question's search results into the whole conversation.
    const last = turns[turns.length - 1];
    turns[turns.length - 1] = { role: 'user', content: `${renderFeedContext(feedHits)}\n\n${last.content}` };
  }

  // The suggestion block is part of the same answer (see prompts.ts), so the
  // marker would flicker on screen as it streams. Holding back a tail the
  // length of the marker means the reader never sees a partial one: whatever is
  // released is already known not to be the start of it.
  const HOLD = SUGGESTION_MARKER.length;
  let full = '';
  let released = 0;

  const flush = (upTo: number) => {
    if (upTo <= released) return;
    sse.send('delta', { text: full.slice(released, upTo) });
    released = upTo;
  };

  try {
    await streamChat({
      provider: cred.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model: cred.model,
      system: researchSystemPrompt(thread.sourceUrl ? { title: thread.sourceTitle, url: thread.sourceUrl } : undefined)
        + depth.instruction,
      turns,
      maxTokens: depth.maxTokens,
      effort: depth.effort,
      // A thread re-sends its system prompt and the article it started from on
      // every follow-up. Caching those is the difference between paying for
      // them once and paying for them on every question.
      cache: true,
      onUsage: u => addUsage(u, cred.model),
      signal: abort.signal,
    }, (delta) => {
      full += delta;
      const marker = full.indexOf(SUGGESTION_MARKER);
      if (marker !== -1) { flush(marker); return; }
      flush(Math.max(0, full.length - HOLD));
    });
  } catch (err) {
    if (err instanceof LlmError) sse.send('error', { error: err.message });
    else {
      logger.error(err, 'Research stream error');
      sse.send('error', { error: 'Something went wrong asking your model.' });
    }
    sse.end();
    return;
  }

  const { body, suggestions } = splitSuggestions(full);
  flush(body.length);

  // An empty answer is not worth a row: it would sit in the thread forever
  // looking like the model said nothing, and block the next question, which
  // requires the last turn to be the user's.
  if (!body.trim()) {
    sse.send('error', { error: 'Your model returned an empty answer. Try asking again.' });
    sse.end();
    return;
  }

  try {
    const saved = await prisma.researchMessage.create({
      data: {
        threadId: thread.id,
        role: 'assistant',
        body,
        suggestions,
        // Prisma's InputJsonValue does not accept an array of named interfaces
        // without an index signature, and widening SourceJson to get one would
        // lose the typing everywhere else it is used. The value is plain data.
        sources: sources as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.researchThread.update({
      where: { id: thread.id },
      data: { updatedAt: new Date(), credentialId: cred.id },
    });
    sse.send('done', {
      message: toMessageJson(saved),
      // Null when the model isn't in the catalogue — a self-hosted endpoint has
      // no price list, and a made-up number would be worse than none.
      costUsd: prefs.showCost && spend > 0 ? spend : null,
    });
  } catch (err) {
    logger.error(err, 'Research message save error');
    // The answer is already on screen; say plainly that it won't be there
    // tomorrow rather than letting the reader assume it was kept.
    sse.send('error', { error: 'That answer could not be saved. Copy anything you need before leaving.' });
  }

  sse.end();
});

// ── Condense into a post ────────────────────────────────────────────────────

/**
 * Turn the thread into a draft post and hand back its id.
 *
 * The post is created rather than returned as a preview, and created
 * **private** — which is the same state every new post starts in. The author
 * lands in the composer with something to edit, and nothing is published by a
 * button that says "condense".
 */
router.post('/threads/:id/condense', researchLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const thread = await ownThread(req.userId!, req.params.id);
  if (!thread) { res.status(404).json({ error: 'Not found' }); return; }

  const messages = await prisma.researchMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'asc' },
  });
  if (!messages.some(m => m.role === 'assistant')) {
    res.status(400).json({ error: 'Ask something first — there’s no research to condense yet.' });
    return;
  }

  try {
    const cred = await resolveCredential(req.userId!, null);
    const depth = condenseDepth((await aiPrefs(req.userId!)).depth);

    const transcript = messages
      .map(m => `${m.role === 'assistant' ? 'Research' : 'Question'}: ${m.body}`)
      .join('\n\n---\n\n');

    const source = thread.sourceUrl
      ? `This research started from: ${thread.sourceTitle} (${thread.sourceUrl})\n\n`
      : '';

    const raw = await completeChat({
      provider: cred.provider,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      model: cred.model,
      system: CONDENSE_SYSTEM + depth.instruction,
      turns: [{ role: 'user', content: `${source}${transcript}` }],
      maxTokens: depth.maxTokens,
      effort: depth.effort,
    });

    const condensed = parseCondensed(raw);
    if (!condensed) {
      res.status(502).json({ error: 'Your model’s reply didn’t come back in a form Newt could read. Try again.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { username: true },
    });
    if (!user) { res.status(404).json({ error: 'Not found' }); return; }

    const taken = new Set(
      (await prisma.blogPost.findMany({ where: { userId: req.userId! }, select: { slug: true } }))
        .map(p => p.slug),
    );
    const title = condensed.title.slice(0, MAX_BLOG_TITLE);
    const slug = uniqueSlug(slugify(title), taken);
    const url = postUrlFor(user.username, slug);
    // Through the same sanitizer as a hand-written post. The markdown converter
    // escapes everything it doesn't recognise, so this is belt and braces
    // rather than the only guard — which is the right number of guards for
    // model output that becomes a public page.
    const body = sanitizeBlogHtml(markdownToHtml(condensed.body));

    const post = await prisma.blogPost.create({
      data: {
        userId: req.userId!,
        title,
        slug,
        body,
        excerpt: condensed.excerpt,
        heroImage: '',
        tags: normalizeTags(condensed.tags) ?? [],
        visibility: 'private',
        commentsEnabled: true,
        url,
        articleKey: canonicalArticleKey(url),
        publishedAt: new Date(),
      },
      select: { id: true, title: true, slug: true },
    });

    res.status(201).json({ post });
  } catch (err) {
    if (err instanceof LlmError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error(err, 'Research condense error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
