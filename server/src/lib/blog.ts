import { sanitizeRichHtml, commentTextLength } from './comments';
import { Visibility } from './commentVisibility';
import { normalizeImagePath } from './images';

// Pure helpers for blog posts. Kept free of Express and Prisma so they can be
// unit-tested directly, the way comments.ts / commentVisibility.ts are.
//
// Blog posts reuse the comment visibility vocabulary exactly ('public' |
// 'friends' | 'private'), because they are read through the same friendship
// rules — and because 'private' doubles as the draft state, publishing a post is
// just widening its visibility.

// A post body is long-form, so both caps are far larger than a comment's. The
// raw-HTML cap is the hard safety limit on payload size; the text cap bounds the
// readable content, since rich markup can be verbose while saying little.
export const MAX_BLOG_BODY = 200_000;
export const MAX_BLOG_TEXT = 50_000;
export const MAX_BLOG_TITLE = 200;

// How much of the slug the title is allowed to occupy.
const MAX_TITLE_SLUG = 60;
const DEFAULT_EXCERPT = 240;

export function sanitizeBlogHtml(html: string): string {
  return sanitizeRichHtml(html, MAX_BLOG_BODY);
}

// Length of the readable text in a post body — same measure comments use.
export function blogTextLength(html: string): number {
  return commentTextLength(html);
}

// The origin blog URLs are built from. CLIENT_ORIGIN is already required for
// CORS, so it is the natural default; PUBLIC_ORIGIN overrides it for deployments
// where the browser-facing origin differs from the CORS one.
export function publicOrigin(): string {
  const raw = process.env.PUBLIC_ORIGIN || process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  return raw.trim().replace(/\/+$/, '');
}

// "On rewriting my editor!" -> "on-rewriting-my-editor".
// Accents are folded to ASCII so a title in any Latin script still yields a
// readable, typeable URL; anything else collapses to separators.
//
// Deliberately no date suffix. The date never carried the uniqueness \u2014 that is
// the (userId, slug) unique index plus uniqueSlug() below \u2014 it only ever made
// the URL longer, and it made two clocks (the slug's and the byline's) that
// could disagree whenever an author's local date differed from UTC or a draft
// was published on a later day than it was started.
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip the diacritics NFKD split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TITLE_SLUG)
    .replace(/-+$/, '');               // slice may have left a trailing separator
  // A title of nothing but punctuation (or no title at all) still needs a slug
  return base || 'post';
}

// Two posts by the same author under the same title would collide on the
// (userId, slug) unique index, so later ones get a counter. `taken` is the set
// of slugs that author already uses.
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Practically unreachable — fall back to something certainly free
  return `${base}-${Date.now()}`;
}

export function postPathFor(username: string, slug: string): string {
  return `/u/${encodeURIComponent(username)}/${slug}`;
}

export function postUrlFor(username: string, slug: string): string {
  return `${publicOrigin()}${postPathFor(username, slug)}`;
}

// The profile a post hangs off — /u/<username>, the parent of postPathFor's
// path. Lives here beside it so the two spellings of a profile URL (this one
// and the one the follow route builds inline) can't drift apart.
export function profileUrlFor(username: string): string {
  return `${publicOrigin()}/u/${encodeURIComponent(username)}`;
}

// Plain-text summary for cards, search results and RSS descriptions. Cuts on a
// word boundary so the tail isn't a severed word.
export function excerptOf(html: string, max = DEFAULT_EXCERPT): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// A post's cover image is either nothing, or one of *our* uploaded images named
// by its site-relative path — the rule and the reasoning live in
// normalizeImagePath, which a profile's cover shares. Embedded body images get
// the equivalent treatment via sanitizeBlogHtml; this is for the one image that
// lives outside the HTML.
export const normalizeHeroImage = normalizeImagePath;

export interface VisiblePost {
  userId: string;
  visibility: string;
}

// Whether `viewerId` may read this post. `friendIds` is the *viewer's* accepted
// friends (friendIdsOf(viewerId)), so a friends-only post is readable when its
// author is among them. An undefined viewer is logged-out: public only.
export function canSeePost(
  post: VisiblePost,
  viewerId: string | undefined,
  friendIds: Set<string>,
): boolean {
  if (post.visibility === 'public') return true;
  if (!viewerId) return false;
  if (post.userId === viewerId) return true;     // authors always see their own
  if (post.visibility === 'friends') return friendIds.has(post.userId);
  return false;                                   // private, and not the author
}

// Prisma `where` fragment matching the posts a viewer may read, for listing
// endpoints. Mirrors canSeePost, and like visibilityWhere() in
// commentVisibility.ts it must never emit `{ userId: undefined }` — Prisma would
// treat that as "match every row".
export function visiblePostWhere(viewerId: string | undefined, friendIds: Set<string>) {
  const or: Record<string, unknown>[] = [{ visibility: 'public' }];
  if (viewerId) {
    or.push({ userId: viewerId });
    if (friendIds.size > 0) {
      or.push({ visibility: 'friends', userId: { in: [...friendIds] } });
    }
  }
  return { OR: or };
}

export function isBlogVisibility(v: unknown): v is Visibility {
  return v === 'public' || v === 'friends' || v === 'private';
}
