/**
 * /reference — the command that attaches an article to a question.
 *
 * Shared by the three boxes that accept it: the shell's search bar, where
 * picking an article carries it into Explore; Explore's own composer, where
 * picking one pins it to the question being typed; and the newt button's Ask
 * field, which is the composer in miniature. One parser rather than three,
 * because the thing being taught is a command the reader is expected to type in
 * any of them, and a prefix that works in one box and not the others is worse
 * than no prefix at all.
 *
 * /ref is the short form, for the same reason /br exists alongside /brave: the
 * long one is ten characters before the query starts.
 */

import { EmbedData, embedMatches } from './noteEmbed';

export const REFERENCE_PREFIXES = ['/reference', '/ref'];

/**
 * How many articles one question may carry. Matches the server's own ceiling —
 * see MAX_REFS in routes/research.ts, which is the one that actually binds.
 */
export const MAX_REFERENCES = 4;

/**
 * The query after the prefix, or null when this text isn't a /reference.
 *
 * An empty string is a real answer and distinct from null: "/reference" on its
 * own is the command with nothing typed after it yet, which callers show a
 * prompt for rather than treating as an ordinary search.
 */
export function referenceQuery(text: string): string | null {
  const raw = text.trimStart();
  for (const prefix of REFERENCE_PREFIXES) {
    if (raw.trimEnd() === prefix) return '';
    if (raw.startsWith(`${prefix} `)) return raw.slice(prefix.length).trim();
  }
  return null;
}

/** A /reference found at the end of a half-written question. */
export interface ReferenceCommand {
  /** What to search for. '' is the command typed with nothing after it yet. */
  query: string;
  /** The question without the command — what survives once one is picked. */
  rest: string;
}

/**
 * The /reference at the *end* of what has been typed, wherever it starts.
 *
 * referenceQuery above reads a box whose whole contents are the command, which
 * is what the search bar is: you type /reference, you pick, you leave. A
 * question box is the other shape entirely. "can you tell me what caused
 * /reference" is how anybody actually writes one — the thought comes first and
 * the citation is reached for partway through — and a parser that only looked
 * at character zero answered that with nothing at all, which reads as the
 * command being broken rather than as being in the wrong place.
 *
 * The command runs from its prefix to the end of the text, so everything after
 * it is the query and `rest` is the question it was appended to. Only the last
 * one counts: an earlier /reference in the same box has already been spent on
 * an article that is now a chip.
 *
 * The prefix has to stand alone as a word. "/refactor", "/references" and a URL
 * with /ref in its path are not this command, and answering any of them with an
 * article picker would be worse than doing nothing.
 */
export function referenceCommandAt(text: string): ReferenceCommand | null {
  let start = -1;
  let length = 0;
  for (const prefix of REFERENCE_PREFIXES) {
    let at = text.lastIndexOf(prefix);
    while (at >= 0) {
      if (at < start) break;   // a later prefix already won
      const end = at + prefix.length;
      const standsAlone =
        (at === 0 || /\s/.test(text[at - 1])) &&
        (end >= text.length || /\s/.test(text[end]));
      if (standsAlone) {
        if (at > start) { start = at; length = prefix.length; }
        break;                 // this prefix's last usable hit
      }
      // Walking back past index 0 has to be spelt out: lastIndexOf clamps a
      // negative fromIndex to 0 rather than giving up, so "at - 1" from here
      // would hand back the same match for ever.
      if (at === 0) break;
      at = text.lastIndexOf(prefix, at - 1);
    }
  }
  if (start < 0) return null;
  return {
    query: text.slice(start + length).trim(),
    rest: text.slice(0, start).trimEnd(),
  };
}

/** One article the picker is offering, in the shape every caller stores. */
export interface ReferenceItem {
  title: string;
  url: string;
  source: string;
}

/**
 * The articles a /reference picker should offer, from the two corpora a model
 * can actually read: what the reader has filed, and what their feeds carry.
 *
 * `references` is the library — saved articles and your own posts, matched the
 * same way the editor's picker matches them. `feedHits` is the river, already
 * searched and ranked by the server (see useFeedSearch), so it is taken in the
 * order given rather than re-sorted here.
 *
 * The library leads: a piece you went to the trouble of saving is the likelier
 * answer to "which one did I mean?" than one that merely went past. Anything
 * already attached is dropped rather than shown greyed — a row you cannot pick
 * is a row not worth the space in a list this short.
 *
 * An empty term returns nothing. It is a real state — "/reference" with nothing
 * typed after it — and callers prompt for a headline rather than dumping the
 * whole library into a six-row list.
 */
export function referenceSuggestions(
  term: string,
  references: readonly EmbedData[],
  feedHits: readonly ReferenceItem[],
  attached: readonly string[] = [],
  limit = 6,
): ReferenceItem[] {
  if (!term.trim()) return [];
  const out: ReferenceItem[] = [];
  const seen = new Set(attached);
  const add = (item: ReferenceItem) => {
    if (seen.has(item.url) || out.length >= limit) return;
    seen.add(item.url);
    out.push(item);
  };
  references
    .filter(r => embedMatches(r, term))
    .slice(0, 4)
    .forEach(r => add({ title: r.title, url: r.url, source: r.source }));
  feedHits.forEach(a => add({ title: a.title, url: a.url, source: a.source }));
  return out;
}
