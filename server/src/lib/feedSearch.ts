/**
 * Turning what someone typed into a Postgres tsquery.
 *
 * The search box is an as-you-type box, so this has two jobs that pull in
 * opposite directions: be forgiving enough that a half-typed word finds the
 * article, and strict enough that a query is never able to mean anything in SQL.
 * The strictness comes first — every token is rebuilt from scratch out of
 * letters and digits, so no tsquery operator (`&`, `|`, `!`, `<->`, parentheses)
 * can survive from the input, whatever the user pasted in. The result is then
 * still passed as a bound parameter; this is the belt, not the braces.
 */

/** Terms past this add nothing and cost a GIN lookup each. */
const MAX_TERMS = 8;
/** Longer than any real word; a 900-character "term" is a paste accident. */
const MAX_TERM_LEN = 40;
/** Below this, a prefix search matches most of the corpus and means nothing. */
export const MIN_QUERY_LEN = 2;

/**
 * Splits on everything that isn't a letter or a digit, in any alphabet —
 * `\p{L}` rather than `a-z` so accented and non-Latin words survive as words
 * instead of being minced into fragments.
 *
 * Apostrophes are dropped rather than kept: "council's" becomes "councils",
 * which is what the English stemmer reduces the possessive to anyway.
 */
export function terms(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(t => t.slice(0, MAX_TERM_LEN))
    .slice(0, MAX_TERMS);
}

/**
 * Below this a prefix is too blunt to widen anything: `ai:*` picks up aid, aim
 * and air, and in `any` mode there is no second term to filter that back out.
 */
const MIN_PREFIX_LEN = 3;

/**
 * Which way the terms are joined.
 *
 * `all` — `a & b & c:*`. Every term required. This is the search box, where the
 * reader is typing and watching the list narrow: they see each keystroke's
 * effect and stop when it looks right, so precision is what they want and a
 * query that is briefly too narrow costs nothing.
 *
 * `any` — `a:* | b:* | c:*`. Any term will do, ranking sorts the rest out. This
 * is for a caller that gets one shot and no feedback — the feed search the
 * research planner runs. AND is close to unusable there: `searchVector` is built
 * from title and snippet only (see the 20260810160000 migration), so a document
 * is around forty words, and the odds of a planner's three or four terms all
 * landing inside forty words are slim enough that the honest answer is almost
 * always "no articles". OR over the same terms, ordered by `ts_rank`, gets the
 * right article to the top and lets the caller cut the tail off with a LIMIT.
 */
export type TsQueryMode = 'all' | 'any';

/**
 * Build a tsquery, joined per `mode`.
 *
 * The trailing `:*` is doing more work than autocomplete. Postgres stems before
 * it prefixes, and English stemming does not bring "closing" (→ `close`) and
 * "closure" (→ `closur`) together — so a headline about a school *closure*
 * genuinely does not match a search for *closing* on stems alone. `clos:*`
 * matches both, which is the behaviour a reader expects from a search box and
 * the reason the last term is never matched exactly.
 *
 * In `all` mode only the last term gets it. Prefixing all of them would quietly
 * turn a search for "art" into one for "artifact" and "artillery" as well, and
 * with AND semantics across terms that noise compounds. In `any` mode there is
 * nothing to compound — a loose term contributes a low-ranking row rather than
 * dragging the whole query sideways — so every term long enough to mean
 * something is prefixed, and the stemming gap above closes on all of them
 * instead of just the last.
 *
 * Returns null when nothing survives — an empty tsquery matches every row in
 * some Postgres versions and no rows in others, and neither is an answer worth
 * serving.
 */
export function toTsQuery(raw: string, mode: TsQueryMode = 'all'): string | null {
  const parts = terms(raw);
  if (parts.length === 0) return null;

  if (mode === 'any') {
    return parts
      .map(t => (t.length >= MIN_PREFIX_LEN ? `${t}:*` : t))
      .join(' | ');
  }

  const last = parts.length - 1;
  return parts.map((t, i) => (i === last ? `${t}:*` : t)).join(' & ');
}
