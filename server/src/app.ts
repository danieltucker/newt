import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth';
import folderRoutes from './routes/folders';
import feedRoutes from './routes/feeds';
import bookmarkRoutes from './routes/bookmarks';
import readingListRoutes from './routes/readingList';
import readingFolderRoutes from './routes/readingFolders';
import utilRoutes from './routes/util';
import settingsRoutes from './routes/settings';
import totpRoutes from './routes/totp';
import adminRoutes from './routes/admin';
import adminPersonaRoutes from './routes/adminPersonas';
import adminSiteModelRoutes from './routes/adminSiteModels';
import accountRoutes from './routes/account';
import commentRoutes from './routes/comments';
import articleRoutes from './routes/articles';
import blogRoutes from './routes/blogs';
import imageRoutes from './routes/images';
import friendRoutes from './routes/friends';
import profileRoutes from './routes/profiles';
import notificationRoutes from './routes/notifications';
import blockRoutes from './routes/blocks';
import reportRoutes from './routes/reports';
import siteRoutes from './routes/sites';
import htmlRoutes from './routes/html';
import seoRoutes from './routes/seo';
import llmRoutes from './routes/llm';
import researchRoutes from './routes/research';
import exploreRoutes from './routes/explores';
import { errorHandler } from './middleware/errorHandler';

// The wired-up Express app, with no side effects: no port bound, no background
// scheduler, no signal handlers. Those live in index.ts.
//
// The split exists so tests can mount the real app — same middleware order, same
// limiters, same route stack — with supertest. Previously app.listen() ran at
// module scope, so importing anything from index.ts started a server, and the
// route layer could only be checked by reading it.
const app = express();

// Behind reverse proxies, trust the configured number of hops so req.ip resolves
// to the real client (used for per-IP rate limiting) instead of the nearest proxy.
// Leave unset for local dev (direct connection); set to the proxy count otherwise:
// 1 = client nginx only (local docker-compose), 2 = reverse proxy + nginx (prod).
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
}

// ── Who sets a document's headers ──
//
// One `helmet()` over everything was right while everything Express served was
// JSON. The public document routes below (/u/, /a/, /t/, /recent, robots.txt,
// sitemap*.xml) changed that: nginx sends *those* their own headers from
// client/security-headers.conf, because they are documents and the SPA they sit
// beside is served straight off disk with the same set.
//
// A browser handed two Content-Security-Policy headers enforces both, and the
// effective policy is their intersection - not the last one written. So the two
// did not merge, they fought, and the stricter accident won:
//
//   script-src  nginx names the sha256 of the inline theme script in
//               index.html; helmet's default `'self'` does not. Intersection:
//               the script is blocked, and every SSR page loads in the wrong
//               theme until React mounts.
//   img-src     nginx allows https:; helmet's default is `'self' data:`.
//               Intersection: every avatar, favicon and article image on a
//               profile page is blocked.
//   frame-src   nginx allows https:; helmet has no frame-src, so its
//               `default-src 'self'` covers it. Intersection: the reader iframe
//               is blocked.
//
// X-Frame-Options and Referrer-Policy were being sent twice with *different*
// values too (DENY vs helmet's SAMEORIGIN, strict-origin-when-cross-origin vs
// helmet's no-referrer), which is why this skips helmet on those routes rather
// than only turning its CSP off: one owner per response, and for documents that
// owner is nginx.
//
// Consistency, not a downgrade - the SPA's own index.html has always been
// served by nginx with exactly these headers and no helmet. What was odd was
// that six URLs got a second set because Express happened to render them.
//
// The trade this makes: these six routes are only hardened when something is
// in front of them supplying client/security-headers.conf. That is true of
// every deployment the compose files describe, and it was already true of the
// SPA - but exposing this server directly to the internet would leave them
// bare, so don't.
//
// Kept in step with the `location ~` regex in client/nginx.conf by hand: it is
// two lines in two languages and a mismatch shows up as a missing header, so
// server/src/app.test.ts asserts the two agree.
const DOCUMENT_ROUTE = /^\/(u|a|t)\/|^\/(recent|robots\.txt|sitemap[a-z0-9-]*\.xml)$/;

const apiHelmet = helmet();

app.use((req, res, next) => {
  if (DOCUMENT_ROUTE.test(req.path)) return next();
  return apiHelmet(req, res, next);
});

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
// ── Body limits ───────────────────────────────────────────────────────────
// Settings gets its own, and gets it first.
//
// The notes tree lives in the settings blob and is written *whole* on every
// save (see routes/settings and the versioning note in NotesConsole), so the
// request grows with everything the user has ever written. Against the 256kb
// below that is a cliff: past it every save 413s, forever, and since the
// console keeps retrying what it could not send, the notes silently stop being
// saved at the moment there are enough of them to be worth saving. Nothing
// warned, because nothing was checking.
//
// 2MB is roughly a third of a million words of note text. Images are not in
// here - they upload separately to /api/v1/images and appear in the HTML as
// URLs - so this only has to hold prose and markup.
//
// Mounted before the general parser rather than after: express.json marks a
// request as parsed, and the first parser to run is the one whose limit
// applies. Reversed, the 256kb one would reject the body before this was ever
// consulted.
app.use('/api/v1/settings', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Strict limit on auth endpoints — prevents brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// General API limit — generous for normal use, blocks bulk abuse
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/folders', apiLimiter, folderRoutes);
app.use('/api/v1/feeds', apiLimiter, feedRoutes);
app.use('/api/v1/bookmarks', apiLimiter, bookmarkRoutes);
app.use('/api/v1/reading-list', apiLimiter, readingListRoutes);
app.use('/api/v1/reading-folders', apiLimiter, readingFolderRoutes);
app.use('/api/v1/util', apiLimiter, utilRoutes);
app.use('/api/v1/settings', apiLimiter, settingsRoutes);
app.use('/api/v1/totp', apiLimiter, totpRoutes);
// Before the general admin router, not after. Express falls through a `use`
// whose router matches no route, so mounting this second would still work — but
// every persona request would first run adminRoutes' requireAuth + requireAdmin
// pair for nothing, and the fall-through would be load-bearing behaviour nobody
// reading either file could see. Longest prefix first is the intent.
//
// Personas are the one feature that spends the *operator's* model rather than a
// caller's own key; see lib/llm/operator.ts.
app.use('/api/v1/admin/personas', apiLimiter, adminPersonaRoutes);
app.use('/api/v1/admin/site-models', apiLimiter, adminSiteModelRoutes);
app.use('/api/v1/admin', apiLimiter, adminRoutes);
app.use('/api/v1/account', apiLimiter, accountRoutes);
app.use('/api/v1/comments', apiLimiter, commentRoutes);
app.use('/api/v1/articles', apiLimiter, articleRoutes);
app.use('/api/v1/blogs', apiLimiter, blogRoutes);
app.use('/api/v1/images', apiLimiter, imageRoutes);
app.use('/api/v1/friends', apiLimiter, friendRoutes);
app.use('/api/v1/profiles', apiLimiter, profileRoutes);
app.use('/api/v1/notifications', apiLimiter, notificationRoutes);
app.use('/api/v1/blocks', apiLimiter, blockRoutes);
app.use('/api/v1/reports', apiLimiter, reportRoutes);
app.use('/api/v1/sites', apiLimiter, siteRoutes);
// The AI routes carry their own per-user limiters (see lib/rateLimit), sized to
// the fact that every call spends the caller's own money at a third party. The
// shared apiLimiter still applies on top as the per-IP backstop.
app.use('/api/v1/llm', apiLimiter, llmRoutes);
app.use('/api/v1/research', apiLimiter, researchRoutes);
// Reading a shared explore, which unlike everything in researchRoutes is not
// behind auth and never calls a model — a link to a public thread has to open
// for someone with no account.
app.use('/api/v1/explores', apiLimiter, exploreRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Server-rendered documents for the public pages (/u/, /a/, /t/, sitemap,
// robots). Not under /api: these are the addresses a person shares and a crawler
// fetches, and nginx proxies exactly those prefixes here — see client/nginx.conf.
//
// A separate, much larger limiter than the API's. A crawler working through a
// sitemap is the intended traffic for these routes, and 429ing Googlebot does
// not merely fail one request: it teaches it to crawl the site less. The
// responses are public and identical for every caller, so nginx's proxy_cache
// absorbs the repeat volume long before this ceiling matters.
const htmlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests',
});
app.use(htmlLimiter, seoRoutes);
app.use(htmlLimiter, htmlRoutes);

// Last, and after every route — an error handler mounted above them would never
// see anything. Turns an unhandled throw into a logged, recorded 500 instead of
// Express's default empty one. See middleware/errorHandler.ts.
app.use(errorHandler);

export default app;
