import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { signAccess, signRefresh, verifyRefresh, signTotpPending, verifyTotpPending, refreshTokenKey, REFRESH_TTL_MS } from '../lib/jwt';
import speakeasy from 'speakeasy';
import { openTotpSecret, sealTotpSecret, isSealedTotpSecret } from '../lib/totpSecret';
import logger from '../lib/logger';
import { notifyAdminsOfSignup } from '../lib/adminAlerts';

const router = Router();

const cookieSecure = process.env.COOKIE_SECURE !== undefined
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: cookieSecure,
  maxAge: REFRESH_TTL_MS,
  path: '/api/v1/auth',
};

const DEFAULT_FOLDERS = [
  { name: 'Work', color: '#5E6AD2', position: 0 },
  { name: 'Daily', color: '#1DB954', position: 1 },
  { name: 'Reading', color: '#F48024', position: 2 },
];

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  if (process.env.REGISTRATION_ENABLED === 'false') {
    res.status(403).json({ error: 'Registration is currently closed' });
    return;
  }
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  if (username.length < 3) {
    res.status(400).json({ error: 'Username must be at least 3 characters' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        folders: {
          create: DEFAULT_FOLDERS,
        },
      },
    });
    const accessToken = signAccess(user.id);
    const refreshToken = signRefresh(user.id);
    await prisma.refreshToken.create({
      data: {
        // The digest, never the token - see refreshTokenKey. The cookie below
        // still carries the real thing; this row only has to recognise it.
        token: refreshTokenKey(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
    res.status(201).json({ accessToken, username: user.username, isAdmin: user.isAdmin });

    // After the response, not before it: telling the admins is bookkeeping, and
    // nobody signing up should wait on it. notifyAdminsOfSignup swallows its own
    // failures, so there is nothing here that can reject.
    void notifyAdminsOfSignup(user.id, user.username);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }
    logger.error(err, 'Register error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    // Checked after password verification so a wrong guess can't probe ban status
    if (user.bannedAt) {
      res.status(403).json({ error: 'This account has been suspended. Contact an administrator.' });
      return;
    }
    // If TOTP is enabled, issue a short-lived pending token instead of full tokens
    if (user.totpEnabled) {
      res.json({ requiresTotp: true, totpToken: signTotpPending(user.id), username: user.username });
      return;
    }
    const accessToken = signAccess(user.id);
    const refreshToken = signRefresh(user.id);
    await prisma.refreshToken.create({
      data: {
        token: refreshTokenKey(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
    res.json({ accessToken, username: user.username, isAdmin: user.isAdmin });
  } catch (err) {
    logger.error(err, 'Login error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    res.status(401).json({ error: 'No refresh token' });
    return;
  }
  try {
    const payload = verifyRefresh(token);
    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshTokenKey(token) } });
    if (!stored || stored.userId !== payload.sub || stored.expiresAt < new Date()) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { username: true, isAdmin: true, bannedAt: true } });
    if (user?.bannedAt) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    // Only rotate when within 24 h of expiry — avoids a race condition where multiple
    // concurrent requests (e.g. on laptop wake) all try to rotate the same token and
    // the second one arrives after the first has already deleted it, forcing re-login + 2FA.
    const msLeft = stored.expiresAt.getTime() - Date.now();
    if (msLeft < 24 * 60 * 60 * 1000) {
      await prisma.refreshToken.deleteMany({
        where: { OR: [{ token: refreshTokenKey(token) }, { userId: payload.sub, expiresAt: { lt: new Date() } }] },
      });
      const newRefresh = signRefresh(payload.sub);
      await prisma.refreshToken.create({
        data: { token: refreshTokenKey(newRefresh), userId: payload.sub, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
      });
      res.cookie('refreshToken', newRefresh, COOKIE_OPTS);
    } else {
      // Prune other expired tokens without touching this one
      await prisma.refreshToken.deleteMany({
        where: { userId: payload.sub, expiresAt: { lt: new Date() } },
      });
    }

    res.json({ accessToken: signAccess(payload.sub), username: user?.username, isAdmin: user?.isAdmin ?? false });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Second factor: verify TOTP code and exchange pending token for real tokens
router.post('/totp-verify', async (req: Request, res: Response): Promise<void> => {
  const { totpToken, code } = req.body;
  if (!totpToken || !code) { res.status(400).json({ error: 'totpToken and code required' }); return; }
  try {
    const payload = verifyTotpPending(totpToken);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.totpEnabled || !user.totpSecret) {
      res.status(401).json({ error: 'TOTP not configured' }); return;
    }
    if (user.bannedAt) {
      res.status(403).json({ error: 'This account has been suspended. Contact an administrator.' }); return;
    }
    // Stored encrypted (see lib/totpSecret). A secret that cannot be opened
    // fails the check rather than being skipped - "we couldn't read the second
    // factor" must never mean "so let them in".
    const totpSecret = openTotpSecret(user.totpSecret);
    if (!totpSecret
      || !speakeasy.totp.verify({ secret: totpSecret, encoding: 'base32', token: String(code), window: 2 })) {
      res.status(401).json({ error: 'Invalid code' }); return;
    }
    // Enrolled before secrets were encrypted: seal it now that we have opened
    // it and know it is right. Migrates every account that signs in, so no
    // backfill has to run and no plaintext secret outlives its owner's next
    // login. Deliberately not awaited into the response path.
    if (!isSealedTotpSecret(user.totpSecret)) {
      void prisma.user
        .update({ where: { id: user.id }, data: { totpSecret: sealTotpSecret(totpSecret) } })
        .catch(err => logger.error(err, 'TOTP secret re-seal failed'));
    }
    const accessToken = signAccess(user.id);
    const refreshToken = signRefresh(user.id);
    await prisma.refreshToken.create({
      data: { token: refreshTokenKey(refreshToken), userId: user.id, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
    res.json({ accessToken, username: user.username, isAdmin: user.isAdmin });
  } catch {
    res.status(401).json({ error: 'Invalid or expired session — please sign in again' });
  }
});

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies?.refreshToken;
  if (token) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshTokenKey(token) } }).catch(() => {});
  }
  res.clearCookie('refreshToken', { path: '/api/v1/auth' });
  res.json({ ok: true });
});

export default router;
