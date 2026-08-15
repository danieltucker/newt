import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perUserLimiter } from '../lib/rateLimit';
import { canonicalArticleKey } from '../lib/comments';

const router = Router();
router.use(requireAuth);

// Saved articles carry notes of up to 50,000 characters each, so this is the
// heaviest per-row table a user can grow at will. Same reasoning as the bookmark
// cap: bound it per account, not just per IP. The GET already takes 500, so
// anything past that was invisible in the UI anyway.
const MAX_READING_LIST_ITEMS = 1000;

const readingWriteLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 600,
  message: 'Too many changes — please slow down for a moment.',
});
router.use((req, res, next) => {
  if (req.method === 'GET') { next(); return; }
  readingWriteLimiter(req, res, next);
});

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const items = await prisma.readingListItem.findMany({
    where: { userId: req.userId! },
    orderBy: { savedAt: 'desc' },
    take: 500,
  });
  res.json(items);
});

// Empty string is allowed (no image); otherwise must be a sane http(s) URL
function validImageUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const parsed = new URL(v);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return v;
}

/**
 * The copy of this article already sitting in that place, if there is one.
 *
 * One copy per destination, where a destination is a Library shelf or — for
 * `folderId: null` — the unfiled pile the reading list and Unsorted share.
 * Saving the same piece twice was the easiest list to end up with: the feed
 * re-deals an article whenever its publisher touches it, and the bookmarklet
 * has no idea what is already saved. Filing the same article onto two different
 * shelves is still allowed; that is a decision, not an accident.
 *
 * Matched on the canonical key rather than the raw string, so the copy arriving
 * from the river with a `?utm_source=` on it is recognised as the one saved from
 * the bookmarklet — the same rule that decides which comment thread those two
 * share. The URLs are read in a projection of their own because the rows carry
 * up to 50,000 characters of notes each, none of which this needs.
 */
async function findCopyIn(userId: string, folderId: string | null, url: string) {
  const key = canonicalArticleKey(url);
  const siblings = await prisma.readingListItem.findMany({
    where: { userId, folderId },
    select: { id: true, url: true },
  });
  const hit = siblings.find(s => canonicalArticleKey(s.url) === key);
  return hit ? prisma.readingListItem.findFirst({ where: { id: hit.id, userId } }) : null;
}

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { url, title, source, readTime, tag, imageUrl, notes, savedAt } = req.body;
  if (!url || !title) { res.status(400).json({ error: 'url and title required' }); return; }
  if (typeof url !== 'string' || url.length > 2048) { res.status(400).json({ error: 'url must be ≤2048 characters' }); return; }
  if (typeof title !== 'string' || title.length > 500) { res.status(400).json({ error: 'title must be ≤500 characters' }); return; }
  if (source !== undefined && typeof source === 'string' && source.length > 200) { res.status(400).json({ error: 'source must be ≤200 characters' }); return; }
  const image = validImageUrl(imageUrl);
  if (image === null) { res.status(400).json({ error: 'imageUrl must be an http(s) URL ≤2048 characters' }); return; }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 50000)) {
    res.status(400).json({ error: 'notes must be a string ≤50,000 characters' }); return;
  }

  // Only allow http/https — blocks javascript:, data:, vbscript:, etc.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'URL must use http or https' }); return;
    }
  } catch {
    res.status(400).json({ error: 'Invalid URL' }); return;
  }

  // Where it lands. Absent is the reading list, which is what saving from
  // anywhere but the Save button's shelf menu means. Filing straight onto a
  // shelf used to be a create followed by a move, which is two round trips and,
  // now that a destination can already hold this article, a create that the
  // move might then refuse — leaving the article somewhere nobody asked for.
  let folderId: string | null = null;
  let inLibrary = false;
  if (req.body.folderId !== undefined && req.body.folderId !== null) {
    if (typeof req.body.folderId !== 'string') {
      res.status(400).json({ error: 'folderId must be a string or null' }); return;
    }
    // Scoped to the caller, like the PATCH: without this you could file an
    // article onto somebody else's shelf by guessing an id.
    const target = await prisma.readingFolder.findFirst({
      where: { id: req.body.folderId, userId: req.userId! },
      select: { id: true },
    });
    if (!target) { res.status(404).json({ error: 'Folder not found' }); return; }
    folderId = target.id;
    inLibrary = true;   // filing something implies it belongs in the Library
  } else if (req.body.inLibrary === true) {
    inLibrary = true;
  }

  // Already there: hand back the copy that exists rather than making a second
  // one. 200 rather than 201, and flagged, so a caller that wants to say so can
  // — the article really is saved either way, so this is not an error.
  const existing = await findCopyIn(req.userId!, folderId, url);
  if (existing) {
    // With one exception. Saving to the Library is a filing decision, and the
    // copy it found may still be sitting in the reading list — so the decision
    // is applied to the row that exists rather than dropped on the floor,
    // which would have left the feed reporting a filing that never happened.
    const row = inLibrary && !existing.inLibrary
      ? await prisma.readingListItem.update({
          where: { id: existing.id }, data: { inLibrary: true, folderId },
        })
      : existing;
    res.status(200).json({ ...row, duplicate: true });
    return;
  }

  const owned = await prisma.readingListItem.count({ where: { userId: req.userId! } });
  if (owned >= MAX_READING_LIST_ITEMS) {
    res.status(409).json({ error: `You've reached the limit of ${MAX_READING_LIST_ITEMS} saved articles.` });
    return;
  }

  // Deleting is immediate — the greyed-out card the list leaves behind is only a
  // local placeholder — so Undo has to re-create the row. Carrying the original
  // savedAt over is what puts it back where it was instead of at the top of the
  // list; there is no other way to set it, and backdating your own list is
  // harmless. Anything else is a plain create and leaves it unset.
  let saved: Date | undefined;
  if (savedAt !== undefined) {
    if (typeof savedAt !== 'string') { res.status(400).json({ error: 'savedAt must be an ISO date string' }); return; }
    const parsed = new Date(savedAt);
    if (isNaN(parsed.getTime())) { res.status(400).json({ error: 'savedAt must be an ISO date string' }); return; }
    saved = parsed;
  }

  const item = await prisma.readingListItem.create({
    data: {
      userId: req.userId!,
      url,
      title,
      source: source || '',
      readTime: readTime || '',
      tag: tag || '',
      imageUrl: image,
      folderId,
      inLibrary,
      ...(notes !== undefined ? { notes } : {}),
      ...(saved ? { savedAt: saved } : {}),
    },
  });
  res.status(201).json(item);
});

router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { inLibrary, title, tag, notes } = req.body;
  const data: Record<string, unknown> = {};
  if (typeof inLibrary === 'boolean') {
    data.inLibrary = inLibrary;
    // Pulling an article back to the reading list takes it off its shelf too.
    // "On a shelf but not in the Library" is a state nothing can render, so it
    // is better not to be able to reach it. An explicit folderId in the same
    // request still wins — see below.
    if (!inLibrary) data.folderId = null;
  }
  if (typeof title === 'string') {
    if (title.length > 500) { res.status(400).json({ error: 'title must be ≤500 characters' }); return; }
    data.title = title;
  }
  if (typeof tag === 'string') data.tag = tag;
  if (typeof notes === 'string') {
    if (notes.length > 50000) { res.status(400).json({ error: 'notes must be ≤50,000 characters' }); return; }
    data.notes = notes;
  }
  // null is a meaningful value here (move to Unsorted), so this tests for the
  // key's presence rather than truthiness.
  if ('folderId' in req.body) {
    const { folderId } = req.body;
    if (folderId === null) {
      data.folderId = null;
    } else if (typeof folderId === 'string') {
      // Scoped to the caller: without this you could file an article onto
      // somebody else's shelf by guessing an id.
      const target = await prisma.readingFolder.findFirst({
        where: { id: folderId, userId: req.userId! },
        select: { id: true },
      });
      if (!target) { res.status(404).json({ error: 'Folder not found' }); return; }
      data.folderId = target.id;
      // Filing something implies it belongs in the Library.
      data.inLibrary = true;
    } else {
      res.status(400).json({ error: 'folderId must be a string or null' }); return;
    }
  }

  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  const existing = await prisma.readingListItem.findFirst({
    where: { id: req.params.id, userId: req.userId! },
  });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  // The same one-copy-per-destination rule the POST enforces, for the other way
  // an article reaches a shelf. Nothing created since that rule landed can
  // collide here — a move takes the article out of wherever it was — so this is
  // for the pairs that were already saved twice before it existed.
  if ('folderId' in data && data.folderId !== existing.folderId) {
    const clash = await findCopyIn(req.userId!, data.folderId as string | null, existing.url);
    if (clash && clash.id !== existing.id) {
      res.status(409).json({ error: 'That article is already there.' });
      return;
    }
  }

  const item = await prisma.readingListItem.update({
    where: { id: req.params.id },
    data,
  });
  res.json(item);
});

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await prisma.readingListItem.deleteMany({
    where: { id: req.params.id, userId: req.userId! },
  });
  if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});

export default router;
