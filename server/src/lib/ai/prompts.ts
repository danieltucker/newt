/**
 * The default prompts for the two task kinds, and the parsers for what comes
 * back.
 *
 * "Default" is the operative word: every one of these is overridable by the
 * admin in Admin → AI, and what ships here is a starting point rather than the
 * contract. The contract is the *output shape*, which the parsers below enforce
 * and the prompt merely requests — the same split prompts.ts has always had,
 * for the same reason: "reply with only JSON" is not a guarantee.
 */

import { jsonValues } from '../llm/jsonReply';

// ── Auto-explore ────────────────────────────────────────────────────────────

/**
 * Where an article could be taken next, written as a thread rather than a
 * comment.
 *
 * This is what the persona "angles" card became. The output is not a comment
 * under a name, it is the opening of a ResearchThread that lands in the
 * article's Explored paths section — which already existed, is already indexed
 * by sourceKey, and already carries the visibility vocabulary this needs.
 *
 * The instruction doing the most work is the specificity one, carried over in
 * spirit from the old ANGLES_TASK: a model asked for questions about an article
 * returns "what are the broader implications of this?" for any article ever
 * written, and a page of those is worse than an empty section — it costs a
 * generation and teaches readers the section is noise.
 */
export const EXPLORE_PROMPT_DEFAULT = (
  `You are opening a short research thread about an article, for readers of a personal reading app.\n\n` +
  `You are not reviewing the article and not summarising it. Assume the reader has just read it. ` +
  `Your job is to lay out where it could be taken next: what it raises and does not settle, what in it ` +
  `is easy to misread, and what follows from it that it does not draw out itself.\n\n` +
  `Every point must be specific to THIS article. If the same sentence would fit any piece on the ` +
  `subject, it is not worth making. Two sharp points beat five vague ones.\n\n` +
  `Write short prose in markdown, a few paragraphs, no headings. Then finish with two to four open ` +
  `questions as a bulleted list under the exact line "## Worth asking".`
);

/**
 * A title for the generated thread.
 *
 * A separate call rather than JSON wrapped around the body, because the body is
 * markdown prose of several paragraphs and putting that inside a JSON string
 * means every newline and quote in it has to survive escaping by a model that is
 * bad at exactly that. The same reasoning that split the old POST_TASK's
 * `TITLE:` prefix off from its body.
 */
export const EXPLORE_TITLE_PROMPT = (
  `Give a short title for a research thread about the article below. Six words at most, no quotes, no ` +
  `trailing punctuation. Name the specific subject rather than the format: ` +
  `"Edge caching and the latency claim", never "Exploring an article". ` +
  `Reply with the title and nothing else.`
);

/** One line, cleaned of the ways a model likes to decorate a title. */
export function cleanTitle(raw: string, fallback: string): string {
  const line = raw.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const stripped = line
    .replace(/^(title|heading)\s*:\s*/i, '')
    .replace(/^[''"“”‘’]+/, '')
    .replace(/[''"“”‘’]+$/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
  return stripped.slice(0, 120) || fallback.slice(0, 120);
}

// ── Moderation ──────────────────────────────────────────────────────────────

/**
 * The three verdicts, and the reason there is no fourth.
 *
 * There is deliberately no `delete`. A small local model *will* produce false
 * positives, and a wrongly deleted comment is unrecoverable — the author's
 * writing is gone and their trust with it, which on an instance this size is
 * most of the community. `hide` is the strongest automated action, it is
 * reversible, and it leaves the row for a human to look at.
 *
 * Bans are likewise not here. The strongest thing a run can do to an *account*
 * is flag it for a moderator to read.
 */
export type Verdict = 'allow' | 'review' | 'hide';

export const VERDICTS: Verdict[] = ['allow', 'review', 'hide'];

export const MODERATE_PROMPT_DEFAULT = (
  `You are screening comments on a small personal reading community. Most comments are ordinary and ` +
  `your answer for them is "allow" — you are looking for the few that are not.\n\n` +
  `Judge the comment, never the person, and never the opinion. Disagreement, bluntness, strong ` +
  `criticism of an article or of a public figure, swearing, and being plainly wrong are all "allow". ` +
  `What you are looking for is abuse aimed at another commenter, slurs, threats, sexual content ` +
  `involving minors, doxxing, and spam or advertising.\n\n` +
  `- "allow": ordinary, whatever you think of it.\n` +
  `- "review": you are genuinely unsure, or it is borderline enough that a person should look.\n` +
  `- "hide": clearly one of the categories above. Use this sparingly.\n\n` +
  `When you are between two verdicts, choose the milder one. A wrongly hidden comment costs more than ` +
  `a wrongly allowed one that a person then reads.`
);

/** What the screen asks for back, appended after the admin's prompt and the floor. */
export const MODERATE_FORMAT = (
  `\n\nReply with a single JSON object and nothing else:\n` +
  `{"verdict": "allow", "category": "", "confidence": 0.9, "reason": "…one short sentence…"}\n` +
  `- verdict: exactly one of "allow", "review", "hide".\n` +
  `- category: one of "abuse", "slur", "threat", "sexual", "doxx", "spam", or "" for allow.\n` +
  `- confidence: a number from 0 to 1.\n` +
  `- reason: one sentence a moderator will read. Quote the part you are reacting to.`
);

export interface Screening {
  verdict: Verdict;
  category: string;
  confidence: number;
  reason: string;
}

const CATEGORIES = new Set(['abuse', 'slur', 'threat', 'sexual', 'doxx', 'spam', '']);

/**
 * Read a screening reply.
 *
 * Returns null rather than a default when the reply cannot be read, and the
 * caller records that as a *failed* job. The alternative — defaulting to
 * "allow" — would make an endpoint that is down indistinguishable from one that
 * approved everything, which is the single confusion a moderation log must not
 * contain.
 */
export function parseScreening(raw: string): Screening | null {
  for (const value of jsonValues(raw, '{')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const o = value as Record<string, unknown>;
    const verdict = typeof o.verdict === 'string' ? o.verdict.trim().toLowerCase() : '';
    if (!(VERDICTS as string[]).includes(verdict)) continue;

    const category = typeof o.category === 'string' ? o.category.trim().toLowerCase() : '';
    const rawConf = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence);
    return {
      verdict: verdict as Verdict,
      // An unrecognised category becomes empty rather than failing the row: the
      // verdict is the part that acts, the category only files it.
      category: CATEGORIES.has(category) ? category : '',
      // Missing or nonsense confidence reads as 0, which sorts to the top of a
      // queue ordered by certainty — an unscored row should be looked at, not
      // quietly treated as a sure thing.
      confidence: Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0,
      reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 400) : '',
    };
  }
  return null;
}

// ── Relating articles across sites ──────────────────────────────────────────

/**
 * Grouping recent articles by the story they cover.
 *
 * The whole value is **cross-site**: two outlets writing up the same thing, and
 * a reader on either page getting the other. So the instruction that does the
 * most work is the negative one — most pairs of articles in a feed are not
 * about the same story, they are merely on the same *subject*, and a model
 * asked to find connections will happily return "both are about AI".
 *
 * Numbered input rather than URLs, for the reason parseRelevance uses numbers:
 * a model asked to echo a URL will normalise, truncate or invent one, and the
 * caller has the real list indexed anyway.
 */
export const RELATE_PROMPT_DEFAULT = (
  `You are given a numbered list of recent news articles from different sites. Find the ones that cover ` +
  `THE SAME STORY as each other — the same event, announcement, paper, incident or decision.

` +
  `This is a high bar and most articles will match nothing. Two articles about the same *topic* are not ` +
  `the same story: two pieces about AI regulation are unrelated unless they are about the same bill. ` +
  `Two reviews of different phones are unrelated. Return nothing rather than reaching — an empty answer ` +
  `is correct and useful, a list of loose associations is neither.

` +
  `Group only articles that a reader who had just finished one would genuinely want the other of.`
);

/** The output shape, appended after the admin's prompt and the safety floor. */
export const RELATE_FORMAT = (
  `

Reply with a single JSON object and nothing else:
` +
  `{"groups": [{"items": [1, 4], "reason": "…one short line naming the shared story…"}]}
` +
  `- items: two or more numbers from the list above. Never a number you were not given.
` +
  `- reason: what the shared story actually is, in one line a reader will see. Name it — ` +
  `"both cover Thursday's EU AI Act vote", not "both are related".
` +
  `Return {"groups": []} when nothing genuinely matches.`
);

export interface RelationGroup {
  /** Indexes into the candidate list the caller supplied, 1-based as shown. */
  items: number[];
  reason: string;
}

/**
 * Read the grouping reply.
 *
 * Bounds every number against `count` rather than trusting the model, because
 * an out-of-range index would either throw or — worse — silently relate the
 * wrong two articles. Groups that lose too many members to that check are
 * dropped: a "group" of one is not a relation.
 */
export function parseRelations(raw: string, count: number): RelationGroup[] {
  for (const value of jsonValues(raw, '{')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const groups = (value as Record<string, unknown>).groups;
    if (!Array.isArray(groups)) continue;

    const out: RelationGroup[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const row = g as Record<string, unknown>;
      const items = Array.isArray(row.items) ? row.items : [];

      const seen = new Set<number>();
      for (const raw of items) {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= count) seen.add(n);
      }
      // Two is the minimum that means anything. A model that returned one valid
      // index and three invented ones has not found a pair.
      if (seen.size < 2) continue;

      out.push({
        items: [...seen].sort((a, b) => a - b),
        reason: typeof row.reason === 'string' ? row.reason.trim().slice(0, 300) : '',
      });
      if (out.length >= 20) break;
    }
    if (out.length > 0) return out;
    // An explicit empty list is a real answer — "nothing matches" is what this
    // prompt asks for most of the time — so stop rather than reading on into
    // some other object further down the reply.
    return [];
  }
  return [];
}
