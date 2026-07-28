// ── Seeding the composer ──────────────────────────────────────────────
// Opening the post composer with something already in it. Two things do this,
// and they are the same operation underneath:
//
//   - A **repost**: quoting an article, or somebody's post, inside a post of
//     your own. A repost is not a new kind of thing - it is an ordinary post
//     that opens with a reference card, the same /reference embed the composer
//     already knows how to render, resize, follow and count comments for. That
//     is the whole design. Nothing downstream needs to learn about reposts,
//     because there is nothing to learn: the feed, the comment thread, the
//     profile list and moderation all see a normal post, and the author can
//     write as much or as little around the card as they like, or delete it and
//     keep the words.
//
//   - A **note**, turned into a post. Notes and posts are already the same
//     markup from the same editor, so this carries the note's body across
//     verbatim and leaves the author in the composer to decide what it needs
//     before anyone else sees it. The note is not consumed: publishing a
//     thought is not a reason to lose the notebook it was worked out in.
//
// Both arrive as the same pair - a title and a body - because that is the whole
// of what the composer can be opened on.
//
// The seed crosses through sessionStorage rather than the URL. A post body is
// far larger than a query string wants to hold, and a repost is started by a
// real navigation from wherever the reader happened to be, so the stash has to
// survive a document load. That is exactly what sessionStorage is for.

import { EmbedData, buildEmbedHtml } from './noteEmbed';

const KEY = 'newt:compose';

/** What the composer opens on: a title for its field, HTML for its body. */
export interface ComposerSeed {
  title: string;
  body: string;
}

export interface RepostDraft {
  embed: EmbedData;
  /** Seeds the composer's title field. The author's to change before saving. */
  title: string;
}

/** The body a repost opens on: the card, then an empty line to write in. */
export function repostBody(embed: EmbedData): string {
  // Large, because the reference *is* the post at this point - it is what the
  // reader came for, and the author's words go around it. <p>-wrapped because
  // an embed is inline-only markup (see noteEmbed) and needs a block to sit in.
  return `<p>${buildEmbedHtml(embed, 'large')}</p><p><br></p>`;
}

/**
 * Hand the composer a seed without navigating, for callers that route to
 * /blog/new themselves - the notes console is inside the app shell and can get
 * there without a document load.
 */
export function stashSeed(seed: ComposerSeed): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(seed));
  } catch {
    // Private mode, or storage full. The composer still opens - empty rather
    // than seeded, which is a worse repost but not a broken one.
  }
}

/** Stash `draft` as a repost and open the composer on it. */
export function startRepost(draft: RepostDraft): void {
  stashSeed({ title: draft.title, body: repostBody(draft.embed) });
  window.location.assign('/blog/new');
}

// The seed, once read. sessionStorage is emptied on that first read, so this is
// what makes takeSeed idempotent - and it has to be, because the composer reads
// it while rendering, and StrictMode renders twice and keeps only one of the two
// passes. A read that consumed the seed would hand it to the pass React throws
// away and seed the composer with nothing.
let pending: ComposerSeed | null | undefined;

/**
 * The stashed seed, or null when there is none. The stash itself is emptied on
 * the first call; the answer is then held for the life of the page, so asking
 * twice during one render is safe.
 */
export function takeSeed(): ComposerSeed | null {
  if (pending === undefined) pending = readStash();
  return pending;
}

/**
 * Let go of the seed, once a composer has opened on it. It must not outlive the
 * composer it seeded, or navigating back to "New post" would reopen a draft the
 * author already wrote.
 */
export function clearSeed(): void {
  // Back to "not read yet" rather than to null: the stash is empty by now, so
  // the next take re-reads it, finds nothing and returns null anyway.
  pending = undefined;
}

function readStash(): ComposerSeed | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    // Same-origin, and only ever written by the two functions above - but it
    // outlives the page that wrote it, so a seed left by an older build is
    // shape-checked rather than trusted.
    //
    // The body reaches RichEditor as innerHTML, which is the same trust this app
    // already extends to a note's own stored markup, and it goes through the
    // server's allowlist on save. Writing this stash at all requires script
    // running on our origin, so it grants nothing that isn't already lost.
    const seed = JSON.parse(raw) as Partial<ComposerSeed>;
    if (typeof seed?.title !== 'string' || typeof seed?.body !== 'string') return null;
    return { title: seed.title, body: seed.body };
  } catch {
    return null;
  }
}
