import prisma from '../prisma';
import { canonicalArticleKey } from '../comments';
import { visibilityWhere } from '../commentVisibility';
import { friendIdsOf } from '../friends';
import { blockWallOf, notWalledWhere } from '../blocks';

/**
 * Gathering what Newt already knows about a URL, so a question about "this
 * article" can actually be about it.
 *
 * Everything here comes out of the database. Nothing fetches the page: the
 * article body is whatever the feed dealt (FeedItem.content, sanitized on the
 * way in) or the post as written. That means the answer is grounded in the same
 * text the reader is looking at, and it means asking a question can never be
 * turned into a request to an arbitrary URL — the /research and /ask routes make
 * no outbound calls except to the user's own model.
 */

/** Roughly four characters to a token; this budget is about 12k tokens of article. */
const MAX_ARTICLE_CHARS = 48_000;
/** Comments are supporting material, not the subject. */
const MAX_COMMENT_CHARS = 12_000;
const MAX_COMMENTS = 40;

export interface ArticleContext {
  title: string;
  url: string;
  /** Plain text, ready to drop into a prompt. Empty when nothing was stored. */
  text: string;
  comments: { author: string; body: string }[];
}

/**
 * HTML to something a model reads well.
 *
 * Not a sanitizer — the stored HTML was sanitized when it was written. This
 * strips markup because tags are tokens the reader is paying for and the model
 * gains nothing from them, and it keeps block boundaries as newlines so
 * paragraphs and list items don't run together into one wall of prose.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  // Cut at a paragraph break near the limit if there is one, so the excerpt
  // ends on a complete thought rather than mid-sentence.
  const head = text.slice(0, max);
  const lastBreak = head.lastIndexOf('\n\n');
  const body = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return `${body.trim()}\n\n[…the rest of this article was too long to include…]`;
}

/**
 * Everything readable about one URL, for this viewer.
 *
 * Comments are filtered through exactly the same visibility rule the comment
 * panel uses — the viewer's own, public ones if they haven't opted out, and
 * friends-only ones from actual friends — and blocked users are dropped. A
 * model must not be able to see a comment its reader cannot: it would be a
 * disclosure channel wearing a summary as a disguise.
 *
 * Returns null when the URL isn't one Newt has any record of.
 */
export async function articleContextFor(url: string, userId: string): Promise<ArticleContext | null> {
  const key = canonicalArticleKey(url);
  if (!key) return null;

  let title = '';
  let text = '';

  // A post written here beats a feed copy of the same URL: it is the original,
  // and the feed copy may be a truncated summary of it.
  const post = await prisma.blogPost.findUnique({
    where: { articleKey: key },
    select: { title: true, body: true, excerpt: true, visibility: true, userId: true },
  });

  if (post) {
    const readable =
      post.userId === userId ||
      post.visibility === 'public' ||
      (post.visibility === 'friends' && (await friendIdsOf(userId)).has(post.userId));
    if (!readable) return null;
    title = post.title;
    text = htmlToText(post.body) || post.excerpt;
  } else {
    const item = await prisma.feedItem.findFirst({
      where: { linkKey: key },
      orderBy: { fetchedAt: 'desc' },
      select: { title: true, content: true, snippet: true },
    });
    if (item) {
      title = item.title;
      text = htmlToText(item.content || '') || (item.snippet ?? '');
    }
  }

  // The reading list is the last resort: it holds a title and the reader's own
  // notes even for an article whose body was never captured.
  if (!title) {
    const saved = await prisma.readingListItem.findFirst({
      where: { userId, url },
      select: { title: true, notes: true },
    });
    if (!saved) return null;
    title = saved.title;
    text = saved.notes ?? '';
  }

  const [friendIds, wall] = await Promise.all([friendIdsOf(userId), blockWallOf(userId)]);
  const settings = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const showPublic = (settings?.settings as Record<string, unknown> | null)?.commentsShowPublic !== false;

  const rows = await prisma.comment.findMany({
    where: {
      articleKey: key,
      deletedAt: null,
      ...visibilityWhere(userId, showPublic, friendIds),
      ...notWalledWhere(wall),
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_COMMENTS,
    select: { body: true, user: { select: { username: true } } },
  });

  const comments: { author: string; body: string }[] = [];
  let spent = 0;
  for (const row of rows) {
    const body = htmlToText(row.body);
    if (!body) continue;
    if (spent + body.length > MAX_COMMENT_CHARS) break;
    spent += body.length;
    comments.push({ author: row.user?.username ?? 'someone', body });
  }

  return { title, url, text: clamp(text, MAX_ARTICLE_CHARS), comments };
}

/**
 * Render the context as the opening user message.
 *
 * Fenced and labelled rather than pasted in raw, so the model can tell the
 * reader's question from the material it is about. The system prompts say to
 * treat anything instruction-shaped inside these blocks as content — this
 * framing is what makes that instruction meaningful.
 */
export function renderContext(ctx: ArticleContext): string {
  const parts = [`<article title="${ctx.title.replace(/"/g, "'")}" url="${ctx.url}">`];
  parts.push(ctx.text || '[no article text was captured — only the title is known]');
  parts.push('</article>');

  if (ctx.comments.length > 0) {
    parts.push('\n<comments>');
    for (const c of ctx.comments) parts.push(`${c.author}: ${c.body}`);
    parts.push('</comments>');
  }
  return parts.join('\n');
}
