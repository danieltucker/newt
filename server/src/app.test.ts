import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';

vi.mock('./lib/prisma', async () => {
  const { prismaMock } = await import('./test/prismaMock');
  return { default: prismaMock };
});

import app from './app';
import { resetPrismaMock } from './test/prismaMock';

beforeEach(() => {
  resetPrismaMock();
});

/**
 * These are regression tests for a production outage, and the shape of that
 * outage is the reason they exist rather than a comment.
 *
 * nginx sends the public document routes their own Content-Security-Policy (see
 * client/security-headers.conf), which names the sha256 of the inline theme
 * script in index.html. Express was sending helmet's default policy on the same
 * responses. Two CSP headers are not "last one wins" - a browser enforces every
 * policy it is handed, so the effective policy was the intersection, and the
 * intersection had no hash, no https: images and no frame-src. Profile pages
 * came up with no images and the wrong theme.
 *
 * Nothing about that is visible from either file on its own, and neither the
 * client nor the server build could have caught it: the bug lived in the
 * overlap. So the check is that Express writes no document policy at all, and
 * that the paths it stays quiet on are exactly the ones nginx speaks for.
 */
describe('security headers', () => {
  // Every path in client/nginx.conf's `location ~` regex, one per branch.
  const documentPaths = [
    '/u/someone',
    '/u/someone/a-post',
    '/a/abc123',
    '/t/design',
    '/recent',
    '/robots.txt',
    '/sitemap.xml',
  ];

  for (const path of documentPaths) {
    it(`sets no CSP on ${path} - nginx owns it`, async () => {
      const res = await request(app).get(path);
      // Not 200: most of these need database rows the mock has no reason to
      // hold. The headers are written by middleware that ran long before the
      // handler decided on a status, which is exactly what's under test - a
      // 404 document is as framable as a 200 one.
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it(`sets no conflicting X-Frame-Options on ${path}`, async () => {
      const res = await request(app).get(path);
      // nginx sends DENY here; helmet's default is SAMEORIGIN. Two different
      // values for one header is the same class of bug as two CSPs.
      expect(res.headers['x-frame-options']).toBeUndefined();
    });
  }

  it('still hardens the API, which nginx does not touch', async () => {
    // /api/ is proxied straight through - security-headers.conf is deliberately
    // not included on that location - so helmet is the only thing standing in
    // front of it and must not have been switched off wholesale.
    const res = await request(app).get('/api/v1/util/health');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('leaves the SPA fallback to nginx too', async () => {
    // Anything that is not an API call and not a document route never reaches
    // Express in production - nginx serves index.html off disk. Express still
    // answers here in tests, and what matters is that this path is *not* in the
    // document set, so helmet does cover it.
    const res = await request(app).get('/not-a-real-route');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

/**
 * The regex in app.ts and the `location ~` regex in client/nginx.conf are the
 * same rule written twice in two languages, and they only work if they agree:
 * a path nginx proxies to Express but app.ts doesn't recognise gets two CSPs
 * again, and a path app.ts exempts but nginx doesn't proxy gets none at all.
 *
 * Reading the deployed config is the only way to check that from here. If
 * nginx.conf is restructured and this stops finding the line, the test fails
 * loudly rather than quietly passing on a regex it never found.
 */
describe('nginx and Express agree on which routes are documents', () => {
  it('uses the same pattern in both files', () => {
    const conf = readFileSync(
      join(__dirname, '..', '..', 'client', 'nginx.conf'),
      'utf8',
    );

    const location = conf.match(/location\s+~\s+(\S+)\s*\{/);
    expect(location, 'no `location ~` block found in client/nginx.conf').not.toBeNull();

    const appSource = readFileSync(join(__dirname, 'app.ts'), 'utf8');
    const declared = appSource.match(/const DOCUMENT_ROUTE = \/(.+)\/;/);
    expect(declared, 'no DOCUMENT_ROUTE literal found in app.ts').not.toBeNull();

    // nginx needs no escape on `/`; a JS regex literal does. That is the only
    // difference the two are allowed to have.
    expect(declared![1].replace(/\\\//g, '/')).toBe(location![1]);
  });
});
