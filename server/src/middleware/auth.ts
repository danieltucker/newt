import { Request, Response, NextFunction } from 'express';
import { verifyAccess } from '../lib/jwt';
import prisma from '../lib/prisma';

export interface AuthRequest extends Request {
  userId?: string;
  // Set alongside userId by requireAuth/optionalAuth, which already load the
  // user to check the ban flag — so surfaces that vary by role (the per-comment
  // moderation flag, for one) cost no extra query. Authorisation still goes
  // through requireAdmin; this is only for shaping a response.
  isAdmin?: boolean;
  // Same free ride: the ban check already reads this row, so carrying the name
  // costs one more column rather than another query. Nothing authorises on it —
  // it exists so the error handler can say *who* hit a 500 without having to go
  // back to the database on a path that is already failing.
  username?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  let userId: string;
  try {
    userId = verifyAccess(header.slice(7)).sub;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // Bans take effect immediately, not when the access token expires —
  // one indexed PK lookup per request.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, isAdmin: true, username: true },
  });
  if (!user || user.bannedAt) {
    res.status(401).json({ error: 'Account unavailable' });
    return;
  }
  req.userId = userId;
  req.isAdmin = user.isAdmin;
  req.username = user.username;
  next();
}

// Like requireAuth, but never rejects: a missing, malformed, expired, or invalid
// token simply leaves req.userId undefined and the request continues as anonymous.
// Used by public surfaces (e.g. profiles) that show more when a valid viewer is
// known but must still serve logged-out visitors.
export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { next(); return; }
  try {
    const userId = verifyAccess(header.slice(7)).sub;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { bannedAt: true, isAdmin: true, username: true },
    });
    if (user && !user.bannedAt) {
      req.userId = userId;
      req.isAdmin = user.isAdmin;
      req.username = user.username;
    }
  } catch {
    // Anonymous — fall through with no userId.
  }
  next();
}

// Checks the DB on every request (not a JWT claim) so a revoked admin
// loses access as soon as their flag is cleared, not when their token expires.
export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { isAdmin: true },
  });
  if (!user?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
