import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perUserLimiter } from '../lib/rateLimit';
import { searchArticles } from '../lib/articleSearch';
import { searchPosts, searchPostsByTag, searchExplores } from '../lib/search';
import logger from '../lib/logger';

/**
 * The search page's one request.
 *
 * Three corpora, one round trip, deliberately. The alternative — a request per
 * kind — would give each section its own spinner and its own failure, and a
 * page that fills in three staggered pieces reads as three features rather than
 * one answer. They run concurrently here instead.
 *
 * Signed-in only, like every route on this router. Two of the three corpora are
 * scoped to the reader (their subscriptions, their visibility tiers), so there
 * is no coherent signed-out version of this page — see the client's routing,
 * where /search falls through to the landing page rather than a sign-in wall.
 */
const router = Router();
router.use(requireAuth);

// The page is not a keystroke-driven dropdown, so this is looser per query than
// /feeds/search — but each request is now up to three index lookups rather than
// one, so the ceiling lands in the same place.
const searchLimiter = perUserLimiter({
  windowMs: 60_000, max: 60,
  message: 'Too many searches — please slow down for a moment.',
});

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;

/**
 * How deep paging is allowed to go.
 *
 * Not a page count but a row count, because the cost of a page is not flat: the
 * posts and explores searches rank a window and then filter it (see
 * lib/search), so asking for row 5,000 means ranking 5,000 rows to hand back
 * twenty. Past a few hundred results nobody is reading, they are re-searching -
 * so the honest answer at that depth is "narrow the query", not a slower page.
 */
const MAX_OFFSET = 400;

/** The corpora, by the name the client asks for them by. */
const KINDS = ['articles', 'posts', 'explores'] as const;
type Kind = (typeof KINDS)[number];

/**
 * Which corpora to search.
 *
 * Absent means all of them — the page's default tab. A `kinds` list is what the
 * filter tabs send, so a reader looking only at Posts is not paying for two
 * searches whose results are off screen.
 */
function kindsOf(raw: unknown): Set<Kind> {
  if (typeof raw !== 'string' || !raw.trim()) return new Set(KINDS);
  const asked = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  const valid = KINDS.filter(k => asked.has(k));
  // An unrecognised list means everything rather than nothing: a typo in a
  // hand-edited URL should show results, not an empty page that looks broken.
  return valid.length ? new Set(valid) : new Set(KINDS);
}

router.get('/', searchLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const raw = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(LIMIT_MAX, Math.max(1,
    parseInt(req.query.limit as string || '') || LIMIT_DEFAULT));
  const offset = Math.min(MAX_OFFSET, Math.max(0,
    parseInt(req.query.offset as string || '') || 0));
  const kinds = kindsOf(req.query.kinds);
  const userId = req.userId!;
  // The search box's `#tag` prefix, carried through rather than reinterpreted
  // as text. Articles match their publisher's categories and posts match their
  // author's tags; explores have neither, so a tag search returns none rather
  // than quietly falling back to a text search that would answer a different
  // question with the same-looking list.
  const tagged = req.query.mode === 'tag';

  // One more than asked for, from every corpus. That extra row is the whole
  // answer to "is there a next page": a count would have to re-run the match
  // with the visibility rules applied to every row rather than to one page of
  // them, and on two of these three corpora there is no cheap way to do that.
  // So the page reports `more` rather than a total, and says "20+" rather than
  // claiming a number it would be guessing at.
  const span = limit + 1;

  try {
    const [articles, posts, explores] = await Promise.all([
      kinds.has('articles')
        ? searchArticles(userId, raw, { tagged, limit: span, offset })
        : Promise.resolve([]),
      kinds.has('posts')
        ? (tagged
            ? searchPostsByTag(userId, raw, span, offset)
            : searchPosts(userId, raw, span, offset))
        : Promise.resolve([]),
      kinds.has('explores') && !tagged
        ? searchExplores(userId, raw, span, offset)
        : Promise.resolve([]),
    ]);

    res.json({
      articles: articles.slice(0, limit)
        .map(a => ({ ...a, pubDate: a.pubDate?.toISOString() ?? null })),
      posts: posts.slice(0, limit),
      explores: explores.slice(0, limit),
      // Per corpus, because they run out at different depths: the archive may
      // have another two hundred while the posts ran dry at four.
      more: {
        articles: articles.length > limit,
        posts: posts.length > limit,
        explores: explores.length > limit,
      },
      // Where the next page starts. Echoed rather than left to the client to
      // work out, so a page it did not ask for cannot be requested by mistake.
      offset,
    });
  } catch (err) {
    logger.error(err, 'Search error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
