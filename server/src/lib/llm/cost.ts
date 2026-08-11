import { Provider, modelOption } from './providers';
import { Usage } from './chat';

/**
 * Turning token counts into money.
 *
 * The point is not accounting — the provider does that, and its invoice is the
 * only number that settles anything. The point is that a reader can see what a
 * question cost *at the moment they ask it*, while the choice of model and
 * depth is still in front of them. A dial with no readout is a dial nobody
 * turns.
 *
 * Everything here is therefore explicitly approximate, and the UI says so.
 */

export interface CostEstimate {
  /** US dollars. Null when the model isn't in the catalogue, so nothing is guessed. */
  usd: number | null;
  usage: Usage;
}

/**
 * Cache reads are charged at roughly a tenth of the input rate, and cache
 * writes at roughly 1.25x. Both are ratios rather than per-model prices
 * because that is how the providers express them, and it means adding a model
 * to the catalogue does not mean adding four more numbers to keep current.
 */
const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_RATIO = 1.25;

export function estimateCost(provider: Provider, model: string, usage: Usage): CostEstimate {
  const option = modelOption(provider, model);
  // A self-hosted endpoint has no price list and is usually free at the point
  // of use, and an unrecognised hosted model has a price Newt does not know.
  // Both are "no estimate" rather than "zero" — claiming a question was free
  // when it might not have been is the one wrong answer here.
  if (!option) return { usd: null, usage };

  const perToken = (perMillion: number) => perMillion / 1_000_000;

  const usd =
    usage.input * perToken(option.inputPer1M) +
    usage.cacheRead * perToken(option.inputPer1M) * CACHE_READ_RATIO +
    usage.cacheWrite * perToken(option.inputPer1M) * CACHE_WRITE_RATIO +
    usage.output * perToken(option.outputPer1M);

  return { usd, usage };
}

/**
 * How a cost reads on screen.
 *
 * Sub-cent answers are the common case and "$0.00" would be a lie of
 * rounding — it reads as free, and a hundred free-looking questions are how
 * someone ends up surprised. So anything under a cent says so as an inequality
 * instead.
 */
export function formatCost(usd: number | null): string | null {
  if (usd === null) return null;
  if (usd <= 0) return null;
  if (usd < 0.01) return 'under $0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}
