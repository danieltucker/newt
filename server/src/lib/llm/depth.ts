/**
 * How much answer the reader wants, and what that costs.
 *
 * This exists because the first version of the AI features had one setting for
 * everything: a 16,000-token ceiling and whatever effort the model defaulted
 * to, which on a reasoning model means "think hard about everything". A few
 * research questions came to real money. None of that spend was chosen — it was
 * the default, and there was no dial.
 *
 * Three levels, and the differences are stacked deliberately so each one moves
 * the bill in the same direction:
 *
 *   effort       how hard the model thinks before answering. On the Claude
 *                models this is the single biggest lever, because thinking
 *                tokens are billed as output and output is the expensive half.
 *   maxTokens    the ceiling on thinking *and* answer together, so it bounds
 *                the worst case rather than the typical one.
 *   instruction  appended to the system prompt. Effort alone does not reliably
 *                shorten what the reader sees; asking does.
 *
 * `brief` is not a crippled mode. For "what is this thing" and "summarise this
 * article" it is the right answer, and the reader who wants an essay can pick
 * `thorough` for that one question.
 */

export type Depth = 'brief' | 'balanced' | 'thorough';

export const DEPTHS: Depth[] = ['brief', 'balanced', 'thorough'];

export function isDepth(v: unknown): v is Depth {
  return typeof v === 'string' && (DEPTHS as string[]).includes(v);
}

export interface DepthConfig {
  /** Anthropic's output_config.effort. Ignored by the OpenAI wire, which has no equivalent. */
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  instruction: string;
}

const RESEARCH: Record<Depth, DepthConfig> = {
  brief: {
    effort: 'low',
    maxTokens: 1_500,
    instruction:
      '\n\nLength: keep this short. A few sentences for a factual question, three short paragraphs at the very most. ' +
      'Lead with the answer. Leave out background the reader did not ask for, and do not restate the question.',
  },
  balanced: {
    effort: 'medium',
    maxTokens: 4_000,
    instruction:
      '\n\nLength: match the question. A factual one gets a short answer; an open one gets a few paragraphs. ' +
      'Do not pad, and do not use headings unless the answer genuinely has sections.',
  },
  thorough: {
    effort: 'high',
    maxTokens: 12_000,
    instruction:
      '\n\nLength: take the space this needs. The reader has asked for depth, so cover the ground properly — ' +
      'but length still has to be earned, not filled.',
  },
};

/**
 * Condensing has its own ladder, shifted up.
 *
 * A post is a deliverable rather than a reply, and `brief` here means a short
 * post, not a truncated one — the floor has to leave room to finish a piece of
 * writing. The effort levels match research so the setting still means
 * something consistent.
 */
const CONDENSE: Record<Depth, DepthConfig> = {
  brief:     { effort: 'low',    maxTokens: 3_000,  instruction: '\n\nKeep the post tight: a few hundred words, no filler sections.' },
  balanced:  { effort: 'medium', maxTokens: 6_000,  instruction: '' },
  thorough:  { effort: 'high',   maxTokens: 12_000, instruction: '\n\nA full-length piece is fine here if the research supports one.' },
};

export function researchDepth(depth: Depth): DepthConfig {
  return RESEARCH[depth];
}

export function condenseDepth(depth: Depth): DepthConfig {
  return CONDENSE[depth];
}

/**
 * Proofreading does not take a depth.
 *
 * It is a mechanical pass over a fixed text, it runs on the cheap utility model
 * (see utilityModelFor), and the output is a bounded list rather than prose —
 * so there is nothing for a depth setting to trade off. A fixed, generous
 * ceiling is the whole configuration it needs.
 */
export const PROOFREAD: DepthConfig = {
  effort: 'low',
  maxTokens: 6_000,
  instruction: '',
};

/**
 * Planning a post: a bounded list, on the author's chosen model.
 *
 * No depth either, for the opposite reason to proofreading. This one is a
 * judgement call rather than a mechanical pass — telling a real angle from
 * "explore the implications" is the whole job — so it runs on the model the
 * account picked rather than the cheap utility one. What bounds the cost
 * instead is the shape of the output: three to five angles and a handful of
 * questions is a page, however much material went in, and a ceiling low enough
 * to make writing the post outright impossible is a feature here.
 */
export const IDEAS: DepthConfig = {
  effort: 'medium',
  maxTokens: 3_000,
  instruction: '',
};

/**
 * Screening the articles Ideas found: a yes or a no on each, and one line why.
 *
 * On the utility model and a small budget, like the planner, because it is a
 * filter rather than an answer — but roomier than PLANNER's 300, since this one
 * has to read eight snippets before it decides and then write a line about each
 * of the ones it keeps.
 */
export const RELEVANCE: DepthConfig = {
  effort: 'low',
  maxTokens: 1_000,
  instruction: '',
};

/**
 * Working out what to search the feed for: one short list of search terms.
 *
 * The tightest budget in the file, because this is a routing decision and not
 * an answer. If a model cannot say "iOS 27, Apple" in 300 tokens, more tokens
 * will not help it.
 */
export const PLANNER: DepthConfig = {
  effort: 'low',
  maxTokens: 300,
  instruction: '',
};
