import { Router, Response } from 'express';
import QRCode from 'qrcode';
import speakeasy from 'speakeasy';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { clearTrustCache } from '../lib/trust';
import logger from '../lib/logger';

const router = Router();
router.use(requireAuth);

// GET /api/totp/status
router.get('/status', async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { totpEnabled: true } });
  res.json({ enabled: user?.totpEnabled ?? false });
});

// POST /api/totp/enroll — generate a fresh secret, persist it as pending, return QR + secret for display
router.post('/enroll', async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { username: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const secret = speakeasy.generateSecret({ length: 20 });

  // Store pending secret in DB — confirm will read from here, not from the client
  await prisma.user.update({
    where: { id: req.userId! },
    data: { totpPendingSecret: secret.base32 },
  });

  const otpauthUrl =
    `otpauth://totp/${encodeURIComponent(`Newt:${user.username}`)}` +
    `?secret=${secret.base32}&issuer=Newt&algorithm=SHA1&digits=6&period=30`;

  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 256, errorCorrectionLevel: 'M' });
  // Return secret so the user can type it in manually if QR scan fails
  res.json({ secret: secret.base32, qrDataUrl });
});

// POST /api/totp/confirm — verify code against the server-stored pending secret, then enable TOTP
router.post('/confirm', async (req: AuthRequest, res: Response): Promise<void> => {
  const { code } = req.body;
  if (!code) { res.status(400).json({ error: 'code required' }); return; }

  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { totpPendingSecret: true },
  });
  if (!user?.totpPendingSecret) {
    res.status(400).json({ error: 'No pending TOTP enrollment — call /enroll first' }); return;
  }

  const valid = speakeasy.totp.verify({
    secret: user.totpPendingSecret,
    encoding: 'base32',
    token: String(code),
    window: 2,
  });
  if (!valid) {
    const expected = speakeasy.totp({ secret: user.totpPendingSecret, encoding: 'base32' });
    logger.warn({ received: code, expected, serverTime: new Date().toISOString() }, 'TOTP confirm: invalid code');
    res.status(422).json({ error: 'Invalid code — try again' }); return;
  }

  await prisma.user.update({
    where: { id: req.userId! },
    data: { totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabled: true },
  });
  // 2FA promotes the account's trust level (lib/trust.ts), and the cached value
  // says otherwise for up to five more minutes. Drop it so the wider limits apply
  // from the moment enrolment finishes rather than whenever the TTL happens to
  // lapse — this is the one transition a user is waiting on.
  clearTrustCache(req.userId!);
  res.json({ ok: true });
});

// POST /api/totp/disable — verify current code then remove TOTP
router.post('/disable', async (req: AuthRequest, res: Response): Promise<void> => {
  const { code } = req.body;
  if (!code) { res.status(400).json({ error: 'code required' }); return; }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user?.totpEnabled || !user.totpSecret) {
    res.status(400).json({ error: 'TOTP not enabled' }); return;
  }

  const valid = speakeasy.totp.verify({ secret: user.totpSecret, encoding: 'base32', token: String(code), window: 2 });
  if (!valid) { res.status(401).json({ error: 'Invalid code' }); return; }

  await prisma.user.update({
    where: { id: req.userId! },
    data: { totpSecret: null, totpPendingSecret: null, totpEnabled: false },
  });
  // Symmetrically: dropping 2FA drops the trust level it earned, and a stale
  // cache entry would keep the wider limits alive past the change.
  clearTrustCache(req.userId!);
  res.json({ ok: true });
});

export default router;
