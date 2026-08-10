import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { renderShell } from '../lib/htmlShell';
import { renderHead, renderNoscript, ogImageFrom, absoluteUrl } from '../lib/seoMeta';
import { escapeHtml } from '../lib/htmlEscape';
import { publicOrigin, postPathFor, postUrlFor, profileUrlFor, excerptOf } from '../lib/blog';
import { blogFeedUrlFor, renderRss } from '../lib/blogFeed';
import { normalizeTag, tagPostsWhere, TAG_PAGE_SIZE, MIN_TAG_POSTS_TO_INDEX } from '../lib/tags';
import { eligibleAuthorIds } from '../lib/recent';
import { PUBLIC_USER_SELECT, displayNameOf } from '../lib/friends';
import { canonicalArticleKey, articleHost } from '../lib/comments';
import { assembleThread } from '../lib/commentTree';
import logger from '../lib/logger';

// Server-rendered <head> (and a crawlable copy of the content) for the pages a
// logged-out visitor can already read.
//
// Every one of these URLs already worked without an account — a public post, a
// profile, a shared thread link. What none of them had was a *document* that
// said so: nginx served the same index.html for all of them, so a crawler saw an
// empty root div and an unfurler had nothing to draw a card from.
//
// The rule that governs this whole file: **these routes render the anonymous
// view, always.** A crawler is never signed in, and the response is cacheable
// and shared, so rendering anything a particular viewer can see would be a way
// to leak it into a cache or a search index. A signed-in visitor gets the same
// anonymous document and then React hydrates over it with their own token and
// fetches what they are actually allowed to see. That is why a friends-only post
// answers 404 here and still opens perfectly well for the friend.

const router = Router();

// A page with no publishable content of its own still has to answer. Serving the
// plain shell (no injected head) leaves the SPA to render whatever it renders,
// which for a 404 is its own not-found screen.
async function plainShell(res: Response, status: number, robots = 'noindex, follow'): Promise<void> {
  const head = renderHead({
    title: 'Newt',
    canonical: `${publicOrigin()}/`,
    robots,
  });
  res.status(status).type('html').send(await renderShell(head));
}

/**
 * A soft 404 — a 200 carrying a page that says "not found" — leaves a URL in
 * Google's index indefinitely. That matters more here than it usually would,
 * because there is no per-user "hide from search" switch: `public` means
 * indexed, so un-publishing a post is the *only* way to take it out of search,
 * and it has to actually work. Hence a real status on every miss.
 */
function notFound(res: Response): Promise<void> {
  return plainShell(res, 404);
}

// ── Author profile: /u/<username> ────────────────────────────────────────────

// How many posts are linked from a profile document. This is the crawlable
// index of an author's work, so it is a page count rather than the infinite
// scroll the app itself uses — a crawler cannot press "load more", which is why
// everything below the first screen of an author's profile was, until now,
// unreachable to a search engine no matter how good the meta tags were.
const ARCHIVE_PAGE_SIZE = 50;

// Below this a profile is not worth a search result: an account with nothing on
// it is a thin page, and a lot of thin pages is how a domain teaches Google to
// crawl less of it. They stay perfectly reachable — this only declines the
// index entry.
const MIN_POSTS_TO_INDEX = 1;

async function findAuthor(username: string) {
  return prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' }, bannedAt: null },
    select: { ...PUBLIC_USER_SELECT, id: true, createdAt: true, coverImage: true },
  });
}

router.get('/u/:username', async (req: Request, res: Response): Promise<void> => {
  try {
    const author = await findAuthor(req.params.username);
    if (!author) { await notFound(res); return; }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const where = { userId: author.id, visibility: 'public' };

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * ARCHIVE_PAGE_SIZE,
        take: ARCHIVE_PAGE_SIZE,
        select: { title: true, slug: true, excerpt: true, publishedAt: true },
      }),
      prisma.blogPost.count({ where }),
    ]);

    // A page number past the end is not a page. Answering 404 keeps a crawler
    // from walking ?page= upwards forever, which it will happily do.
    if (page > 1 && posts.length === 0) { await notFound(res); return; }

    const name = displayNameOf(author);
    const canonical = page > 1
      ? `${profileUrlFor(author.username)}?page=${page}`
      : profileUrlFor(author.username);
    const totalPages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));

    const head = renderHead({
      title: page > 1 ? `${name} — page ${page}` : name,
      description: total > 0
        ? `${total} public ${total === 1 ? 'post' : 'posts'} by ${name} on Newt.`
        : `${name} on Newt.`,
      canonical,
      image: ogImageFrom(author.coverImage) ?? ogImageFrom(author.avatar),
      ogType: 'profile',
      robots: total >= MIN_POSTS_TO_INDEX ? undefined : 'noindex, follow',
      feeds: [{ href: blogFeedUrlFor(author.username), title: `${name} — posts` }],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        mainEntity: {
          '@type': 'Person',
          name,
          alternateName: author.username,
          url: profileUrlFor(author.username),
        },
      },
    });

    // The crawlable archive: a real <a href> per post, plus real pagination.
    // This is the link graph the sitemap complements rather than replaces — a
    // sitemap tells a crawler a URL exists, and a link like this tells it what
    // the URL is about and that something vouches for it.
    const list = posts.map(p => {
      const href = postPathFor(author.username, p.slug);
      const when = p.publishedAt.toISOString().slice(0, 10);
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(p.title)}</a> `
        + `<time datetime="${when}">${when}</time>`
        + (p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : '')
        + `</li>`;
    }).join('\n');

    const nav = [
      page > 1 ? `<a rel="prev" href="/u/${encodeURIComponent(author.username)}?page=${page - 1}">Previous</a>` : '',
      page < totalPages ? `<a rel="next" href="/u/${encodeURIComponent(author.username)}?page=${page + 1}">Next</a>` : '',
    ].filter(Boolean).join(' ');

    const body = renderNoscript(
      `<h1>${escapeHtml(name)}</h1>\n<ul>\n${list}\n</ul>\n${nav ? `<nav>${nav}</nav>` : ''}`,
    );

    res.type('html').send(await renderShell(head, body));
  } catch (err) {
    logger.error(err, 'Profile document error');
    await plainShell(res, 500);
  }
});

// ── One post: /u/<username>/<slug> ───────────────────────────────────────────

// Comments rendered into a post's document. Capped because this is a page, not
// a thread viewer: past a certain depth the extra text adds nothing a search
// engine will use, and the document should not grow without bound.
const MAX_RENDERED_COMMENTS = 100;

type CommentNode = {
  id: string;
  parentId: string | null;
  title: string | null;
  body: string;
  createdAt: Date;
  user: { id: string; username: string; firstName: string | null; lastName: string | null; avatar: string | null };
  replies: CommentNode[];
};

// One comment and everything under it. `body` is sanitizer output (see
// sanitizeCommentHtml) and is the only thing on this page written into the
// document as markup rather than as escaped text.
function renderComment(c: CommentNode): string {
  const when = c.createdAt.toISOString();
  const replies = c.replies.map(renderComment).join('\n');
  return `<article>`
    + `<h3>${escapeHtml(displayNameOf(c.user))}</h3>`
    + `<time datetime="${when}">${when.slice(0, 10)}</time>`
    + (c.title ? `<h4>${escapeHtml(c.title)}</h4>` : '')
    + c.body
    + (replies ? `\n${replies}` : '')
    + `</article>`;
}

router.get('/u/:username/:slug', async (req: Request, res: Response): Promise<void> => {
  try {
    const author = await findAuthor(req.params.username);
    if (!author) { await notFound(res); return; }

    const post = await prisma.blogPost.findFirst({
      where: { userId: author.id, slug: req.params.slug },
      select: {
        title: true, slug: true, body: true, excerpt: true, heroImage: true, tags: true,
        visibility: true, commentsEnabled: true, articleKey: true,
        publishedAt: true, updatedAt: true,
      },
    });

    // Not public is not visible *here*, whoever is asking. A draft, a
    // friends-only post and a post that was never written are one answer, which
    // is also what stops this route confirming that a private slug exists.
    if (!post || post.visibility !== 'public') { await notFound(res); return; }

    const name = displayNameOf(author);
    const canonical = postUrlFor(author.username, post.slug);
    const description = post.excerpt || excerptOf(post.body);

    // Public comments only, and only when the author left them enabled. This is
    // the Reddit lesson from the design discussion: a comment indexed as part of
    // the post it answers is content about that subject, and the same comment
    // listed on its author's profile is a thin page about a person. So they are
    // rendered here, and the profile's comments tab is noindex.
    const comments = post.commentsEnabled
      ? await prisma.comment.findMany({
          where: { articleKey: post.articleKey, visibility: 'public', deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: MAX_RENDERED_COMMENTS,
          select: {
            id: true, parentId: true, title: true, body: true, createdAt: true,
            user: { select: PUBLIC_USER_SELECT },
          },
        })
      : [];

    const head = renderHead({
      title: post.title,
      description,
      canonical,
      image: ogImageFrom(post.heroImage),
      ogType: 'article',
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      authorName: name,
      feeds: [{ href: blogFeedUrlFor(author.username), title: `${name} — posts` }],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description,
        datePublished: post.publishedAt.toISOString(),
        dateModified: post.updatedAt.toISOString(),
        author: {
          '@type': 'Person',
          name,
          url: profileUrlFor(author.username),
        },
        mainEntityOfPage: canonical,
        ...(absoluteUrl(post.heroImage) ? { image: absoluteUrl(post.heroImage) } : {}),
        ...(post.tags.length ? { keywords: post.tags.join(', ') } : {}),
        ...(comments.length
          ? {
              commentCount: comments.length,
              comment: comments.map(c => ({
                '@type': 'Comment',
                text: excerptOf(c.body, 500),
                dateCreated: c.createdAt.toISOString(),
                author: { '@type': 'Person', name: displayNameOf(c.user) },
              })),
            }
          : {}),
      },
    });

    // assembleThread is what the app's own comment panel uses, so the rendered
    // order is the conversation as a reader would meet it rather than a flat
    // dump — replies nested under what they answer, oldest first.
    const roots = assembleThread(
      comments.map(c => ({ ...c, replies: [] as CommentNode[] })),
      'oldest',
    );
    const commentHtml = roots.length === 0 ? '' :
      `<section><h2>Comments</h2>\n${roots.map(renderComment).join('\n')}\n</section>`;

    const tagLinks = post.tags.length === 0 ? '' :
      `<p>${post.tags.map(t => `<a href="/t/${encodeURIComponent(t)}">#${escapeHtml(t)}</a>`).join(' ')}</p>`;

    const body = renderNoscript(
      `<article><h1>${escapeHtml(post.title)}</h1>`
      + `<p>By <a href="${escapeHtml(profileUrlFor(author.username))}">${escapeHtml(name)}</a> `
      + `on <time datetime="${post.publishedAt.toISOString()}">`
      + `${post.publishedAt.toISOString().slice(0, 10)}</time></p>`
      + `${post.body}</article>${tagLinks}${commentHtml}`,
    );

    res.type('html').send(await renderShell(head, body));
  } catch (err) {
    logger.error(err, 'Post document error');
    await plainShell(res, 500);
  }
});

// ── The global recent page: /recent ──────────────────────────────────────────

// Smaller than an archive page. This is a front door, not an index — it wants to
// be worth reading top to bottom, and a crawler that enters here should be sent
// onward to posts and profiles rather than handed everything at once.
const RECENT_PAGE_SIZE = 30;

router.get('/recent', async (_req: Request, res: Response): Promise<void> => {
  try {
    const authorIds = await eligibleAuthorIds();
    const posts = authorIds.length === 0 ? [] : await prisma.blogPost.findMany({
      where: { visibility: 'public', userId: { in: authorIds } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_PAGE_SIZE,
      select: {
        title: true, slug: true, excerpt: true, publishedAt: true,
        user: { select: PUBLIC_USER_SELECT },
      },
    });

    const origin = publicOrigin();
    const head = renderHead({
      title: 'Recent posts',
      description: 'The latest public posts written on Newt.',
      canonical: `${origin}/recent`,
      // Not paginated, and deliberately so: a page that is only ever "the last
      // thirty" has nothing behind it to walk, and page 40 of a firehose is a
      // thin page nobody asked for. The sitemap is the exhaustive list.
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'Recent posts',
        url: `${origin}/recent`,
      },
    });

    const list = posts.map(p => {
      const href = postPathFor(p.user.username, p.slug);
      const when = p.publishedAt.toISOString().slice(0, 10);
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(p.title)}</a> `
        + `<span>by <a href="${escapeHtml(profileUrlFor(p.user.username))}">`
        + `${escapeHtml(displayNameOf(p.user))}</a></span> `
        + `<time datetime="${when}">${when}</time>`
        + (p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : '')
        + `</li>`;
    }).join('\n');

    const body = renderNoscript(`<h1>Recent posts</h1>\n<ul>\n${list}\n</ul>`);
    res.type('html').send(await renderShell(head, body));
  } catch (err) {
    logger.error(err, 'Recent document error');
    await plainShell(res, 500);
  }
});

// ── Tag page: /t/<tag> ───────────────────────────────────────────────────────

router.get('/t/:tag', async (req: Request, res: Response): Promise<void> => {
  try {
    const tag = normalizeTag(req.params.tag);
    if (!tag) { await notFound(res); return; }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const where = tagPostsWhere(tag);

    const [posts, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * TAG_PAGE_SIZE,
        take: TAG_PAGE_SIZE,
        select: {
          title: true, slug: true, excerpt: true, publishedAt: true,
          user: { select: PUBLIC_USER_SELECT },
        },
      }),
      prisma.blogPost.count({ where }),
    ]);

    if (page > 1 && posts.length === 0) { await notFound(res); return; }

    const origin = publicOrigin();
    const base = `${origin}/t/${encodeURIComponent(tag)}`;
    const totalPages = Math.max(1, Math.ceil(total / TAG_PAGE_SIZE));

    const head = renderHead({
      title: `#${tag}`,
      description: total > 0
        ? `${total} ${total === 1 ? 'post' : 'posts'} tagged #${tag} on Newt.`
        : `Posts tagged #${tag} on Newt.`,
      canonical: page > 1 ? `${base}?page=${page}` : base,
      robots: total >= MIN_TAG_POSTS_TO_INDEX ? undefined : 'noindex, follow',
      feeds: [{ href: `${base}/feed.xml`, title: `#${tag}` }],
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `#${tag}`,
        url: base,
      },
    });

    const list = posts.map(p => {
      const href = postPathFor(p.user.username, p.slug);
      const when = p.publishedAt.toISOString().slice(0, 10);
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(p.title)}</a> `
        + `<span>by <a href="${escapeHtml(profileUrlFor(p.user.username))}">`
        + `${escapeHtml(displayNameOf(p.user))}</a></span> `
        + `<time datetime="${when}">${when}</time>`
        + (p.excerpt ? `<p>${escapeHtml(p.excerpt)}</p>` : '')
        + `</li>`;
    }).join('\n');

    const nav = [
      page > 1 ? `<a rel="prev" href="/t/${encodeURIComponent(tag)}?page=${page - 1}">Previous</a>` : '',
      page < totalPages ? `<a rel="next" href="/t/${encodeURIComponent(tag)}?page=${page + 1}">Next</a>` : '',
    ].filter(Boolean).join(' ');

    const body = renderNoscript(
      `<h1>#${escapeHtml(tag)}</h1>\n<ul>\n${list}\n</ul>\n${nav ? `<nav>${nav}</nav>` : ''}`,
    );

    res.type('html').send(await renderShell(head, body));
  } catch (err) {
    logger.error(err, 'Tag document error');
    await plainShell(res, 500);
  }
});

/**
 * A tag as a feed.
 *
 * Nearly free — renderRss already exists for author blogs — and it is what turns
 * a tag from a page into something you can follow, inside Newt or out of it.
 * Subscribing to /t/photography in the app's own reader is the closest thing
 * here to joining a community, and it needs no new concept to work: it is a feed
 * URL like any other.
 */
router.get('/t/:tag/feed.xml', async (req: Request, res: Response): Promise<void> => {
  try {
    const tag = normalizeTag(req.params.tag);
    if (!tag) { res.status(404).type('text/plain').send(''); return; }

    const origin = publicOrigin();
    const posts = await prisma.blogPost.findMany({
      where: tagPostsWhere(tag),
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        title: true, slug: true, body: true, excerpt: true, heroImage: true,
        tags: true, publishedAt: true, user: { select: { username: true } },
      },
    });

    const xml = renderRss({
      title: `#${tag} on Newt`,
      link: `${origin}/t/${encodeURIComponent(tag)}`,
      description: `Posts tagged #${tag}.`,
      selfUrl: `${origin}/t/${encodeURIComponent(tag)}/feed.xml`,
      items: posts.map(p => ({
        title: p.title,
        link: postUrlFor(p.user.username, p.slug),
        description: p.excerpt || excerptOf(p.body),
        content: p.body,
        pubDate: p.publishedAt,
        heroImage: p.heroImage,
        tags: p.tags,
      })),
    });

    res.type('application/rss+xml').send(xml);
  } catch (err) {
    logger.error(err, 'Tag feed error');
    res.status(500).type('text/plain').send('');
  }
});

// ── Shared thread link: /a/<base64url> ───────────────────────────────────────

/**
 * The article URL out of a thread link. The mirror of encodeArticleId in
 * client/src/utils/articleUrl.ts — the id is the URL itself, base64url-encoded,
 * so there is no mapping to look up and nothing to keep in step but this.
 */
function decodeArticleId(id: string): string | null {
  try {
    const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
    const url = Buffer.from(b64, 'base64').toString('utf8');
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * A thread on somebody else's article.
 *
 * `noindex`, and deliberately **without** a canonical pointing at the original.
 * The instinct is to add one — the article's home really is the publisher's page
 * — but the two directives together are the one combination Google asks you not
 * to ship: canonical says "credit that URL instead of this one", which is an
 * invitation to carry this page's noindex across to it. Aimed at a publisher we
 * do not control, that is a way to ask Google to deindex someone else's article.
 *
 * So: noindex alone here, and when the embeddable-comments product needs the
 * other half of this problem — a copy of a customer's comments hosted on Newt —
 * that page wants the reverse pairing, a canonical to the customer's URL and no
 * noindex, so the credit lands on the page they are paying to have rank.
 *
 * The meta is still rendered in full, because `noindex` is a search directive
 * and unfurlers ignore it: a thread link pasted into Slack should still show
 * what it is.
 */
router.get('/a/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const url = decodeArticleId(req.params.id);
    if (!url) { await notFound(res); return; }

    const key = canonicalArticleKey(url);
    const host = articleHost(url);
    const [comment, count] = await Promise.all([
      prisma.comment.findFirst({
        where: { articleKey: key, visibility: 'public', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { articleTitle: true },
      }),
      prisma.comment.count({ where: { articleKey: key, visibility: 'public', deletedAt: null } }),
    ]);

    const title = comment?.articleTitle || host || 'Discussion';
    const head = renderHead({
      title,
      description: count > 0
        ? `${count} public ${count === 1 ? 'comment' : 'comments'} on this article, on Newt.`
        : 'Read and discuss this article on Newt.',
      canonical: `${publicOrigin()}/a/${encodeURIComponent(req.params.id)}`,
      robots: 'noindex, follow',
      ogType: 'article',
    });

    res.type('html').send(await renderShell(head));
  } catch (err) {
    logger.error(err, 'Thread document error');
    await plainShell(res, 500);
  }
});

export default router;
