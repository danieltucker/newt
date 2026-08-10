import { randomBytes } from 'crypto';
import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { PUBLIC_USER_SELECT, toPublicUser, friendIdsOf, displayNameOf } from '../lib/friends';
import { isWalledOff } from '../lib/blocks';
import { canonicalArticleKey, isBlankHtml } from '../lib/comments';
import { perUserLimiter } from '../lib/rateLimit';
import { ensureFeeds } from '../lib/feedRefresh';
import { addFeedSubscription } from '../lib/feedSubscriptions';
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
  profileUrlFor,
  excerptOf,
  canSeePost,
  visiblePostWhere,
  isBlogVisibility,
  normalizeHeroImage,
  normalizeTags,
  MAX_POST_TAGS,
  MAX_TAG_LENGTH,
  MAX_BLOG_BODY,
  MAX_BLOG_TEXT,
  MAX_BLOG_TITLE,
} from '../lib/blog';
import { normalizeTag, tagPostsWhere, TAG_PAGE_SIZE } from '../lib/tags';
import { eligibleAuthorIds } from '../lib/recent';

// What /recent hands the app. Larger than the crawlable document's thirty, since
// the page scrolls and a second request for the next ten would be silly.
const RECENT_API_LIMIT = 50;

// Blog posts. Reads run under optionalAuth so a public post opens for a
// logged-out visitor (the same way a shared /a/<id> thread link does); writes
// opt back in with requireAuth.
const router = Router();
router.use(optionalAuth);

const PAGE_SIZE = 20;

// The profile's post list carries whole bodies rather than excerpts, so a page
// of it is worth far more bytes than a page of anything else here — a post may
// run to MAX_BLOG_TEXT. Fewer per request, and the reader pages for more.
const FEED_PAGE_SIZE = 5;

// There to stop scripted flooding, not to pace a real author. The old ceiling
// of 60/hour was set when every save was a deliberate button press; the editor
// now autosaves a draft as it is written, so a single long writing session is
// legitimately worth dozens of writes. The client throttles itself to one
// autosave per 15s (see AUTOSAVE_MIN_GAP_MS), which tops out well under this.
const blogWriteLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 300,
  message: "You've hit the hourly limit for blog edits — please try again later.",
});

const AUTHOR_SELECT = PUBLIC_USER_SELECT;

// Everything the client needs to render a post, minus the body (list views).
const SUMMARY_SELECT = {
  id: true, title: true, slug: true, excerpt: true, heroImage: true, tags: true, visibility: true,
  commentsEnabled: true, url: true, publishedAt: true, updatedAt: true,
} as const;

const FULL_SELECT = { ...SUMMARY_SELECT, body: true, articleKey: true } as const;

type PostRow = {
  id: string; title: string; slug: string; excerpt: string; heroImage: string; tags: string[];
  visibility: string;
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
  const { title, body, visibility, commentsEnabled, heroImage, tags } = b;

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
  // normalizeTags recovers case, spacing, '#' and duplicates on its own, so the
  // only ways to land here are a shape that isn't a list of strings, a tag too
  // long to be a label, or too many of them — say which of those it is.
  if (tags !== undefined && normalizeTags(tags) === null) {
    return Array.isArray(tags)
      ? `Keep it to ${MAX_POST_TAGS} tags of ${MAX_TAG_LENGTH} characters or fewer`
      : 'tags must be a list of words';
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

  const { title, body, visibility, commentsEnabled, heroImage, tags } = req.body as Record<string, unknown>;

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
        tags: normalizeTags(tags) ?? [],
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

  const { title, body, visibility, commentsEnabled, heroImage, tags } = req.body as Record<string, unknown>;

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
    // Same rule as heroImage: the empty list is a real value (the author removed
    // the last tag), so an omitted field is the only thing that leaves tags be.
    if (tags !== undefined) data.tags = normalizeTags(tags) ?? [];

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
    // Subscribing to someone's feed is a way of following them, so the wall
    // applies. 404 keeps it indistinguishable from a profile that isn't there.
    if (await isWalledOff(req.userId, owner.id)) { res.status(404).json({ error: 'Profile not found' }); return; }

    const folder = await prisma.folder.findFirst({
      where: { id: folderId, userId: req.userId! },
      select: { id: true },
    });
    if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

    const feedUrl = blogFeedUrlFor(owner.username);
    const profileUrl = profileUrlFor(owner.username);

    // Seed the feed's name from the author's display name — a person's blog
    // reads better under their name than under the hostname it derives from.
    await addFeedSubscription(req.userId!, feedUrl, displayNameOf(owner));
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
    await prisma.feedSubscription.deleteMany({ where: { userId: req.userId!, url: feedUrl } });
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
    const count = await prisma.feedSubscription.count({
      where: { userId: req.userId!, url: feedUrl },
    });
    res.json({ following: count > 0, feedUrl });
  } catch (err) {
    logger.error(err, 'Follow status error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Public routes ────────────────────────────────────────────────────────────

// GET /api/v1/blogs/recent — the global recent-posts list, for the /recent page.
//
// Above /:username for the same reason /tags is: "recent" is a registrable
// username. See lib/recent.ts for who is eligible and why the bar is where it is.
router.get('/recent', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const authorIds = await eligibleAuthorIds();
    const rows = authorIds.length === 0 ? [] : await prisma.blogPost.findMany({
      where: { visibility: 'public', userId: { in: authorIds } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_API_LIMIT,
      select: { ...SUMMARY_SELECT, user: { select: AUTHOR_SELECT } },
    });
    res.json({ posts: rows.map(r => toJson(r as PostRow)) });
  } catch (err) {
    logger.error(err, 'List recent posts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/blogs/tags/:tag/posts — every author's public posts under one tag.
//
// Mounted above the /:username routes deliberately: "tags" is a perfectly legal
// username, and a route ordered after them would be shadowed the moment someone
// registered it.
//
// Public posts only, and no viewer-specific widening — unlike a profile, this is
// a shared surface and a friends-only post has no business appearing on one just
// because the reader happens to be a friend. It is the same list the crawlable
// /t/<tag> document renders, which is what keeps the page a visitor sees and the
// page Google sees the same page.
router.get('/tags/:tag/posts', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tag = normalizeTag(req.params.tag);
    if (!tag) { res.status(400).json({ error: 'Not a tag' }); return; }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const where = tagPostsWhere(tag);

    const [rows, total] = await Promise.all([
      prisma.blogPost.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * TAG_PAGE_SIZE,
        take: TAG_PAGE_SIZE,
        select: { ...SUMMARY_SELECT, user: { select: AUTHOR_SELECT } },
      }),
      prisma.blogPost.count({ where }),
    ]);

    res.json({
      tag,
      total,
      page,
      hasMore: page * TAG_PAGE_SIZE < total,
      posts: rows.map(r => toJson(r as PostRow)),
    });
  } catch (err) {
    logger.error(err, 'List tag posts error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/blogs/:username/posts — the posts on someone's profile that this
// viewer is allowed to see.
router.get('/:username/posts', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const owner = await findOwner(req.params.username);
    if (!owner) { res.status(404).json({ error: 'Profile not found' }); return; }
    // A walled-off author has no posts as far as this reader is concerned —
    // the same empty answer either side of the block gets.
    if (await isWalledOff(req.userId, owner.id)) { res.json({ posts: [], nextCursor: null }); return; }

    const friendIds = req.userId ? await friendIdsOf(req.userId) : new Set<string>();
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    // One tag, not a set: this backs clicking a tag on a post, which is a
    // question with one answer. Normalised through the same helper the write
    // path uses, so a link carrying "#News" finds the posts stored as "news".
    const tag = normalizeTags(
      typeof req.query.tag === 'string' ? [req.query.tag] : [],
    )?.[0];

    const rows = await prisma.blogPost.findMany({
      where: {
        userId: owner.id,
        ...(tag ? { tags: { has: tag } } : {}),
        // Drafts are not on the profile, the author's own included. This is a
        // separate clause from visiblePostWhere on purpose: that answers "may
        // this viewer read it", and for a draft's own author the answer is yes.
        // What it must not do is *publish* it here - a profile is the page you
        // hand to someone else, and an author reads their drafts in My posts.
        visibility: { not: 'private' },
        ...visiblePostWhere(req.userId, friendIds),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: FEED_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      // Bodies, not excerpts: the profile shows each post in full, the way a
      // blog's own index page does. See FEED_PAGE_SIZE for what that costs.
      select: FULL_SELECT,
    });

    const hasMore = rows.length > FEED_PAGE_SIZE;
    const posts = hasMore ? rows.slice(0, FEED_PAGE_SIZE) : rows;
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
    // 404 rather than a "blocked" message, matching how an unreadable private
    // post answers: the URL simply resolves to nothing for this reader.
    if (await isWalledOff(req.userId, owner.id)) { res.status(404).json({ error: 'Not found' }); return; }

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
