import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';
import { recordError, errorMessage } from '../lib/errorLog';
import { AuthRequest } from './auth';

// The last middleware in the stack. There wasn't one: an error thrown outside a
// route's own try/catch reached Express's default handler, which in production
// answers with a bare 500 and an empty body and keeps nothing. Routes that do
// catch their own errors are unaffected — they answer and never reach here.
//
// Express 4 identifies an error handler by its arity, so all four parameters
// must stay in the signature even though `next` is only used for the
// headers-already-sent case. Don't "clean up" the unused one.

// Some throws are how a piece of middleware says 400. They aren't incidents, and
// recording them would bury the real errors under a stream of malformed JSON
// from the internet.
function statusOf(err: unknown): number {
  const s = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  return typeof s === 'number' && s >= 400 && s <= 599 ? s : 500;
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const status = statusOf(err);

  // Something already started writing the response, so the only honest thing
  // left is to break the connection — Express's default handler does this too.
  if (res.headersSent) {
    next(err);
    return;
  }

  const auth = req as AuthRequest;
  logger.error({ err, method: req.method, path: req.path, status }, 'Unhandled request error');

  if (status >= 500) {
    void recordError({
      source: 'server',
      message: errorMessage(err),
      detail: err instanceof Error ? err.stack : undefined,
      method: req.method,
      // req.originalUrl carries the query string, which can hold anything a
      // caller typed. req.path is the route, which is what a diagnosis needs.
      path: req.path,
      status,
      userId: auth.userId ?? null,
      username: auth.username ?? null,
    });
  }

  // The message is never echoed back on a 500. It is a stack-trace-adjacent
  // string from an unknown source, and the client has nothing to do with it —
  // it's in the error log, which is where an admin reads it.
  res.status(status).json({
    error: status >= 500 ? 'Server error' : errorMessage(err) || 'Request error',
  });
}
