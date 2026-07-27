// ── Reposting ─────────────────────────────────────────────────────────
// Quoting an article or somebody's post inside a new post of your own.
//
// A repost is not a new kind of thing: it is an ordinary blog post that opens
// with a reference card - the same /reference embed the composer already knows
// how to render, resize, follow and count comments for. That is the whole
// design. Nothing downstream needs to learn about reposts, because there is
// nothing downstream to learn: the feed, the comment thread, the profile list
// and moderation all see a normal post, and the author can write as much or as
// little around the card as they like, or delete it and keep the words.
//
// The draft crosses to the composer through sessionStorage rather than the URL.
// An embed carries a title, a source and an image URL, which no query string
// wants to hold, and the composer is a standalone page (see App) reached with a
// real navigation - so the stash has to survive a document load, which is
// exactly what sessionStorage is for.

import { EmbedData, buildEmbedHtml } from './noteEmbed';

const KEY = 'newt:repost';

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

/** Stash `draft` and open the composer on it. */
export function startRepost(draft: RepostDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Private mode, or storage full. The composer still opens - empty rather
    // than seeded, which is a worse repost but not a broken one.
  }
  window.location.assign('/blog/new');
}

// The draft, once read. sessionStorage is emptied on that first read, so this
// is what makes takeRepost idempotent - and it has to be, because the composer
// reads it while rendering, and StrictMode renders twice and keeps only one of
// the two passes. A read that consumed the draft would hand it to the pass
// React throws away and seed the composer with nothing.
let pending: RepostDraft | null | undefined;

/**
 * The stashed draft, or null when there is none. The stash itself is emptied on
 * the first call; the answer is then held for the life of the page, so asking
 * twice during one render is safe.
 */
export function takeRepost(): RepostDraft | null {
  if (pending === undefined) pending = readStash();
  return pending;
}

/**
 * Let go of the draft, once a composer has opened on it. Reposting always
 * arrives by a real navigation, so the held copy only matters within this page
 * - and there it must not outlive the composer it seeded, or navigating back to
 * "New post" would reopen a repost the author already wrote.
 */
export function clearRepost(): void {
  // Back to "not read yet" rather than to null: the stash is empty by now, so
  // the next take re-reads it, finds nothing and returns null anyway.
  pending = undefined;
}

function readStash(): RepostDraft | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    // Same-origin, and only ever written by startRepost above - but it outlives
    // the page that wrote it, so a draft left by an older build is shape-checked
    // rather than trusted. Everything past this point goes through
    // buildEmbedHtml, which escapes the text and drops unsafe schemes, and then
    // through the server's allowlist on save.
    const draft = JSON.parse(raw) as Partial<RepostDraft>;
    const embed = draft?.embed;
    if (!embed || typeof embed.kind !== 'string' || typeof embed.url !== 'string') return null;
    return { embed, title: typeof draft.title === 'string' ? draft.title : '' };
  } catch {
    return null;
  }
}
