import { randomBytes } from 'crypto';
import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { PUBLIC_USER_SELECT, toPublicUser, friendIdsOf, displayNameOf } from '../lib/friends';
import { canonicalArticleKey, isBlankHtml } from '../lib/comments';
import { perUserLimiter } from '../lib/rateLimit';
import { ensureFeeds } from '../lib/feedRefresh';
import {
  renderBlogFeed,
  blogFeedUrlFor,
  personalFeedUrlFor,
  invalidateBlogFeeds,
} from '../lib/blogFeed';
import logger from '../lib/logger';
import {
  sanitizeBlogHtml,
  blogTextLength,
  slugify,
  uniqueSlug,
  postUrlFor,
  publicOrigin,
  excerptOf,
  canSeePost,
  visiblePostWhere,
  isBlogVisibility,
  normalizeHeroImage,
  MAX_BLOG_BODY,
  MAX_BLOG_TEXT,
  MAX_BLOG_TITLE,
} from '../lib/blog';

// Blog posts. Reads run under optionalAuth so a public post opens for a
// logged-out visitor (the same way a shared /a/<id> thread link does); writes
// opt back in with requireAuth.
const router = Router();
router.use(optionalAuth);

const PAGE_SIZE = 20;

// Long-form writing is slower than commenting, so the ceiling is lower — it is
// there to stop scripted flooding, not to pace a real author.
const blogWriteLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 60,
  message: "You've hit the hourly limit for blog edits — please try again later.",
});

const AUTHOR_SELECT = PUBLIC_USER_SELECT;

// Everything the client needs to render a post, minus the body (list views).
const SUMMARY_SELECT = {
  id: true, title: true, slug: true, excerpt: true, heroImage: true, visibility: true,
  commentsEnabled: true, url: true, publishedAt: true, updatedAt: true,
} as const;

const FULL_SELECT = { ...SUMMARY_SELECT, body: true, articleKey: true } as const;

type PostRow = {
  id: string; title: string; slug: string; excerpt: string; heroImage: string; visibility: string;
  commentsEnabled: boolean; url: string; publishedAt: Date; updatedAt: Date;
  body?: string; articleKey?: string;
  user?: { id: string; username: string; firstName: string | null; lastName: string | null; avatar: string | null };
};

function toJson(post: PostRow) {
  const { user, ...rest } = post;
  return { ...rest, ...(user ? { author: toPublicUser(user) } : {}) };
}

async function findOwner(username: string) {
  return prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' }, bannedAt: null },
    select: { ...PUBLIC_USER_SELECT, id: true },
  });
}

// Validate a create/update payload. Returns an error message, or null when the
// body is acceptable. `partial` allows omitted fields (PATCH).
function validate(
  b: Record<string, unknown>,
  partial: boolean,
): string | null {
  const { title, body, visibility, commentsEnabled, heroImage } = b;

  if (!partial || title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) return 'A title is required';
    if (title.length > MAX_BLOG_TITLE) return `title must be ≤${MAX_BLOG_TITLE} characters`;
  }
  if (!partial || body !== undefined) {
    if (typeof body !== 'string' || body.length > MAX_BLOG_BODY) {
      return `body must be a string of ≤${MAX_BLOG_BODY} characters`;
    }
    if (isBlankHtml(body)) return 'Post is empty';
    if (blogTextLength(body) > MAX_BLOG_TEXT) {
      return `Post is too long — keep it under ${MAX_BLOG_TEXT.toLocaleString()} characters`;
    }
  }
  if (visibility !== undefined && !isBlogVisibility(visibility)) {
    return "visibility must be 'public', 'friends', or 'private'";
  }
  if (commentsEnabled !== undefined && typeof commentsEnabled !== 'boolean') {
    return 'commentsEnabled must be a boolean';
  }
  if (heroImage !== undefined && normalizeHeroImage(heroImage) === null) {
    return 'heroImage must be an uploaded image path, or empty';
  }
  return null;
}

// Tell an author's friends about a post the moment it becomes visible to them.
// Only 'friends' posts notify: a public post is discoverable without pestering
// everyone, and a draft is nobody's business. Fires only on the transition into
// 'friends', so re-saving an already-shared post doesn't notify twice.
async function notifyFriendsOfPost(
  authorId: string,
  post: { id: string; title: string; url: string },
): Promise<void> {
  const friendIds = await friendIdsOf(authorId);
  if (friendIds.size === 0) return;
  await prisma.notification.createMany({
    data: [...friendIds].map(fid => ({
      userId: fid,
      type: 'friend_post',
      actorId: authorId,
      articleKey: canonicalArticleKey(post.url),
      articleUrl: post.url,
      articleTitle: post.title,
      commentId: null,
    })),
  });
}

// ── Author-facing routes ─────────────────────────────────────────────────────
// These are declared before the /:username routes so "mine" can't be read as a
// username.

// GET /api/v1/blogs/mine — every post you have written, drafts included.
router.get('/mine', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const posts = await prisma.blogPost.findMany({
      where: { userId: req.userId! },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: SUMMARY_SELECT,
    });
    res.json({ posts });
  } catch (err) {
    logger.error(err, 'List own blog posts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/blogs — create. Defaults to private, i.e. a draft.
router.post('/', requireAuth, blogWriteLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const problem = validate(req.body as Record<string, unknown>, false);
  if (problem) { res.status(400).json({ error: problem }); return; }

  const { title, body, visibility, commentsEnabled, heroImage } = req.body as Record<string, unknown>;

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { username: true },
    });
    if (!user) { res.status(404).json({ error: 'Not found' }); return; }

    const now = new Date();
    const taken = new Set(
      (await prisma.blogPost.findMany({ where: { userId: req.userId! }, select: { slug: true } }))
        .map(p => p.slug),
    );
    const slug = uniqueSlug(slugify(title as string), taken);
    const url = postUrlFor(user.username, slug);
    const clean = sanitizeBlogHtml(body as string);

    const post = await prisma.blogPost.create({
      data: {
        userId: req.userId!,
        title: (title as string).trim(),
        slug,
        body: clean,
        excerpt: excerptOf(clean),
        heroImage: normalizeHeroImage(heroImage) ?? '',
        visibility: isBlogVisibility(visibility) ? visibility : 'private',
        commentsEnabled: commentsEnabled !== false,
        url,
        articleKey: canonicalArticleKey(url),
        publishedAt: now,
      },
      select: FULL_SELECT,
    });

    // Best-effort: make the change show up in subscribers' folders now rather
    // than after the 30-minute stale window. Never fail the write over it.
    invalidateBlogFeeds(req.userId!).catch(err =>
      logger.warn(err, 'Blog feed invalidation failed'));

    if (post.visibility === 'friends') {
      await notifyFriendsOfPost(req.userId!, post).catch(err =>
        logger.warn(err, 'Blog post notification failed'));
    }

    res.status(201).json(toJson(post));
  } catch (err) {
    logger.error(err, 'Create blog post error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/blogs/post/:id — load one of your own posts for editing.
router.get('/post/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const post = await prisma.blogPost.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: FULL_SELECT,
    });
    if (!post) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(toJson(post));
  } catch (err) {
    logger.error(err, 'Load blog post error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/v1/blogs/post/:id — author only.
router.patch('/post/:id', requireAuth, blogWriteLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const problem = validate(req.body as Record<string, unknown>, true);
  if (problem) { res.status(400).json({ error: problem }); return; }

  const { title, body, visibility, commentsEnabled, heroImage } = req.body as Record<string, unknown>;

  try {
    const existing = await prisma.blogPost.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true, slug: true, visibility: true, user: { select: { username: true } } },
    });
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

    const data: Record<string, unknown> = {};
    if (typeof title === 'string') data.title = title.trim();
    if (typeof body === 'string') {
      const clean = sanitizeBlogHtml(body);
      data.body = clean;
      data.excerpt = excerptOf(clean);
    }
    if (isBlogVisibility(visibility)) data.visibility = visibility;
    if (typeof commentsEnabled === 'boolean') data.commentsEnabled = commentsEnabled;
    // validate() has already rejected an unacceptable value, so a non-null
    // result here is the one to store — including '' , which clears the hero.
    if (heroImage !== undefined) data.heroImage = normalizeHeroImage(heroImage) ?? '';

    // publishedAt defaults to row creation, which for a draft is when the author
    // started writing, not when anyone could read it. Stamp it at the moment the
    // post first leaves private so the byline reports publication, not drafting.
    if (existing.visibility === 'private' && isBlogVisibility(visibility) && visibility !== 'private') {
      data.publishedAt = new Date();
    }
    if (Object.keys(data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    // Renaming re-slugs only while the post is still private — i.e. still a
    // draft nobody can have linked to. Once it has been public or friends-
    // visible, the URL is somebody's bookmark and its comment thread's identity,
    // so the slug is frozen even if the title changes.
    if (typeof data.title === 'string' && existing.visibility === 'private') {
      const taken = new Set(
        (await prisma.blogPost.findMany({
          where: { userId: req.userId!, NOT: { id: existing.id } },
          select: { slug: true },
        })).map(p => p.slug),
      );
      const slug = uniqueSlug(slugify(data.title), taken);
      if (slug !== existing.slug) {
        const url = postUrlFor(existing.user.username, slug);
        data.slug = slug;
        data.url = url;
        data.articleKey = canonicalArticleKey(url);
      }
    }

    const post = await prisma.blogPost.update({
      where: { id: existing.id },
      data,
      select: FULL_SELECT,
    });

    // Best-effort: make the change show up in subscribers' folders now rather
    // than after the 30-minute stale window. Never fail the write over it.
    invalidateBlogFeeds(req.userId!).catch(err =>
      logger.warn(err, 'Blog feed invalidation failed'));

    // Only the transition into 'friends' notifies, so editing an already-shared
    // post doesn't tell everyone about it again.
    if (post.visibility === 'friends' && existing.visibility !== 'friends') {
      await notifyFriendsOfPost(req.userId!, post).catch(err =>
        logger.warn(err, 'Blog post notification failed'));
    }

    res.json(toJson(post));
  } catch (err) {
    logger.error(err, 'Update blog post error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/blogs/post/:id — author only. The comment thread is keyed on the
// post's URL rather than a foreign key, so it is removed explicitly here; leaving
// it behind would let a future post reusing the slug inherit a stale thread.
router.delete('/post/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const post = await prisma.blogPost.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true, articleKey: true },
    });
    if (!post) { res.status(404).json({ error: 'Not found' }); return; }

    await prisma.$transaction([
      prisma.comment.deleteMany({ where: { articleKey: post.articleKey } }),
      prisma.blogPost.delete({ where: { id: post.id } }),
    ]);

    // Best-effort: make the change show up in subscribers' folders now rather
    // than after the 30-minute stale window. Never fail the write over it.
    invalidateBlogFeeds(req.userId!).catch(err =>
      logger.warn(err, 'Blog feed invalidation failed'));

    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Delete blog post error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Feeds ────────────────────────────────────────────────────────────────────
// Declared before /:username so "feed" isn't read as a username.

// GET /api/v1/blogs/feed/:token.xml — the caller's personal aggregate feed.
// Deliberately unauthenticated: the token *is* the credential, which is what
// lets an external RSS reader subscribe. It is therefore a bearer secret —
// treated as such everywhere, and rotatable below.
router.get('/feed/:token.xml', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const xml = await renderBlogFeed({ kind: 'personal', token: req.params.token });
    res.type('application/rss+xml').send(xml);
  } catch (err) {
    logger.error(err, 'Personal blog feed error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/blogs/:username/feed.xml — a user's public blog feed.
// Public posts only: this URL is fetched with no viewer identity, and the
// FeedItem rows behind it are shared by every subscriber.
router.get('/:username/feed.xml', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const xml = await renderBlogFeed({ kind: 'user', username: req.params.username });
    res.type('application/rss+xml').send(xml);
  } catch (err) {
    logger.error(err, 'Blog feed error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/blogs/feed-token — your own personal feed URL, minted on first
// request. Never returned for anyone else.
router.get('/feed-token', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ url: personalFeedUrlFor(await ensureFeedToken(req.userId!)) });
  } catch (err) {
    logger.error(err, 'Feed token error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/blogs/feed-token/rotate — revoke a leaked feed URL.
router.post('/feed-token/rotate', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = newFeedToken();
    await prisma.user.update({ where: { id: req.userId! }, data: { feedToken: token } });
    res.json({ url: personalFeedUrlFor(token) });
  } catch (err) {
    logger.error(err, 'Feed token rotate error');
    res.status(500).json({ error: 'Server error' });
  }
});

function newFeedToken(): string {
  return randomBytes(24).toString('base64url');
}

// Tokens are minted on demand rather than at signup, so accounts that never look
// at the feed never carry one.
async function ensureFeedToken(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { feedToken: true } });
  if (user?.feedToken) return user.feedToken;
  const token = newFeedToken();
  await prisma.user.update({ where: { id: userId }, data: { feedToken: token } });
  return token;
}

// ── Following a blog ─────────────────────────────────────────────────────────

// POST /api/v1/blogs/:username/follow  { folderId }
// "Bookmarking their profile": subscribes the folder to their blog feed (so
// their posts appear in that folder's article list, as any RSS item does) and
// creates a bookmark tile pointing at their profile, so they show up in the
// sidebar with an unread badge like any other site.
router.post('/:username/follow', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { folderId } = req.body as Record<string, unknown>;
  if (typeof folderId !== 'string') { res.status(400).json({ error: 'folderId is required' }); return; }

  try {
    const owner = await prisma.user.findFirst({
      where: { username: { equals: req.params.username, mode: 'insensitive' }, bannedAt: null },
      select: { ...PUBLIC_USER_SELECT },
    });
    if (!owner) { res.status(404).json({ error: 'Profile not found' }); return; }
    if (owner.id === req.userId) { res.status(400).json({ error: 'You already have your own posts' }); return; }

    const folder = await prisma.folder.findFirst({
      where: { id: folderId, userId: req.userId! },
      select: { id: true, feedUrls: true },
    });
    if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

    const feedUrl = blogFeedUrlFor(owner.username);
    const profileUrl = `${publicOrigin()}/u/${encodeURIComponent(owner.username)}`;

    if (!folder.feedUrls.includes(feedUrl)) {
      await prisma.folder.update({
        where: { id: folder.id },
        data: { feedUrls: { set: [...folder.feedUrls, feedUrl] } },
      });
    }
    // Register the Feed row and pull the posts in now, so the folder isn't empty
    // on the first look.
    await ensureFeeds([feedUrl]);

    const existing = await prisma.bookmark.findFirst({
      where: { userId: req.userId!, feedUrl },
      select: { id: true },
    });
    if (!existing) {
      const count = await prisma.bookmark.count({ where: { folderId: folder.id, userId: req.userId! } });
      await prisma.bookmark.create({
        data: {
          userId: req.userId!,
          folderId: folder.id,
          domain: profileUrl,
          name: displayNameOf(owner),
          // Their avatar stands in for a favicon; SiteTile falls back to the
          // first letter when it's blank, which is the right look for a person.
          faviconUrl: owner.avatar ?? '',
          color: '#6366f1',
          position: count,
          feedUrl,
        },
      });
    }

    res.json({ ok: true, feedUrl });
  } catch (err) {
    logger.error(err, 'Follow blog error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/blogs/:username/follow — reverses both halves of the follow.
router.delete('/:username/follow', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const feedUrl = blogFeedUrlFor(req.params.username);
    const folders = await prisma.folder.findMany({
      where: { userId: req.userId!, feedUrls: { has: feedUrl } },
      select: { id: true, feedUrls: true },
    });
    await Promise.all(folders.map(f =>
      prisma.folder.update({
        where: { id: f.id },
        data: { feedUrls: { set: f.feedUrls.filter(u => u !== feedUrl) } },
      })
    ));
    await prisma.bookmark.deleteMany({ where: { userId: req.userId!, feedUrl } });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Unfollow blog error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/blogs/:username/follow — whether the caller already follows them.
router.get('/:username/follow', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const feedUrl = blogFeedUrlFor(req.params.username);
    const count = await prisma.folder.count({
      where: { userId: req.userId!, feedUrls: { has: feedUrl } },
    });
    res.json({ following: count > 0, feedUrl });
  } catch (err) {
    logger.error(err, 'Follow status error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Public routes ────────────────────────────────────────────────────────────

// GET /api/v1/blogs/:username/posts — the posts on someone's profile that this
// viewer is allowed to see.
router.get('/:username/posts', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const owner = await findOwner(req.params.username);
    if (!owner) { res.status(404).json({ error: 'Profile not found' }); return; }

    const friendIds = req.userId ? await friendIdsOf(req.userId) : new Set<string>();
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const rows = await prisma.blogPost.findMany({
      where: { userId: owner.id, ...visiblePostWhere(req.userId, friendIds) },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: SUMMARY_SELECT,
    });

    const hasMore = rows.length > PAGE_SIZE;
    const posts = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    res.json({ posts, nextCursor: hasMore ? posts[posts.length - 1].id : null });
  } catch (err) {
    logger.error(err, 'List blog posts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/blogs/:username/post/:slug — one post by its public URL.
// A post the viewer may not read answers 404, not 403: whether a private post
// exists at a given slug is itself something they should not learn.
router.get('/:username/post/:slug', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const owner = await findOwner(req.params.username);
    if (!owner) { res.status(404).json({ error: 'Not found' }); return; }

    const post = await prisma.blogPost.findFirst({
      where: { userId: owner.id, slug: req.params.slug },
      select: { ...FULL_SELECT, userId: true, user: { select: AUTHOR_SELECT } },
    });
    if (!post) { res.status(404).json({ error: 'Not found' }); return; }

    const friendIds = req.userId ? await friendIdsOf(req.userId) : new Set<string>();
    if (!canSeePost(post, req.userId, friendIds)) { res.status(404).json({ error: 'Not found' }); return; }

    const { userId, ...rest } = post;
    res.json({ ...toJson(rest as PostRow), isSelf: userId === req.userId });
  } catch (err) {
    logger.error(err, 'Load public blog post error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
