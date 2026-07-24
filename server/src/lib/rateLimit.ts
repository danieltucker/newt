import rateLimit from 'express-rate-limit';
import { AuthRequest } from '../middleware/auth';

// A rate limiter keyed on the authenticated user id rather than the client IP.
// Unlike the global per-IP limiter in index.ts, this throttles an individual
// account no matter how many IPs it hops between — the right granularity for
// abuse tied to a signed-in identity (comment spam, friend-request floods).
//
// MUST be mounted after requireAuth so req.userId is populated. If it somehow
// isn't, every such request collapses onto one shared bucket ('anonymous'),
// which fails safe (throttled) rather than open.
export function perUserLimiter(opts: { windowMs: number; max: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req as AuthRequest).userId || 'anonymous',
    message: { error: opts.message },
  });
}
