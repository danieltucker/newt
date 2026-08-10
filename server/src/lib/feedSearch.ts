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
 * `a & b & c:*` — every term required, the last one matched as a prefix.
 *
 * The trailing `:*` is doing more work than autocomplete. Postgres stems before
 * it prefixes, and English stemming does not bring "closing" (→ `close`) and
 * "closure" (→ `closur`) together — so a headline about a school *closure*
 * genuinely does not match a search for *closing* on stems alone. `clos:*`
 * matches both, which is the behaviour a reader expects from a search box and
 * the reason the last term is never matched exactly.
 *
 * Only the last term gets it. Prefixing all of them would quietly turn a search
 * for "art" into one for "artifact" and "artillery" as well, and with AND
 * semantics across terms that noise compounds.
 *
 * Returns null when nothing survives — an empty tsquery matches every row in
 * some Postgres versions and no rows in others, and neither is an answer worth
 * serving.
 */
export function toTsQuery(raw: string): string | null {
  const parts = terms(raw);
  if (parts.length === 0) return null;
  const last = parts.length - 1;
  return parts.map((t, i) => (i === last ? `${t}:*` : t)).join(' & ');
}
