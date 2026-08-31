/**
 * Finding the same story on two different sites.
 *
 * The reader-facing result is a "Related coverage" line on an article page: if
 * site A and site B both wrote up Thursday's announcement, each page links to
 * the other. That mutuality is the point of the feature and the reason a pair
 * is stored as **one row with sorted keys** rather than two directed ones — see
 * ArticleRelation in schema.prisma.
 *
 * ── Why the candidate set is what it is ──
 *
 * Two sources, both deliberately narrow:
 *
 *   top sites    the most active feeds in the window. "Active" rather than
 *                "best" because there is no quality signal available here, and
 *                a site that published nothing in the window cannot be part of
 *                a pair anyway.
 *   top saved    articles people actually put in their reading lists. A weak
 *                signal, but the only one in the app that reflects a human
 *                finding something worth keeping.
 *
 * Bounded hard, because this is the one task that scales with the *feed* rather
 * than with user activity. A river of forty feeds produces hundreds of items a
 * day, and handing all of them to a model is both expensive and worse: the
 * longer the list, the more freely a model associates across it.
 *
 * ── Titles and snippets only ──
 *
 * No article text is fetched. Deciding that two pieces cover the same event is
 * a headline-level judgement, the snippets are already stored, and fetching a
 * hundred pages to answer it would be the most expensive thing in the app by an
 * order of magnitude.
 */

import prisma from '../prisma';
import logger from '../logger';
import { completeChat, LlmError } from '../llm/chat';
import { resolveSiteModel, recordUsage } from '../llm/siteModels';
import { systemPromptFor, readTrigger } from './tasks';
import { RELATE_PROMPT_DEFAULT, RELATE_FORMAT, parseRelations } from './prompts';
import { registerHandler, enqueue, enabledTasks } from './queue';
import { canonicalArticleKey, articleHost } from '../comments';

/**
 * The most candidates one run may consider.
 *
 * Not a cost ceiling so much as a quality one. Past roughly this many entries a
 * model stops discriminating and starts grouping by subject — "both are about
 * AI" — which is exactly the failure the prompt spends its length arguing
 * against. Two smaller runs find better pairs than one large one.
 */
const MAX_CANDIDATES = 60;
/** Enough for a headline judgement, short enough that sixty of them fit. */
const SNIPPET_CHARS = 200;
const RELATE_TOKENS = 2_000;

interface Candidate {
  key: string;
  url: string;
  title: string;
  host: string;
}

/**
 * What this run will look at.
 *
 * Deduped on canonical key, because the same article legitimately arrives twice
 * — once from its site's feed and once because somebody saved it — and relating
 * an article to itself is the one thing this must never do.
 */
async function gatherCandidates(input: {
  windowHours: number;
  topSites: number;
  topSaved: number;
}): Promise<Candidate[]> {
  const since = new Date(Date.now() - input.windowHours * 3600_000);
  const byKey = new Map<string, Candidate>();

  if (input.topSites > 0) {
    // The busiest hosts in the window, then their recent items. Grouping by
    // host rather than by feed: several feeds can belong to one site, and a
    // site with three feeds should not get three times the slots.
    const hosts = await prisma.feedItem.groupBy({
      by: ['linkHost'],
      where: { firstSeenAt: { gte: since }, linkHost: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { linkHost: 'desc' } },
      take: input.topSites,
    });

    // Per host rather than one flat query, so a single prolific site cannot
    // fill the whole candidate list and leave nothing to pair it with. A
    // cross-site feature whose input is all one site finds nothing by
    // construction.
    const perHost = Math.max(2, Math.floor(MAX_CANDIDATES / Math.max(1, hosts.length)));
    for (const h of hosts) {
      if (!h.linkHost) continue;
      const items = await prisma.feedItem.findMany({
        where: { linkHost: h.linkHost, firstSeenAt: { gte: since } },
        orderBy: { firstSeenAt: 'desc' },
        take: perHost,
        select: { link: true, linkKey: true, title: true, linkHost: true },
      });
      for (const it of items) {
        if (!byKey.has(it.linkKey) && it.title) {
          byKey.set(it.linkKey, {
            key: it.linkKey,
            url: it.link,
            title: it.title,
            host: it.linkHost ?? articleHost(it.link),
          });
        }
      }
    }
  }

  if (input.topSaved > 0) {
    // Most-saved in the window, by distinct savers. Counted the same way the
    // saves trigger counts, so "popular" means the same thing in both places.
    const saved = await prisma.readingListItem.groupBy({
      by: ['articleKey'],
      where: { savedAt: { gte: since }, articleKey: { not: '' } },
      _count: { _all: true },
      orderBy: { _count: { articleKey: 'desc' } },
      take: input.topSaved,
    });

    for (const row of saved) {
      // Nullable for reading-list rows written before articleKey existed; the
      // backfill fills them in, but a run must not throw on one it catches
      // mid-backfill.
      if (!row.articleKey || byKey.has(row.articleKey)) continue;
      const item = await prisma.readingListItem.findFirst({
        where: { articleKey: row.articleKey },
        orderBy: { savedAt: 'desc' },
        select: { url: true, title: true },
      });
      if (!item?.title) continue;
      byKey.set(row.articleKey, {
        key: row.articleKey,
        url: item.url,
        title: item.title,
        host: articleHost(item.url),
      });
    }
  }

  return [...byKey.values()].slice(0, MAX_CANDIDATES);
}

/** The numbered list the model is shown. Indexes are 1-based, as the prompt says. */
function renderCandidates(list: Candidate[], snippets: Map<string, string>): string {
  return list.map((c, i) => {
    const snip = snippets.get(c.key) ?? '';
    return `${i + 1}. [${c.host}] ${c.title}${snip ? `\n   ${snip}` : ''}`;
  }).join('\n');
}

export async function runRelateJob(job: { taskId: string }): Promise<{ note?: string; verdict?: string }> {
  const task = await prisma.aiTask.findUnique({
    where: { id: job.taskId },
    select: { prompt: true, siteModelId: true, label: true, trigger: true },
  });
  if (!task) return { note: 'task no longer exists' };

  const cfg = readTrigger(task.trigger);
  const candidates = await gatherCandidates({
    windowHours: cfg.relateWindowHours,
    topSites: cfg.relateTopSites,
    topSaved: cfg.relateTopSaved,
  });

  if (candidates.length < 2) {
    return { note: `only ${candidates.length} candidate article(s) in the window` };
  }

  const snippets = new Map<string, string>();
  const rows = await prisma.feedItem.findMany({
    where: { linkKey: { in: candidates.map(c => c.key) } },
    select: { linkKey: true, snippet: true },
  });
  for (const r of rows) {
    if (r.snippet && !snippets.has(r.linkKey)) {
      snippets.set(r.linkKey, r.snippet.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS));
    }
  }

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
      system: systemPromptFor(task.prompt, RELATE_PROMPT_DEFAULT) + RELATE_FORMAT,
      turns: [{ role: 'user', content: `<feed>\n${renderCandidates(candidates, snippets)}\n</feed>` }],
      maxTokens: RELATE_TOKENS,
      effort: 'low',
      onUsage: u => { usage = u; },
    });
    await recordUsage({
      siteModel: model, kind: 'relate', outcome: 'success', usage,
      durationMs: Date.now() - started, taskId: job.taskId, taskLabel: task.label,
    });
  } catch (err) {
    await recordUsage({
      siteModel: model, kind: 'relate', outcome: 'failed', usage,
      durationMs: Date.now() - started, taskId: job.taskId, taskLabel: task.label,
      error: err instanceof LlmError ? err.message : String(err),
    });
    throw err;
  }

  const groups = parseRelations(raw, candidates.length);
  // Genuinely the common answer, and the prompt asks for it: most runs over a
  // day of feed items find nothing covering the same story. Not a failure.
  if (groups.length === 0) {
    return { note: `no matches among ${candidates.length} articles`, verdict: 'none' };
  }

  let written = 0;
  let skippedSameSite = 0;

  for (const group of groups) {
    const members = group.items.map(n => candidates[n - 1]).filter(Boolean);
    // Every unordered pair within a group. A group of three is three links, and
    // storing it as a group instead would mean the article page could not ask
    // its question ("what relates to me") without unpacking one.
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (a.key === b.key) continue;
        if (cfg.relateCrossSiteOnly && a.host && a.host === b.host) {
          skippedSameSite++;
          continue;
        }

        // Sorted, so the pair has one representation and the unique constraint
        // means what it says. Both halves must be swapped together, which is
        // why this is one expression rather than six assignments.
        const [lo, hi] = a.key < b.key ? [a, b] : [b, a];
        try {
          await prisma.articleRelation.upsert({
            where: { keyA_keyB: { keyA: lo.key, keyB: hi.key } },
            // An existing pair keeps its original reason rather than being
            // rewritten every run: the first judgement is as good as the tenth,
            // and rewriting would churn createdAt out from under the ordering.
            update: {},
            create: {
              keyA: lo.key, keyB: hi.key,
              urlA: lo.url, urlB: hi.url,
              titleA: lo.title, titleB: hi.title,
              hostA: lo.host, hostB: hi.host,
              reason: group.reason,
              taskId: job.taskId,
            },
          });
          written++;
        } catch (err) {
          logger.warn({ err, a: lo.key, b: hi.key }, 'Could not store article relation');
        }
      }
    }
  }

  const note = [
    `${written} pair${written === 1 ? '' : 's'} from ${candidates.length} articles`,
    skippedSameSite > 0 ? `${skippedSameSite} same-site skipped` : '',
  ].filter(Boolean).join(', ');

  return { note, verdict: written > 0 ? 'related' : 'none' };
}

/**
 * Queue a relate run.
 *
 * No article key, so the queue's per-article dedupe does not apply — a relate
 * job is about the whole window rather than one piece — hence `force`. What
 * stops it piling up is the pass being scheduled rather than event-driven.
 */
export async function queueRelatePass(trigger: string): Promise<number> {
  const tasks = await enabledTasks('relate');
  let queued = 0;
  for (const task of tasks) {
    const { queued: ok } = await enqueue({
      taskId: task.id,
      trigger,
      articleKey: '',
      articleUrl: '',
      force: true,
    });
    if (ok) queued++;
  }
  return queued;
}

registerHandler('relate', async job => {
  logger.info({ jobId: job.id }, 'Running relate job');
  return runRelateJob(job);
});
