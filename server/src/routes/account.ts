import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { normalizeImagePath } from '../lib/images';
import {
  normalizeProfileLinks, readProfileLinks, MAX_PROFILE_LINKS, type ProfileLink,
} from '../lib/profileLinks';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// What the owner sees of their own account. Wider than PUBLIC_USER_SELECT — it
// carries the email — so it is spelled out once here rather than at each use.
const ACCOUNT_SELECT = {
  username: true, email: true, firstName: true, lastName: true, avatar: true,
  coverImage: true, coverTheme: true, profileLinks: true, totpEnabled: true,
} as const;

type AccountRow = {
  profileLinks: unknown;
  [k: string]: unknown;
};

// The Json column comes back as Prisma.JsonValue; the client wants the parsed
// list. Anything unrecognisable reads as no links (see readProfileLinks).
function toAccountJson(user: AccountRow) {
  return { ...user, profileLinks: readProfileLinks(user.profileLinks) };
}

// A gradient preset is named by the client's own table (utils/coverGradient.ts),
// which the server deliberately does not duplicate — see profileLinks.ts for the
// same reasoning. All the server enforces is that the id is a short slug, so an
// unknown one falls back to the username-derived gradient rather than breaking.
const COVER_THEME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

// Avatars are stored as small base64 data URLs (client downscales to 128px
// before upload) — no image processing dependencies needed server-side.
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_MAX_CHARS = 150_000; // ~110 KB decoded

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: ACCOUNT_SELECT,
  });
  if (!user) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(toAccountJson(user));
});

router.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { firstName, lastName, avatar, email, coverImage, coverTheme, profileLinks } =
    req.body as Record<string, unknown>;
  const data: Record<string, string | null | ProfileLink[]> = {};

  if ('email' in req.body) {
    if (email !== null && email !== '') {
      if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'Enter a valid email address' }); return;
      }
      data.email = email.toLowerCase();
    } else {
      data.email = null;
    }
  }

  if ('firstName' in req.body) {
    if (firstName !== null && (typeof firstName !== 'string' || firstName.length > 100)) {
      res.status(400).json({ error: 'firstName must be a string of ≤100 characters' }); return;
    }
    data.firstName = (firstName as string | null) || null;
  }
  if ('lastName' in req.body) {
    if (lastName !== null && (typeof lastName !== 'string' || lastName.length > 100)) {
      res.status(400).json({ error: 'lastName must be a string of ≤100 characters' }); return;
    }
    data.lastName = (lastName as string | null) || null;
  }
  if ('avatar' in req.body) {
    if (avatar !== null && avatar !== '') {
      if (typeof avatar !== 'string' || avatar.length > AVATAR_MAX_CHARS || !AVATAR_RE.test(avatar)) {
        res.status(400).json({ error: 'avatar must be a PNG/JPEG/WebP data URL under 110 KB' }); return;
      }
      data.avatar = avatar;
    } else {
      data.avatar = null;
    }
  }

  // ── Profile cover ──
  // The image is one of our own uploads named by its path (never a data URL, and
  // never a third-party host), so a cover is stored as a reference and costs the
  // profile payload a few dozen bytes rather than a few hundred kilobytes.
  if ('coverImage' in req.body) {
    if (coverImage === null || coverImage === '') {
      data.coverImage = null;
    } else {
      const path = normalizeImagePath(coverImage);
      if (!path) {
        res.status(400).json({ error: 'coverImage must be an uploaded image path, or empty' }); return;
      }
      data.coverImage = path;
    }
  }

  if ('coverTheme' in req.body) {
    if (coverTheme === null || coverTheme === '') {
      data.coverTheme = null;                      // back to the derived gradient
    } else if (typeof coverTheme !== 'string' || !COVER_THEME_RE.test(coverTheme)) {
      res.status(400).json({ error: 'coverTheme must be a gradient name, or empty' }); return;
    } else {
      data.coverTheme = coverTheme;
    }
  }

  if ('profileLinks' in req.body) {
    const links = normalizeProfileLinks(profileLinks);
    if (!links) {
      res.status(400).json({
        error: `Links must be up to ${MAX_PROFILE_LINKS} ordinary http(s) addresses`,
      });
      return;
    }
    data.profileLinks = links;
  }

  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

  try {
    const user = await prisma.user.update({
      where: { id: req.userId! },
      data,
      select: ACCOUNT_SELECT,
    });
    res.json(toAccountJson(user));
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'That email is already in use' });
      return;
    }
    logger.error(err, 'Account update error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── First-admin bootstrap via setup token ─────────────────────────────────────
// Claimable only while the instance has zero admins; afterwards the token is
// inert and admins are managed from the admin panel.

router.get('/admin-claim', async (_req: AuthRequest, res: Response): Promise<void> => {
  if (!process.env.ADMIN_SETUP_TOKEN) { res.json({ claimable: false }); return; }
  const admins = await prisma.user.count({ where: { isAdmin: true } });
  res.json({ claimable: admins === 0 });
});

const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});

router.post('/admin-claim', claimLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const expected = process.env.ADMIN_SETUP_TOKEN;
  const { token } = req.body as { token?: unknown };
  if (!expected || typeof token !== 'string') {
    res.status(400).json({ error: 'Admin setup is not enabled' }); return;
  }
  const admins = await prisma.user.count({ where: { isAdmin: true } });
  if (admins > 0) { res.status(403).json({ error: 'An admin already exists' }); return; }

  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: 'Invalid setup token' }); return;
  }
  await prisma.user.update({ where: { id: req.userId! }, data: { isAdmin: true } });
  logger.info({ userId: req.userId }, 'First admin claimed via setup token');
  res.json({ ok: true });
});

// Stricter limit — each attempt verifies the current password, so this is
// a brute-force surface just like login.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});

router.post('/password', passwordLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const { currentPassword, newPassword } = req.body as Record<string, unknown>;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'currentPassword and newPassword required' }); return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' }); return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      // 403, not 401 — a 401 would make the client think its access token
      // expired and silently refresh + retry the request.
      res.status(403).json({ error: 'Current password is incorrect' }); return;
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.userId! }, data: { passwordHash } });
    // Invalidate every session — anyone holding a stolen refresh token is out.
    // The current session survives until its access token expires (≤15 min).
    await prisma.refreshToken.deleteMany({ where: { userId: req.userId! } });
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, 'Password change error');
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
