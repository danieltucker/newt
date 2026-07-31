import { Router, Response } from 'express';
import type { Readable } from 'stream';
import nodeFetch from 'node-fetch';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { isSafeUrl } from '../lib/isSafeUrl';
import { canonicalFeedKey } from '../lib/feedUtils';
import { ensureFeeds, refreshStaleFeeds } from '../lib/feedRefresh';
import { addFolderFeed } from '../lib/folderFeeds';
import { feedUnreadCount } from '../lib/unread';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

// ── Feed utilities ────────────────────────────────────────────────────────────

const FEED_PATHS = ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml', '/index.xml', '/blog/feed', '/feed/rss'];

function findFeedInHtml(html: string, base: string): string | null {
  for (const [, attrs] of html.matchAll(/<link([^>]+)>/gi)) {
    const isAlternate = /rel=["']alternate["']/i.test(attrs);
    const isFeed = /type=["'](application\/(rss|atom)\+xml)["']/i.test(attrs);
    if (isAlternate && isFeed) {
      const m = attrs.match(/href=["']([^"']+)["']/i);
      if (m) return m[1].startsWith('http') ? m[1] : new URL(m[1], base).toString();
    }
  }
  return null;
}

// Read at most `maxBytes` of a remote document. The byte budget is the point:
// the URL is attacker-chosen (anyone can add a bookmark for any domain), so an
// endless or enormous response must not be allowed to buffer into the heap.
//
// Reaching the cap resolves with what we have *and destroys the stream* — without
// that the socket stays open and the origin keeps sending forever, since the 5s
// timeout only fires on an idle socket, not a slow-but-steady one.
async function fetchXml(url: string, maxBytes = 150_000): Promise<string | null> {
  try {
    const res = await nodeFetch(url, { timeout: 5000, size: maxBytes * 2, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewTab/1.0)' } } as FetchOptions);
    // node-fetch v2 hands back a Node Readable at runtime; the ambient DOM lib
    // types it as a web ReadableStream, which has no destroy().
    const body = res.body as unknown as Readable | null;
    if (!res.ok) { body?.destroy(); return null; }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    return await new Promise<string | null>(resolve => {
      const finish = (v: string | null) => {
        if (settled) return;
        settled = true;
        body!.destroy();
        resolve(v);
      };
      res.body!.on('data', (c: Buffer) => { if (settled) return; chunks.push(c); size += c.length; if (size >= maxBytes) finish(Buffer.concat(chunks).toString('utf8')); });
      res.body!.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      res.body!.on('error', () => finish(null));
    });
  } catch { return null; }
}

function isFeedXml(text: string): boolean {
  const t = text.trimStart();
  return (t.startsWith('<?xml') || t.startsWith('<rss') || t.startsWith('<feed')) &&
    (text.includes('<item') || text.includes('<entry') || text.includes('<channel'));
}

async function discoverFeed(domain: string): Promise<string | null> {
  const base = `https://${domain}`;
  // 1. Parse homepage HTML for <link rel="alternate">
  if (await isSafeUrl(base)) {
    const html = await fetchXml(base, 500_000);
    if (html) {
      const found = findFeedInHtml(html, base);
      if (found && await isSafeUrl(found)) {
        const xml = await fetchXml(found, 8_000);
        if (xml && isFeedXml(xml)) return found;
      }
    }
  }
  // 2. Try common paths
  for (const path of FEED_PATHS) {
    const url = `${base}${path}`;
    if (!(await isSafeUrl(url))) continue;
    const xml = await fetchXml(url, 8_000);
    if (xml && isFeedXml(xml)) return url;
  }
  return null;
}

const router = Router();
router.use(requireAuth);

// A ceiling on how much of the database one account can occupy. /import accepts
// 500 rows a call and nothing stopped an account from calling it repeatedly, so
// row growth was bounded only by the per-IP request limiter — which an authed
// client rotating IPs sidesteps entirely. Every bookmark also becomes feed work
// later (discovery, then polling forever), so this cap is as much about outbound
// fetch load as about disk.
const MAX_BOOKMARKS_PER_USER = 2000;

// Per-account, so it survives IP rotation the way the comment and friend limits
// do. Generous, because ordinary browsing writes: /:id/visited fires on every
// bookmark click and pin/unpin are one-tap actions.
const bookmarkWriteLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 600,
  message: 'Too many changes — please slow down for a moment.',
});
router.use((req, res, next) => {
  // Reads stay on the shared per-IP limiter; only writes are metered per account.
  if (req.method === 'GET') { next(); return; }
  bookmarkWriteLimiter(req, res, next);
});

// Returns all bookmarks for the user in one query — used for the initial bulk load
router.get('/all', async (req: AuthRequest, res: Response): Promise<void> => {
  const bookmarks = await prisma.bookmark.findMany({
    where: { userId: req.userId! },
    orderBy: { position: 'asc' },
  });
  res.json(bookmarks);
});

router.post('/import', async (req: AuthRequest, res: Response): Promise<void> => {
  const { folderId, bookmarks } = req.body;
  if (!folderId || !Array.isArray(bookmarks) || bookmarks.length === 0) {
    res.status(400).json({ error: 'folderId and bookmarks array required' }); return;
  }
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: req.userId! } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const existing = await prisma.bookmark.findMany({
    where: { folderId, userId: req.userId! },
    select: { domain: true, position: true },
  });
  const existingDomains = new Set(existing.map(b => b.domain));
  const nextPosition = existing.length > 0 ? Math.max(...existing.map(b => b.position)) + 1 : 0;

  // Trim to whatever room is left in the account's budget rather than rejecting
  // the whole import: a browser export is usually mostly duplicates, and failing
  // the entire call because the tail would overflow is a worse answer than
  // importing what fits and reporting the rest as skipped.
  const totalOwned = await prisma.bookmark.count({ where: { userId: req.userId! } });
  const remaining = Math.max(0, MAX_BOOKMARKS_PER_USER - totalOwned);

  const toCreate = (bookmarks as { name: string; domain: string; color: string }[])
    .filter(b => b.domain && b.name && !existingDomains.has(b.domain))
    .slice(0, Math.min(500, remaining));

  if (toCreate.length > 0) {
    await prisma.bookmark.createMany({
      data: toCreate.map((b, i) => ({
        folderId,
        userId: req.userId!,
        domain: b.domain,
        name: b.name,
        faviconUrl: `https://www.google.com/s2/favicons?domain=${b.domain}&sz=128`,
        color: b.color || '#5E6AD2',
        position: nextPosition + i,
      })),
    });
  }

  res.json({
    created: toCreate.length,
    skipped: bookmarks.length - toCreate.length,
    // Lets the client say "you've reached the limit" instead of silently
    // dropping the tail of the file the user just picked.
    atCap: remaining === 0,
    limit: MAX_BOOKMARKS_PER_USER,
  });
});

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { folderId } = req.query;
  if (!folderId) { res.status(400).json({ error: 'folderId required' }); return; }
  const bookmarks = await prisma.bookmark.findMany({
    where: { folderId: folderId as string, userId: req.userId! },
    orderBy: { position: 'asc' },
  });
  res.json(bookmarks);
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { folderId, domain, name, faviconUrl, color } = req.body;
  if (!folderId || !domain || !name) {
    res.status(400).json({ error: 'folderId, domain, and name required' });
    return;
  }
  const owned = await prisma.bookmark.count({ where: { userId: req.userId! } });
  if (owned >= MAX_BOOKMARKS_PER_USER) {
    res.status(409).json({ error: `You've reached the limit of ${MAX_BOOKMARKS_PER_USER} bookmarks.` });
    return;
  }
  if (typeof name !== 'string' || name.length > 100) { res.status(400).json({ error: 'name must be ≤100 characters' }); return; }
  if (typeof domain !== 'string' || domain.length > 253) { res.status(400).json({ error: 'domain must be ≤253 characters' }); return; }
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: req.userId! } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  const count = await prisma.bookmark.count({ where: { folderId, userId: req.userId! } });
  const bookmark = await prisma.bookmark.create({
    data: {
      folderId,
      userId: req.userId!,
      domain,
      name,
      faviconUrl: faviconUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      color: color || '#5E6AD2',
      position: count,
    },
  });
  res.status(201).json(bookmark);

  // Fire-and-forget: discover the site's RSS feed and add it to the folder,
  // so feed articles appear automatically. Removable from the folder's edit
  // modal; disabled entirely when the user turns RSS off in settings.
  autoAddFeed(req.userId!, bookmark.id, folderId, domain).catch(err =>
    logger.warn(err, 'Feed auto-add failed')
  );
});

async function autoAddFeed(userId: string, bookmarkId: string, folderId: string, domain: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = user?.settings as { rssEnabled?: boolean } | null;
  if (settings?.rssEnabled === false) return;

  const feedUrl = await discoverFeed(domain);
  if (!feedUrl) return;

  // Remember it on the bookmark (drives the unread badge)
  await prisma.bookmark.updateMany({ where: { id: bookmarkId, userId }, data: { feedUrl } });

  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId }, select: { id: true } });
  if (!folder) return;
  // Compare canonically so a folder already subscribed via a different spelling
  // of the same feed doesn't pick up a duplicate.
  const key = canonicalFeedKey(feedUrl);
  const existing = await prisma.folderFeed.findMany({ where: { folderId }, select: { url: true } });
  if (existing.some(f => canonicalFeedKey(f.url) === key)) return;
  await addFolderFeed(userId, folderId, feedUrl);
}

router.put('/reorder', async (req: AuthRequest, res: Response): Promise<void> => {
  const items: { id: string; position: number }[] = req.body;
  if (!Array.isArray(items)) { res.status(400).json({ error: 'Array expected' }); return; }
  await prisma.$transaction(
    items.map(({ id, position }) =>
      prisma.bookmark.updateMany({ where: { id, userId: req.userId! }, data: { position } })
    )
  );
  res.json({ ok: true });
});

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, domain, faviconUrl, color, folderId } = req.body;
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await prisma.bookmark.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(domain !== undefined && { domain }),
      ...(faviconUrl !== undefined && { faviconUrl }),
      ...(color !== undefined && { color }),
      ...(folderId !== undefined && { folderId }),
    },
  });
  res.json(updated);
});

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await prisma.bookmark.deleteMany({
    where: { id: req.params.id, userId: req.userId! },
  });
  if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});

// Updates a bookmark's unread badge. The feed itself is fetched through the
// shared Feed table, so two users watching the same site (or a site that's also
// a folder feed) trigger at most one outbound request — the per-bookmark fetch
// this used to do is gone.
router.post('/:id/check-feed', async (req: AuthRequest, res: Response): Promise<void> => {
  const bookmark = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!bookmark) { res.status(404).json({ error: 'Not found' }); return; }

  let feedUrl = bookmark.feedUrl ?? null;
  if (!feedUrl) feedUrl = await discoverFeed(bookmark.domain);

  if (!feedUrl) {
    // No feed — just record the check so we don't re-run discovery every cycle.
    const updated = await prisma.bookmark.update({
      where: { id: bookmark.id },
      data: { feedCheckedAt: new Date() },
    });
    res.json(updated);
    return;
  }

  // Resolve to the shared Feed row and make sure it has items. First time we
  // wait so the badge is meaningful; otherwise refresh in the background — both
  // paths are claim-protected, so concurrent callers don't duplicate the fetch.
  const [feed] = await ensureFeeds([feedUrl]);
  if (feed) {
    if (!feed.lastCheckedAt) await refreshStaleFeeds([feed]);
    else refreshStaleFeeds([feed]).catch(() => {});
  }

  // Unread = shared items in this feed the user hasn't read or dismissed — the
  // same read-state the RSS reader writes, so the badge and the feed's "new"
  // outlines never disagree and a background check can't resurrect a count the
  // user already cleared. Idempotent by construction.
  let unreadCount = 0;
  let feedLatestAt: Date | undefined;
  if (feed) {
    unreadCount = await feedUnreadCount(req.userId!, feed.id, bookmark.folderId);
    const latest = await prisma.feedItem.findFirst({
      where: { feedId: feed.id },
      orderBy: { pubDate: 'desc' },
      select: { pubDate: true },
    });
    feedLatestAt = latest?.pubDate ?? undefined;
  }

  const updated = await prisma.bookmark.update({
    where: { id: bookmark.id },
    data: {
      feedUrl,
      feedCheckedAt: new Date(),
      unreadCount,
      ...(feedLatestAt && { feedLatestAt }),
    },
  });
  res.json(updated);
});

// Pin a bookmark: surface it in the sidebar's top pin grid. The bookmark keeps
// its folder — pinning is a view flag, not a move. Position orders the pin grid.
router.post('/:id/pin', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const pinnedCount = await prisma.bookmark.count({ where: { userId: req.userId!, pinned: true } });
  const updated = await prisma.bookmark.update({
    where: { id: existing.id },
    data: { pinned: true, position: pinnedCount },
  });
  res.json(updated);
});

// Unpin: drop it from the pin grid. It reappears in its (retained) folder,
// appended to the end of that folder's list.
router.post('/:id/unpin', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const count = await prisma.bookmark.count({
    where: { userId: req.userId!, folderId: existing.folderId, pinned: false },
  });
  const updated = await prisma.bookmark.update({
    where: { id: existing.id },
    data: { pinned: false, position: count },
  });
  res.json(updated);
});

// Opening a site clears its badge. To keep that durable — and to keep the badge
// in step with the RSS reader — visiting also marks the site's feed items read,
// so the next check-feed recomputes to zero instead of resurrecting the count.
router.post('/:id/visited', async (req: AuthRequest, res: Response): Promise<void> => {
  const existing = await prisma.bookmark.findFirst({ where: { id: req.params.id, userId: req.userId! } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  if (existing.feedUrl) {
    const [feed] = await ensureFeeds([existing.feedUrl]);
    if (feed) {
      const items = await prisma.feedItem.findMany({
        where: { feedId: feed.id, reads: { none: { userId: req.userId! } } },
        select: { id: true },
        take: 5000,
      });
      if (items.length > 0) {
        await prisma.readFeedItem.createMany({
          data: items.map(i => ({ userId: req.userId!, itemId: i.id })),
          skipDuplicates: true,
        });
      }
    }
  }

  await prisma.bookmark.update({
    where: { id: req.params.id },
    data: { lastVisitedAt: new Date(), unreadCount: 0 },
  });
  res.json({ ok: true });
});

export default router;
