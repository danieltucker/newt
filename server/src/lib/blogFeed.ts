import prisma from './prisma';
import { publicOrigin } from './blog';
import { canonicalArticleKey } from './comments';
import { friendIdsOf, displayNameOf, PUBLIC_USER_SELECT } from './friends';
import logger from './logger';

// RSS for blogs, and — more importantly — the path that lets a blog behave like
// any other feed in this app without a single outbound HTTP request.
//
// There are two kinds of feed:
//
//   /api/v1/blogs/<username>/feed.xml   public posts by one author
//   /api/v1/blogs/feed/<token>.xml      one subscriber's aggregate of their
//                                       friends' public + friends-only posts
//
// Feed and FeedItem rows are shared by every user who subscribes to a URL, so
// the first kind may only ever carry public posts. The second is safe *because*
// its URL is unique per subscriber: only the token holder can reference that
// Feed row, so friends-only posts in it are never reachable by another account.
// That makes the token a bearer secret — see the rotate endpoint.

const FEED_ITEM_LIMIT = 50;
const WORDS_PER_MINUTE = 220;

export function blogFeedUrlFor(username: string): string {
  return `${publicOrigin()}/api/v1/blogs/${encodeURIComponent(username)}/feed.xml`;
}

export function personalFeedUrlFor(token: string): string {
  return `${publicOrigin()}/api/v1/blogs/feed/${encodeURIComponent(token)}.xml`;
}

export type BlogFeedTarget =
  | { kind: 'user'; username: string }
  | { kind: 'personal'; token: string };

// Recognise one of our own feed URLs. The host must match this deployment's
// origin: without that check, subscribing to a lookalike URL on someone else's
// domain would make us serve our own data for it.
export function parseBlogFeedUrl(raw: string): BlogFeedTarget | null {
  let url: URL;
  let mine: URL;
  try {
    url = new URL(raw);
    mine = new URL(publicOrigin());
  } catch {
    return null;
  }
  if (url.host !== mine.host) return null;

  const user = url.pathname.match(/^\/api\/v1\/blogs\/([^/]+)\/feed\.xml$/);
  if (user) return { kind: 'user', username: safeDecode(user[1]) };

  const personal = url.pathname.match(/^\/api\/v1\/blogs\/feed\/([^/]+)\.xml$/);
  if (personal) return { kind: 'personal', token: safeDecode(personal[1]) };

  return null;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── RSS rendering ────────────────────────────────────────────────────────────

export interface FeedItemData {
  title: string;
  link: string;
  description: string;
  content: string;
  pubDate: Date;
  // The post's cover image as a site-relative path, or '' for none. Kept
  // relative here because the internal refresh path below writes it straight
  // into FeedItem.imageUrl, which the client renders from its own origin;
  // absolutizing happens only where the value leaves this deployment (the RSS
  // rendering, which an external reader resolves against nothing of ours).
  heroImage: string;
}

// A hero lives outside the post body, so an external reader following the XML
// would never see it. Fold it into content:encoded — with an absolute src, since
// the reader has no origin of ours to resolve a relative path against.
function withHero(content: string, heroImage: string): string {
  if (!heroImage) return content;
  const src = `${publicOrigin()}${heroImage}`;
  return `<p><img src="${xmlEscape(src)}" alt="" /></p>${content}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// CDATA can't contain the terminator, so split any occurrence across two
// sections — the standard trick, and the only escaping CDATA admits.
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function renderRss(feed: {
  title: string;
  link: string;
  description: string;
  selfUrl: string;
  items: FeedItemData[];
}): string {
  const items = feed.items.map(i => `    <item>
      <title>${xmlEscape(i.title)}</title>
      <link>${xmlEscape(i.link)}</link>
      <guid isPermaLink="true">${xmlEscape(i.link)}</guid>
      <pubDate>${i.pubDate.toUTCString()}</pubDate>
      <description>${cdata(i.description)}</description>
      <content:encoded>${cdata(withHero(i.content, i.heroImage))}</content:encoded>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(feed.title)}</title>
    <link>${xmlEscape(feed.link)}</link>
    <description>${xmlEscape(feed.description)}</description>
    <atom:link href="${xmlEscape(feed.selfUrl)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

// ── Resolving a feed's contents from the database ────────────────────────────

interface ResolvedFeed {
  title: string;
  link: string;
  description: string;
  items: FeedItemData[];
}

function readTimeOf(html: string): number {
  const words = html.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

// The posts behind a feed URL. Returns null when the target doesn't resolve to a
// user at all (a deleted account, a rotated token), which the caller renders as
// an empty feed rather than an error — a stale subscription should go quiet, not
// break the subscriber's folder.
export async function resolveBlogFeed(target: BlogFeedTarget): Promise<ResolvedFeed | null> {
  const owner = target.kind === 'user'
    ? await prisma.user.findFirst({
        where: { username: { equals: target.username, mode: 'insensitive' }, bannedAt: null },
        select: PUBLIC_USER_SELECT,
      })
    : await prisma.user.findFirst({
        where: { feedToken: target.token, bannedAt: null },
        select: PUBLIC_USER_SELECT,
      });
  if (!owner) return null;

  const name = displayNameOf(owner);

  // A public blog feed carries public posts only — it is fetched with no viewer
  // identity and its items are shared by every subscriber.
  const where = target.kind === 'user'
    ? { userId: owner.id, visibility: 'public' }
    // The personal feed is scoped to this subscriber, so it may include
    // friends-only posts. Drafts are excluded: 'private' is unpublished.
    : {
        userId: { in: [...(await friendIdsOf(owner.id)), owner.id] },
        visibility: { in: ['public', 'friends'] },
      };

  const posts = await prisma.blogPost.findMany({
    where,
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: FEED_ITEM_LIMIT,
    select: {
      title: true, url: true, body: true, excerpt: true, heroImage: true, publishedAt: true,
      user: { select: { username: true, firstName: true, lastName: true } },
    },
  });

  return {
    title: target.kind === 'user' ? `${name}’s blog` : `${name}’s friends`,
    link: `${publicOrigin()}/u/${encodeURIComponent(owner.username)}`,
    description: target.kind === 'user'
      ? `Posts by ${name}`
      : `Posts from ${name}’s friends`,
    items: posts.map(p => ({
      title: p.title,
      link: p.url,
      description: p.excerpt,
      content: p.body,
      pubDate: p.publishedAt,
      heroImage: p.heroImage,
    })),
  };
}

export async function renderBlogFeed(target: BlogFeedTarget): Promise<string> {
  const resolved = await resolveBlogFeed(target);
  const selfUrl = target.kind === 'user'
    ? blogFeedUrlFor(target.username)
    : personalFeedUrlFor(target.token);
  if (!resolved) {
    return renderRss({ title: 'Blog', link: publicOrigin(), description: '', selfUrl, items: [] });
  }
  return renderRss({ ...resolved, selfUrl });
}

// ── The refresh short-circuit ────────────────────────────────────────────────
// Called from feedRefresh instead of an HTTP fetch when the feed URL is one of
// ours. Reading the posts straight from the database avoids the server looping
// back through its own proxy (which the SSRF guard would refuse for a private
// address anyway) and keeps the post HTML byte-identical, since nothing has to
// survive a round trip through XML.
export async function refreshBlogFeed(feedId: string, target: BlogFeedTarget, now: Date): Promise<void> {
  const resolved = await resolveBlogFeed(target);
  const items = resolved?.items ?? [];

  for (const item of items) {
    await prisma.feedItem.upsert({
      where: { feedId_link: { feedId, link: item.link } },
      create: {
        feedId, title: item.title, link: item.link,
        linkKey: canonicalArticleKey(item.link),
        pubDate: item.pubDate, fetchedAt: now,
        readTime: readTimeOf(item.content), snippet: item.description,
        // Site-relative, and stays that way: subscribers render it from this
        // same origin, which is exactly where the bytes are served from.
        content: item.content, imageUrl: item.heroImage || null, categories: [],
      },
      update: {
        title: item.title, linkKey: canonicalArticleKey(item.link),
        pubDate: item.pubDate, fetchedAt: now,
        readTime: readTimeOf(item.content), snippet: item.description,
        content: item.content, imageUrl: item.heroImage || null,
      },
    }).catch(err => logger.warn({ err, link: item.link }, 'Blog feed item upsert failed'));
  }

  // Unlike a real RSS feed, where a dropped item is only a hint that it may be
  // gone, here we know exactly what the feed contains. A post that was deleted
  // or narrowed to a draft must leave subscribers' folders at once, not after
  // the TTL — so anything not in the current set is removed now.
  await prisma.feedItem.deleteMany({
    where: { feedId, link: { notIn: items.map(i => i.link) } },
  });

  await prisma.feed.update({
    where: { id: feedId },
    data: {
      title: resolved?.title ?? 'Blog',
      lastCheckedAt: now,
      etag: null,
      lastModified: null,
    },
  });
}

// Nudge every feed that should reflect a change to `userId`'s posts: their own
// public blog feed, and the personal feed of each of their friends. Clearing
// lastCheckedAt makes the next folder load refresh them instead of waiting out
// the 30-minute stale window, so a new post shows up right away.
export async function invalidateBlogFeeds(userId: string): Promise<void> {
  const [author, friendIds] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { username: true, feedToken: true } }),
    friendIdsOf(userId),
  ]);
  if (!author) return;

  const subscribers = await prisma.user.findMany({
    where: { id: { in: [...friendIds, userId] }, feedToken: { not: null } },
    select: { feedToken: true },
  });

  const urls = [
    blogFeedUrlFor(author.username),
    ...subscribers.map(s => personalFeedUrlFor(s.feedToken!)),
  ];

  // canonicalKey is how Feed rows are addressed; match on fetchUrl too since a
  // row created from a differently-spelled URL keeps the URL it was made with.
  await prisma.feed.updateMany({
    where: { fetchUrl: { in: urls } },
    data: { lastCheckedAt: null },
  });
}
