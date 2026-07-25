import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';
import { canonicalArticleKey, isHttpUrl } from '../lib/comments';

const router = Router();
// Feed items are shared across all users with nothing user-scoped to authorise,
// so the reader content is public — a shared /a/<id> thread link opens logged-out.
router.use(optionalAuth);

// Article detail for the reader modal, looked up by canonical URL rather than
// by feed-item id. That way a reading-list entry saved months ago resolves to
// the same stored article as the live feed card — the same key comments thread
// on. Feed items are shared across users, so there is nothing user-scoped to
// authorise beyond being signed in.
//
// Returns 200 with content:null when the URL isn't a stored feed item (a
// hand-saved link, or a feed that has since expired), so the modal can still
// open and show the comments.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const url = req.query.url;
  if (!isHttpUrl(url)) { res.status(400).json({ error: 'url must be an http(s) URL' }); return; }

  try {
    const key = canonicalArticleKey(url);
    const item = await prisma.feedItem.findFirst({
      where: { OR: [{ linkKey: key }, { link: url }] },
      // Prefer the row that actually carries content — the same article can sit
      // in several feeds, and only some of them ship full text
      orderBy: [{ content: { sort: 'desc', nulls: 'last' } }, { pubDate: 'desc' }],
      include: { feed: { select: { title: true } } },
    });

    if (!item) { res.json({ article: null }); return; }

    res.json({
      article: {
        id: item.id,
        title: item.title,
        link: item.link,
        source: item.feed?.title ?? '',
        pubDate: item.pubDate,
        readTime: item.readTime,
        snippet: item.snippet,
        content: item.content,
        imageUrl: item.imageUrl,
        categories: item.categories,
      },
    });
  } catch (err) {
    logger.error(err, 'Article detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
