import prisma from '../prisma';
import logger from '../logger';
import { completeChat, Usage } from './chat';
import { resolveCredential } from './credentials';
import { PLANNER_SYSTEM, parsePlan } from './prompts';
import { searchFeed, hasFeeds, FeedHit } from './feedContext';
import { PLANNER, isDepth, Depth } from './depth';
import { utilityModelFor } from './providers';

/**
 * Deciding what of the reader's own feed an AI turn should be given.
 *
 * This lived in routes/research.ts until the composer wanted it too: asking for
 * angles on a post you are about to write has exactly the same problem an
 * Explore question does — the model cannot browse, and the material that would
 * actually help is sitting in the reader's own archive. Two callers is the
 * point at which it stops being a route's private helper.
 */

/** A resolved model credential — whatever resolveCredential hands back. */
export type Credential = Awaited<ReturnType<typeof resolveCredential>>;

export interface AiPrefs {
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
export async function aiPrefs(userId: string): Promise<AiPrefs> {
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
export async function gatherFeedContext(
  userId: string,
  cred: Credential,
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
