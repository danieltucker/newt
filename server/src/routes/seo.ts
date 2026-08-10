import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { publicOrigin, postPathFor } from '../lib/blog';
import { renderUrlset, renderSitemapIndex, SITEMAP_PAGE_SIZE, SitemapUrl } from '../lib/sitemap';
import { indexableAuthorWhere } from '../lib/trust';
import logger from '../lib/logger';

// robots.txt and the sitemap: how a crawler is told what exists and what it may
// take. Split from routes/html.ts because those routes answer with documents and
// these answer with instructions, and because this is the file to open when the
// question is "what are we letting bots do", which is a policy question rather
// than a rendering one.

const router = Router();

// ── robots.txt ───────────────────────────────────────────────────────────────

/**
 * Crawlers that collect text to train language models, as distinct from crawlers
 * that index it so people can find it. Kept as a list rather than a wildcard
 * because the two things want different answers and only one of them sends
 * readers back.
 */
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'PerplexityBot',
  'Bytespider',
  'Meta-ExternalAgent',
  'Amazonbot',
];

/**
 * Whether the list above is allowed.
 *
 * Defaults to denying, and the reason is asymmetry rather than any position on
 * whether training is good: allowing later costs nothing, and denying later does
 * not un-train anything already taken. A default that can be reversed is the
 * right one to ship when the decision has not been made explicitly.
 *
 * Set AI_CRAWLERS=allow to reverse it. It is one environment variable rather
 * than a settings row because it is a property of the deployment — a self-hosted
 * instance should get to answer it differently, and the person who can edit the
 * compose file is exactly the person entitled to.
 */
function aiCrawlersAllowed(): boolean {
  return (process.env.AI_CRAWLERS || '').trim().toLowerCase() === 'allow';
}

router.get('/robots.txt', (_req: Request, res: Response): void => {
  const origin = publicOrigin();

  const lines = [
    '# Newt — https://github.com/danieltucker/newt',
    '',
    'User-agent: *',
    // The API is machinery, not content. The one exception is the blog feeds:
    // they are a public, intentional way to follow an author, and a crawler that
    // finds one has found something real.
    'Disallow: /api/',
    'Allow: /api/v1/blogs/$',
    'Allow: /api/v1/blogs/*/feed.xml$',
    // Signed-in surfaces. They render nothing without a token, so a crawler that
    // fetches one has spent a request to receive the empty app shell.
    'Disallow: /blog',
    'Disallow: /settings',
    'Disallow: /signin',
    'Disallow: /signup',
    '',
    // Deliberately NOT disallowing /a/. Those pages carry <meta name="robots"
    // content="noindex">, and a page a crawler is forbidden to fetch is a page
    // whose noindex it can never read — which is how a URL ends up indexed with
    // no content rather than not indexed at all. To keep something out of an
    // index, let it be crawled and let it say so.
    '# /a/ thread pages are crawlable on purpose: they carry a noindex that a',
    '# crawler has to fetch the page to see.',
    '',
  ];

  if (!aiCrawlersAllowed()) {
    lines.push('# Model-training and AI-answer crawlers. Set AI_CRAWLERS=allow to permit.');
    for (const bot of AI_CRAWLERS) {
      lines.push(`User-agent: ${bot}`, 'Disallow: /', '');
    }
  }

  lines.push(`Sitemap: ${origin}/sitemap.xml`, '');

  res.type('text/plain').send(lines.join('\n'));
});

// ── Sitemap ──────────────────────────────────────────────────────────────────

// Generated on request and held briefly. At the scale where that stops being
// reasonable — a hundred thousand posts, where the query is seconds and the
// document is megabytes — this is the thing to move onto the scheduler in
// lib/feedScheduler.ts and write to disk. The shape of the output does not
// change when that happens, which is the point of shipping the index below even
// while there is only one shard of each kind.
const CACHE_TTL_MS = 60 * 60_000;
const cache = new Map<string, { body: string; at: number }>();

export function clearSitemapCache(): void {
  cache.clear();
}

async function cached(key: string, build: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  const body = await build();
  cache.set(key, { body, at: Date.now() });
  return body;
}

function sendXml(res: Response, body: string): void {
  res.type('application/xml').send(body);
}

router.get('/sitemap.xml', async (_req: Request, res: Response): Promise<void> => {
  try {
    const origin = publicOrigin();
    const body = await cached('index', async () => {
      const where = { visibility: 'public', user: indexableAuthorWhere() };
      const [postCount, authorCount, newest] = await Promise.all([
        prisma.blogPost.count({ where }),
        prisma.user.count({ where: { ...indexableAuthorWhere(), blogPosts: { some: { visibility: 'public' } } } }),
        prisma.blogPost.findFirst({ where, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      ]);

      const shards = [];
      for (let i = 0; i < Math.max(1, Math.ceil(postCount / SITEMAP_PAGE_SIZE)); i++) {
        shards.push({ loc: `${origin}/sitemap-posts-${i + 1}.xml`, lastmod: newest?.updatedAt ?? null });
      }
      for (let i = 0; i < Math.max(1, Math.ceil(authorCount / SITEMAP_PAGE_SIZE)); i++) {
        shards.push({ loc: `${origin}/sitemap-profiles-${i + 1}.xml`, lastmod: newest?.updatedAt ?? null });
      }
      return renderSitemapIndex(shards);
    });
    sendXml(res, body);
  } catch (err) {
    logger.error(err, 'Sitemap index error');
    res.status(500).type('text/plain').send('');
  }
});

// The page number out of a shard name, 1-based, or null if it is not one.
function shardPage(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

router.get('/sitemap-posts-:page.xml', async (req: Request, res: Response): Promise<void> => {
  const page = shardPage(req.params.page);
  if (page === null) { res.status(404).type('text/plain').send(''); return; }

  try {
    const origin = publicOrigin();
    const body = await cached(`posts-${page}`, async () => {
      const rows = await prisma.blogPost.findMany({
        where: { visibility: 'public', user: indexableAuthorWhere() },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * SITEMAP_PAGE_SIZE,
        take: SITEMAP_PAGE_SIZE,
        select: { slug: true, updatedAt: true, user: { select: { username: true } } },
      });
      const urls: SitemapUrl[] = rows.map(r => ({
        loc: `${origin}${postPathFor(r.user.username, r.slug)}`,
        lastmod: r.updatedAt,
      }));
      return renderUrlset(urls);
    });
    sendXml(res, body);
  } catch (err) {
    logger.error(err, 'Sitemap posts error');
    res.status(500).type('text/plain').send('');
  }
});

router.get('/sitemap-profiles-:page.xml', async (req: Request, res: Response): Promise<void> => {
  const page = shardPage(req.params.page);
  if (page === null) { res.status(404).type('text/plain').send(''); return; }

  try {
    const origin = publicOrigin();
    const body = await cached(`profiles-${page}`, async () => {
      // Only profiles with something on them. An empty profile is a thin page,
      // and the routes/html.ts archive already declines to be indexed for one —
      // listing it here would be asking a crawler to spend a fetch learning that.
      const rows = await prisma.user.findMany({
        where: { ...indexableAuthorWhere(), blogPosts: { some: { visibility: 'public' } } },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * SITEMAP_PAGE_SIZE,
        take: SITEMAP_PAGE_SIZE,
        select: { username: true },
      });
      const urls: SitemapUrl[] = rows.map(r => ({
        loc: `${origin}/u/${encodeURIComponent(r.username)}`,
        changefreq: 'weekly',
      }));
      return renderUrlset(urls);
    });
    sendXml(res, body);
  } catch (err) {
    logger.error(err, 'Sitemap profiles error');
    res.status(500).type('text/plain').send('');
  }
});

export default router;
