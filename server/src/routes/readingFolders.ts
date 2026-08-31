import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// Every route here is scoped to req.userId with no lookup-by-id-alone anywhere.
// Library folders are self-only by design, so there is no "view someone else's"
// path to get wrong.

const MAX_FOLDERS = 100;
const MAX_NAME = 100;

// Folder colours are interpolated into inline styles and into a CSS
// color-mix() template literal on the client, so an arbitrary string here is a
// style-injection surface. Six-digit hex is the only thing the picker emits and
// the only thing worth accepting.
const HEX = /^#[0-9a-fA-F]{6}$/;

function validName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  if (!name || name.length > MAX_NAME) return null;
  return name;
}

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const folders = await prisma.readingFolder.findMany({
    where: { userId: req.userId! },
    orderBy: { position: 'asc' },
    include: { _count: { select: { items: { where: { inLibrary: true } } } } },
  });
  res.json(folders.map(f => ({
    id: f.id,
    name: f.name,
    color: f.color,
    position: f.position,
    itemCount: f._count.items,
    // "archived" for the shelf the reading list files into, null for a shelf
    // the user made. The client needs it to hide that shelf's delete control;
    // the server does not trust it to, hence the guard on DELETE below.
    system: f.system,
  })));
});

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const name = validName(req.body?.name);
  const { color } = req.body ?? {};
  if (!name) { res.status(400).json({ error: `name is required and must be ≤${MAX_NAME} characters` }); return; }
  if (typeof color !== 'string' || !HEX.test(color)) {
    res.status(400).json({ error: 'color must be a #rrggbb hex value' }); return;
  }

  const count = await prisma.readingFolder.count({ where: { userId: req.userId! } });
  if (count >= MAX_FOLDERS) {
    res.status(400).json({ error: `Maximum ${MAX_FOLDERS} folders` }); return;
  }

  const folder = await prisma.readingFolder.create({
    data: { userId: req.userId!, name, color, position: count },
  });
  res.status(201).json({ ...folder, itemCount: 0 });
});

// Declared before /:id so "reorder" isn't swallowed as a folder id.
router.put('/reorder', async (req: AuthRequest, res: Response): Promise<void> => {
  const items: unknown = req.body;
  if (!Array.isArray(items)) { res.status(400).json({ error: 'Array expected' }); return; }
  if (items.length > MAX_FOLDERS) { res.status(400).json({ error: 'Too many items' }); return; }
  if (!items.every(i => i && typeof i.id === 'string' && Number.isInteger(i.position))) {
    res.status(400).json({ error: 'Each item needs an id and an integer position' }); return;
  }
  await prisma.$transaction(
    (items as { id: string; position: number }[]).map(({ id, position }) =>
      prisma.readingFolder.updateMany({ where: { id, userId: req.userId! }, data: { position } })
    )
  );
  res.json({ ok: true });
});

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body ?? {};
  const data: Record<string, unknown> = {};

  if ('name' in body) {
    const name = validName(body.name);
    if (!name) { res.status(400).json({ error: `name must be 1–${MAX_NAME} characters` }); return; }
    data.name = name;
  }
  if ('color' in body) {
    if (typeof body.color !== 'string' || !HEX.test(body.color)) {
      res.status(400).json({ error: 'color must be a #rrggbb hex value' }); return;
    }
    data.color = body.color;
  }
  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

  const result = await prisma.readingFolder.updateMany({
    where: { id: req.params.id, userId: req.userId! },
    data,
  });
  if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});

// Deleting a shelf never deletes what was on it — the FK is ON DELETE SET NULL,
// so the articles fall back to Unsorted. Returned so the client can move them
// without a refetch.
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const folder = await prisma.readingFolder.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true, system: true },
    });
    if (!folder) { res.status(404).json({ error: 'Not found' }); return; }

    // A system shelf is not the user's to delete. Archived is where removing an
    // article from the reading list puts it, and deleting a shelf drops its
    // articles into Unsorted — which would put every archived article back in
    // the Library proper, and hand the user a one-click way to undo the whole
    // point of archiving. Rename it, recolour it, empty it by moving things
    // off it; it stays.
    if (folder.system) {
      res.status(400).json({ error: 'The Archived shelf can’t be deleted.' });
      return;
    }

    const orphaned = await prisma.readingListItem.findMany({
      where: { folderId: folder.id },
      select: { id: true },
    });
    await prisma.readingFolder.delete({ where: { id: folder.id } });
    res.json({ ok: true, unsortedIds: orphaned.map(i => i.id) });
  } catch (err) {
    logger.error(err, 'Delete reading folder error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
