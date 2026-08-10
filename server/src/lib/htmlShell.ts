import nodeFetch from 'node-fetch';
import logger from './logger';

// The built index.html, with room made in it for a page's own <head> and a
// crawlable copy of its content.
//
// The awkward part of this is that the server does not have the client bundle:
// nginx does (see client/Dockerfile). Three ways to fix that were available —
// copy client/dist into the server image, share a volume, or ask nginx for the
// file over the network. This is the third, and it is the only one that adds no
// coupling between the two builds: the asset filenames are content-hashed and
// change every deploy, and neither of the other options survives that without
// the two images being rebuilt and redeployed in lockstep.
//
// It is also safe in the way it first looks like it is not. A request only
// reaches this code by being proxied here *by nginx*, so nginx answering the
// subrequest is not an extra assumption — it is a thing that was already true a
// millisecond ago.

/** Where the built index.html is served from. The nginx container, in the compose stack. */
const SHELL_ORIGIN = process.env.SHELL_ORIGIN || 'http://client';

// Short, because the shell changes on every deploy and a stale one names asset
// files that no longer exist — a blank page for whoever loads it. A minute of
// that on the deploy itself is acceptable; ten would not be.
const CACHE_TTL_MS = 60_000;

// Both markers are optional in the template: an older client build simply has no
// injection point, and the fallbacks below put the content somewhere valid
// rather than dropping it. A deploy that updates the server before the client
// should degrade, not break.
const HEAD_MARKER = '<!--SSR-HEAD-->';
const BODY_MARKER = '<!--SSR-BODY-->';

// The template ships with a static <title> so the dev server and any
// un-injected route still have one. Two <title> elements in a document is not
// an error — the browser takes the first — which is precisely the bug it would
// cause, so the static one is removed whenever a real one is injected.
const STATIC_TITLE = /<title>[\s\S]*?<\/title>\s*/i;

let cached: { html: string; at: number } | null = null;

/** Drops the cached template. Exported for tests; nothing in the app calls it. */
export function clearShellCache(): void {
  cached = null;
}

async function fetchShell(): Promise<string | null> {
  try {
    const res = await nodeFetch(`${SHELL_ORIGIN}/index.html`, { timeout: 3000 } as never);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Shell fetch returned non-OK');
      return null;
    }
    return await res.text();
  } catch (err) {
    logger.warn(err, 'Shell fetch failed');
    return null;
  }
}

/**
 * The last-resort document, served when the template cannot be fetched.
 *
 * Deliberately not a 502. The request that got here is usually a crawler or an
 * unfurler, and for them this page is complete: the whole point of the response
 * is the <head>, and that part does not come from the template. A human gets a
 * page with no application on it, which is bad — but a human only ends up here
 * if nginx cannot serve its own index.html, in which case every other page of
 * the app is broken too and this one is not the problem.
 */
function fallbackDocument(head: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${head}
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

/**
 * The full HTML document for one server-rendered page.
 *
 * `head` is a fragment of tags (see seoMeta.renderHead) and `body` is crawlable
 * content (see seoMeta.renderNoscript). Both are already escaped by the time
 * they arrive; this function does no escaping of its own and must not start,
 * or the two layers would double-encode each other.
 */
export async function renderShell(head: string, body = ''): Promise<string> {
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    const html = await fetchShell();
    // A failed refetch keeps serving the stale template rather than falling all
    // the way back: a minute-old shell is far better than no application, and
    // the asset names in it are almost certainly still valid.
    if (html) cached = { html, at: Date.now() };
    else if (!cached) return fallbackDocument(head, body);
  }

  // Only when a real one is going in. Stripping unconditionally would leave a
  // response that injects no head — an error page, or a future route that wants
  // the plain shell — with no title whatsoever, which is worse than the generic
  // one it was carrying.
  let out = /<title[\s>]/i.test(head) ? cached!.html.replace(STATIC_TITLE, '') : cached!.html;

  out = out.includes(HEAD_MARKER)
    ? out.replace(HEAD_MARKER, head)
    : out.replace(/<\/head>/i, `${head}\n</head>`);

  if (body) {
    out = out.includes(BODY_MARKER)
      ? out.replace(BODY_MARKER, body)
      : out.replace(/<\/body>/i, `${body}\n</body>`);
  }

  return out;
}
