import express, { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perUserLimiter } from '../lib/rateLimit';
import logger from '../lib/logger';
import {
  sniffImageMime,
  imageSize,
  imagePathFor,
  MAX_IMAGE_BYTES,
  USER_IMAGE_QUOTA,
} from '../lib/images';

// Images embedded in notes, comments and blog posts.
//
// Uploading requires auth; *serving* deliberately does not. An image can be
// embedded in a public blog post that a logged-out visitor is reading, and the
// bytes carry no record of which post is asking for them, so there is nothing to
// authorize against. The unguessable id is the access control: it is a bearer
// capability, listed to nobody but its owner.
const router = Router();

const uploadLimiter = perUserLimiter({
  windowMs: 60 * 60_000, max: 120,
  message: "You've hit the hourly limit for image uploads — please try again later.",
});

// POST /api/v1/images — raw image bytes as the request body.
//
// Binary rather than a base64 data URL in JSON: base64 inflates by a third, and
// the global express.json limit is 256kb, which a photo would blow past. The raw
// parser is mounted here only, so it cannot affect any other route's body.
router.post(
  '/',
  requireAuth,
  uploadLimiter,
  express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: 'Expected raw image bytes with an image/* content type' });
      return;
    }

    // The declared content type got us into this handler; the bytes decide what
    // is actually stored. A file claiming image/png while containing HTML must
    // not be served back from our origin as a document.
    const mime = sniffImageMime(buf);
    if (!mime) {
      res.status(400).json({ error: 'Not a supported image (PNG, JPEG, GIF or WebP)' });
      return;
    }

    try {
      const used = await prisma.image.aggregate({
        where: { userId: req.userId! },
        _sum: { size: true },
      });
      if ((used._sum.size ?? 0) + buf.length > USER_IMAGE_QUOTA) {
        res.status(413).json({ error: 'Image storage is full — delete some images and try again' });
        return;
      }

      const { width, height } = imageSize(buf, mime);
      const image = await prisma.image.create({
        // Copied into a plain Uint8Array: a Node Buffer may be backed by a
        // SharedArrayBuffer, which Prisma's Bytes type does not accept.
        data: { userId: req.userId!, mime, data: new Uint8Array(buf), size: buf.length, width, height },
        select: { id: true },
      });

      res.status(201).json({
        id: image.id,
        url: imagePathFor(image.id),
        mime,
        width,
        height,
        size: buf.length,
      });
    } catch (err) {
      logger.error(err, 'Image upload error');
      res.status(500).json({ error: 'Server error' });
    }
  },
);

// GET /api/v1/images/:id — the bytes. Unauthenticated by design (see above).
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const image = await prisma.image.findUnique({
      where: { id: req.params.id },
      select: { mime: true, data: true, createdAt: true },
    });
    if (!image) { res.status(404).json({ error: 'Not found' }); return; }

    // Content is immutable — an image row is never rewritten, only deleted — so
    // it can be cached hard. The etag lets a revisit revalidate for free.
    res.setHeader('Content-Type', image.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${req.params.id}"`);
    // Belt and braces around the magic-number check: never let a browser
    // reinterpret these bytes as a document, and never let them run as one.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    // Prisma returns Bytes as a Uint8Array, which is *not* a Buffer. res.send()
    // recognises only Buffers as binary, so passing one straight through sends
    // the array JSON-encoded under a text content type. Wrap it and end the
    // response directly, leaving the Content-Type set above untouched.
    const bytes = Buffer.from(image.data);
    res.setHeader('Content-Length', bytes.length);
    res.end(bytes);
  } catch (err) {
    logger.error(err, 'Image fetch error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/images/mine/list — the caller's own uploads, for a storage view.
// Namespaced under /mine/ so it cannot be shadowed by a cuid in GET /:id.
router.get('/mine/list', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const images = await prisma.image.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, mime: true, size: true, width: true, height: true, createdAt: true },
    });
    const used = await prisma.image.aggregate({
      where: { userId: req.userId! },
      _sum: { size: true },
    });
    res.json({
      images: images.map(i => ({ ...i, url: imagePathFor(i.id) })),
      usedBytes: used._sum.size ?? 0,
      quotaBytes: USER_IMAGE_QUOTA,
    });
  } catch (err) {
    logger.error(err, 'List images error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/images/:id — owner only. Any HTML still referencing it keeps a
// broken <img>; nothing rewrites bodies, because an image may be embedded in any
// number of notes, comments and posts and there is no index of those references.
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { count } = await prisma.image.deleteMany({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (count === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Delete image error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
