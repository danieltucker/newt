// Favorite tags - the topics you want to notice when they turn up.
//
// Tags in this app come from two places that agree on nothing. Feed items carry
// `categories: string[]` written by whoever publishes the feed ("Apple", "Apple
// Inc.", "apple-tv"), and reading-list items carry one comma-joined `tag` string
// the user typed. So a favorite can't be compared to a tag directly; both sides
// get normalized to tokens first.
//
// Why tokens and not `String.includes`: substring matching fails hardest on
// exactly the short tags people favorite first. "AI" appears inside Retail,
// Supply Chain, Air Travel, Email and Said; "art" inside Smart Home and Startup.
// Matching a *contiguous run of whole tokens* keeps everything the feature is
// for - favoriting "apple" still lights up "Apple News" and "apple-updates" -
// while Snapple and Retail stay dark.
//
// Everything here is pure and cheap. Callers memoize the prepared favorites and
// run the match over whatever is already on screen; see the note on
// `favoritesFor` about why this is decoration only.

/** A favorite prepared for matching. Keeps `label` for display. */
export interface PreparedFavorite {
  label: string;
  tokens: string[];
}

/**
 * Split a tag or favorite into lowercase word tokens.
 *
 * Punctuation and separators are boundaries, so "Apple Inc.", "apple-tv" and
 * "Apple/TV" all tokenize the way you'd read them aloud. Accents are folded, so
 * "Pokémon" and "Pokemon" are one tag - without that, NFD would leave a
 * combining mark mid-word and split it into "poke" + "mon".
 *
 * Letters and numbers are matched by Unicode property, not `a-z0-9`: a Cyrillic
 * or CJK tag has to survive tokenizing, or it would reduce to no tokens and be
 * silently unfavoritable.
 */
export function tagTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The canonical form of a tag, used to compare two favorites for sameness.
 * "Apple News", "apple-news" and "APPLE  NEWS" all share one key.
 */
export function tagKey(s: string): string {
  return tagTokens(s).join(' ');
}

/** Prepare a stored favorite list for matching. Blanks and duplicates drop out. */
export function prepareFavorites(favorites: string[]): PreparedFavorite[] {
  const seen = new Set<string>();
  const out: PreparedFavorite[] = [];
  for (const label of favorites) {
    const tokens = tagTokens(label);
    if (tokens.length === 0) continue;
    const key = tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, tokens });
  }
  return out;
}

/** Does `needle` appear as a contiguous run of whole tokens in `haystack`? */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer:
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Does this one tag match this one favorite?
 *
 * A favorite matches when its tokens appear in order and adjacent inside the
 * tag's tokens - so "machine learning" matches "Machine Learning Weekly" but
 * not "Learning Machines", and a favorite is never matched by a tag shorter
 * than itself.
 */
export function tagMatchesFavorite(tag: string, favorite: PreparedFavorite): boolean {
  return containsRun(tagTokens(tag), favorite.tokens);
}

/**
 * Which favorites do these tags hit?
 *
 * Returns the matching favorites' labels in the order they were favorited, so
 * a caller can say *which* interest fired rather than only that one did. Empty
 * means nothing matched - callers treat that as "render normally".
 *
 * This runs over the tags already on screen. It is deliberately not a way to
 * sort or count favorites across a feed: FolderArticles holds one server page
 * at a time, so anything beyond decorating visible rows needs the server to do
 * the matching instead.
 */
export function favoritesFor(tags: string[], favorites: PreparedFavorite[]): string[] {
  if (favorites.length === 0 || tags.length === 0) return [];
  const tokenized = tags.map(tagTokens);
  return favorites
    .filter(f => tokenized.some(t => containsRun(t, f.tokens)))
    .map(f => f.label);
}

/** Is this single tag one the user favorited? Drives the star on a tag chip. */
export function isFavoriteTag(tag: string, favorites: PreparedFavorite[]): boolean {
  const tokens = tagTokens(tag);
  return favorites.some(f => containsRun(tokens, f.tokens));
}

/**
 * Which stored favorites cover this tag - the exact one, and any broader one
 * that matches it ("Apple" covers the tag "Apple News").
 *
 * This is what a starred chip means, and it's why unstarring can't be a plain
 * exact-match removal: if "Apple" is favorited, the "Apple News" chip is starred
 * and clicking it has to remove "Apple", or the star wouldn't go out.
 */
export function coveringFavorites(favorites: string[], tag: string): string[] {
  const tokens = tagTokens(tag);
  if (tokens.length === 0) return [];
  return favorites.filter(f => {
    const ft = tagTokens(f);
    return ft.length > 0 && containsRun(tokens, ft);
  });
}

/**
 * Star or unstar a tag. Returns a new array.
 *
 * Unstarring drops every favorite covering the tag, so the star always goes
 * out. Starring appends the tag as typed - the label is what the settings list
 * shows, and "Apple TV+" should read back the way it was written.
 */
export function toggleFavorite(favorites: string[], tag: string): string[] {
  const covering = coveringFavorites(favorites, tag);
  if (covering.length > 0) {
    const drop = new Set(covering.map(tagKey));
    return favorites.filter(f => !drop.has(tagKey(f)));
  }
  const trimmed = tag.trim();
  return tagKey(trimmed) ? [...favorites, trimmed] : favorites;
}

/** Is an equivalent tag stored, ignoring broader ones? Used by the settings list. */
export function hasFavorite(favorites: string[], tag: string): boolean {
  const key = tagKey(tag);
  return key !== '' && favorites.some(f => tagKey(f) === key);
}
