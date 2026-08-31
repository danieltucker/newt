import prisma from '../prisma';
import { canonicalArticleKey } from '../comments';
import { visibilityWhere } from '../commentVisibility';
import { friendIdsOf } from '../friends';
import { blockWallOf, notWalledWhere } from '../blocks';
import { htmlToText } from './htmlText';
import { articleTextFor } from './articleText';

/**
 * Gathering everything readable about a URL, so a question about "this article"
 * can actually be about it.
 *
 * Two sources, in this order of preference:
 *
 *  1. **What Newt already has.** A post written here is the original text. A
 *     feed item is whatever the publisher put in their RSS, sanitized on the way
 *     in — which for a minority of feeds is the whole piece.
 *  2. **The page itself.** For the large majority of feeds, what arrives is a
 *     headline and two sentences of teaser. Answering from that produced exactly
 *     what you would expect: a model told to treat a teaser as "the article",
 *     hedging its way around a piece it had never read. So when the stored copy
 *     is thin, articleText.ts goes and reads the page — cached, capped, and
 *     behind the same SSRF gate every other user-supplied URL goes through.
 *
 * Comments and notes are *never* part of that cache. They are read live, per
 * viewer, through the viewer's own visibility rules, below.
 */

/** Roughly four characters to a token; this budget is about 12k tokens of article. */
const MAX_ARTICLE_CHARS = 48_000;
/** Comments are supporting material, not the subject. */
const MAX_COMMENT_CHARS = 12_000;
const MAX_COMMENTS = 40;

/**
 * Under this many characters, the stored copy is a teaser rather than a piece,
 * and it is worth going to the page. Set well above a two-sentence RSS summary
 * and well below a short article, so a feed that does publish full text is never
 * re-fetched for no reason.
 */
const THIN_TEXT_CHARS = 1_500;

/** Where the text in an ArticleContext came from, so the prompt can say. */
export type TextSource =
  /** The author's own post, or a feed that publishes in full. */
  | 'stored'
  /** Read from the page, because what was stored was a summary. */
  | 'fetched'
  /** A summary is all there is — the page could not be read. */
  | 'summary'
  /** Not even that: a title and nothing else. */
  | 'none';

export interface ArticleContext {
  title: string;
  url: string;
  /** Plain text, ready to drop into a prompt. Empty when nothing was stored. */
  text: string;
  /** What `text` actually is. The model is told, so it can stop guessing. */
  source: TextSource;
  comments: { author: string; body: string }[];
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
/**
 * Everything readable about one URL to *nobody in particular*.
 *
 * What a generated explore is given. It is a separate exported function rather
 * than `articleContextFor(url, null)` on purpose, and the reason is the whole
 * privacy argument for auto-explore.
 *
 * `articleContextFor` feeds the model the viewer's own comments — **including
 * the `private` tier the UI calls a Personal Note** — and, when no article text
 * can be found, their reading-list notes. That is fine when the output is a
 * private thread only that reader can open, which is exactly why explores
 * default to private. A generated explore is destined to be *published on the
 * article page*, so the same context assembly would take somebody's note to
 * self and publish it.
 *
 * Making that a parameter of one function would mean a single wrong argument,
 * anywhere, ever, publishes private writing. Two functions means the unsafe one
 * cannot be reached without naming a viewer, and this one has no `userId` to
 * pass — there is no argument that could turn it back on.
 *
 * So: public comments only, no reading-list fallback, no friends tier, no
 * per-user settings. An article Newt holds no public record of yields null, and
 * a null here means the job is skipped rather than run on thin material.
 */
export async function publicArticleContext(url: string): Promise<ArticleContext | null> {
  const key = canonicalArticleKey(url);
  if (!key) return null;

  let title = '';
  let text = '';
  let source: TextSource = 'none';

  // A public post at this URL is the original text. A non-public one is not
  // readable by "nobody", so it is skipped rather than falling through to the
  // feed copy — the feed copy of a private post does not exist.
  const post = await prisma.blogPost.findUnique({
    where: { articleKey: key },
    select: { title: true, body: true, excerpt: true, visibility: true },
  });
  if (post) {
    if (post.visibility !== 'public') return null;
    title = post.title;
    text = htmlToText(post.body) || post.excerpt;
    source = text ? 'stored' : 'none';
  } else {
    const item = await prisma.feedItem.findFirst({
      where: { linkKey: key },
      orderBy: { fetchedAt: 'desc' },
      select: { title: true, content: true, snippet: true },
    });
    if (!item) return null;
    title = item.title;
    text = htmlToText(item.content || '') || (item.snippet ?? '');
    source = text ? 'stored' : 'none';
  }

  // No reading-list fallback here, unlike the viewer path: those notes are one
  // person's private writing and there is no person in this call.
  if (!title) return null;

  if (!post && text.length < THIN_TEXT_CHARS) {
    const fetched = await articleTextFor(url, key).catch(() => '');
    if (fetched.length > text.length) {
      text = fetched;
      source = 'fetched';
    } else if (text) {
      source = 'summary';
    }
  }

  // Public, undeleted comments only. No viewer means no friends tier and no
  // block wall to apply — and a `private` comment is not reachable from here by
  // construction, since the filter names the one tier that is.
  const rows = await prisma.comment.findMany({
    where: { articleKey: key, deletedAt: null, visibility: 'public' },
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

  return { title, url, source, text: clamp(text, MAX_ARTICLE_CHARS), comments };
}

export async function articleContextFor(url: string, userId: string): Promise<ArticleContext | null> {
  const key = canonicalArticleKey(url);
  if (!key) return null;

  let title = '';
  let text = '';
  let source: TextSource = 'none';

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
    // A post is the original text by definition. Never re-fetch one: the page
    // at that URL is Newt rendering this very row.
    source = text ? 'stored' : 'none';
  } else {
    const item = await prisma.feedItem.findFirst({
      where: { linkKey: key },
      orderBy: { fetchedAt: 'desc' },
      select: { title: true, content: true, snippet: true },
    });
    if (item) {
      title = item.title;
      text = htmlToText(item.content || '') || (item.snippet ?? '');
      source = text ? 'stored' : 'none';
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
    source = text ? 'stored' : 'none';
  }

  // Thin copy — a teaser, a note to self, or nothing — is worth a look at the
  // page. Posts are excluded: their "page" is Newt rendering the row we just
  // read, so fetching it would be a round trip to ourselves.
  if (!post && text.length < THIN_TEXT_CHARS) {
    const fetched = await articleTextFor(url, key).catch(() => '');
    if (fetched.length > text.length) {
      text = fetched;
      source = 'fetched';
    } else if (text) {
      // The page could not be read and a teaser is genuinely all there is. That
      // is worth saying out loud rather than passing off as the article.
      source = 'summary';
    }
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

  return { title, url, source, text: clamp(text, MAX_ARTICLE_CHARS), comments };
}

/**
 * What the model is told about the text it has been handed.
 *
 * The point of naming this is that "I have the full article" and "I have two
 * sentences of teaser" call for different answers, and a model given no way to
 * tell them apart writes the first answer with the second one's material. Saying
 * which it is turns a confident summary of a piece it never read into an honest
 * "the feed only gave me a summary; here is what I know about the topic".
 */
const SOURCE_NOTE: Record<TextSource, string> = {
  stored: '',
  fetched: '',
  summary:
    'NOTE: the text below is only the summary the feed published, not the full ' +
    'article — the page itself could not be read. Answer from the summary, the ' +
    'title and your own knowledge, and say plainly that you are working from a ' +
    'summary rather than describing the article as though you had read it.',
  none:
    'NOTE: none of this article\'s text could be retrieved — the title and URL ' +
    'below are all that is known about it. Do not describe or summarise its ' +
    'contents. Say what you can about the topic from the title and your own ' +
    'knowledge, and be explicit that you have not seen the article.',
};

/**
 * Render the context as the opening user message.
 *
 * Fenced and labelled rather than pasted in raw, so the model can tell the
 * reader's question from the material it is about. The system prompts say to
 * treat anything instruction-shaped inside these blocks as content — this
 * framing is what makes that instruction meaningful.
 */
export function renderContext(ctx: ArticleContext): string {
  const parts: string[] = [];
  const note = SOURCE_NOTE[ctx.source];
  // Ahead of the block rather than inside it: everything between the tags is
  // untrusted material, and a caveat about that material must not sit somewhere
  // the material could appear to have written it.
  if (note) parts.push(note, '');

  parts.push(`<article title="${ctx.title.replace(/"/g, "'")}" url="${ctx.url}" content="${ctx.source === 'fetched' ? 'full-page' : ctx.source === 'stored' ? 'full' : ctx.source}">`);
  parts.push(ctx.text || '[no article text could be retrieved — only the title is known]');
  parts.push('</article>');

  if (ctx.comments.length > 0) {
    parts.push('\n<comments>');
    for (const c of ctx.comments) parts.push(`${c.author}: ${c.body}`);
    parts.push('</comments>');
  }
  return parts.join('\n');
}
