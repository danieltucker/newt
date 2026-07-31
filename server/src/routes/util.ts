import { Router, Request, Response } from 'express';
import type { Readable } from 'stream';
import nodeFetch from 'node-fetch';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { isSafeUrl, makeSafeAgent } from '../lib/isSafeUrl';

const execFileAsync = promisify(execFile);

function isValidHost(host: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,251}[a-zA-Z0-9]?$/.test(host);
}

function isValidDomain(d: string): boolean {
  return typeof d === 'string' && d.length > 0 && d.length <= 253 && isValidHost(d);
}

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

function deriveColor(domain: string): string {
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const HTML_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", amp: '&', lt: '<', gt: '>',
  nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  trade: '™', copy: '©', reg: '®',
};

function decodeEntities(str: string): string {
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    try {
      if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
      if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    } catch { return match; }
    return HTML_ENTITIES[entity] ?? match;
  });
}


const MAX_HTML_BYTES = 500_000; // 500 KB — enough for any real <title>/<og:title>

// A card shows two lines of description; anything past this is a page dumping
// its whole first paragraph into a meta tag, and it would be stored verbatim in
// whatever note embeds it.
const MAX_DESCRIPTION = 300;

/**
 * The content of a <meta> tag, matched on either `property` (Open Graph) or
 * `name` (the older convention), with the two attribute orders both tags turn
 * up in. Null when absent or empty — the caller falls through to the next
 * candidate, so "" must not count as an answer.
 */
function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attr = `(?:property|name)=["']${k}["']`;
  const match = html.match(new RegExp(`<meta[^>]+${attr}[^>]+content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}`, 'i'));
  if (!match) return null;
  // Collapse the newlines and runs of spaces that survive pretty-printed markup
  const text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : text;
}

const router = Router();

// favicon and color are intentionally public (favicon proxies Google; color is deterministic)
router.get('/favicon', async (req: Request, res: Response): Promise<void> => {
  const { domain } = req.query;
  if (!domain || !isValidDomain(domain as string)) {
    res.status(400).json({ error: 'valid domain required' }); return;
  }
  try {
    const safeDomain = encodeURIComponent(domain as string);
    const url = `https://www.google.com/s2/favicons?domain=${safeDomain}&sz=128`;
    const upstream = await nodeFetch(url, { timeout: 5000 } as FetchOptions);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    upstream.body?.pipe(res);
  } catch {
    res.status(502).json({ error: 'Failed to fetch favicon' });
  }
});

router.get('/color', (req: Request, res: Response): void => {
  const { domain } = req.query;
  if (!domain) { res.status(400).json({ error: 'domain required' }); return; }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ color: deriveColor(domain as string) });
});

// ping/tracert spawn a process and probe from the server's network position, so
// they're admin-only (on top of the CONSOLE_ENABLED kill switch). The `ip`
// command that used to live here now runs in the browser — it needs the
// caller's public IP, not the server's.
router.get('/ping', requireAuth, requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  if (process.env.CONSOLE_ENABLED === 'false') {
    res.status(403).json({ error: 'Console features are disabled on this server' }); return;
  }
  const { host } = req.query;
  if (!host || typeof host !== 'string' || !isValidHost(host)) {
    res.status(400).json({ error: 'Invalid host' }); return;
  }
  const isWin = process.platform === 'win32';
  const args = isWin ? ['-n', '4', host] : ['-c', '4', host];
  try {
    const { stdout } = await execFileAsync('ping', args, { timeout: 15_000 });
    res.json({ output: stdout });
  } catch (err: any) {
    res.json({ output: err.stdout || 'Ping failed.', error: true });
  }
});

router.get('/tracert', requireAuth, requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  if (process.env.CONSOLE_ENABLED === 'false') {
    res.status(403).json({ error: 'Console features are disabled on this server' }); return;
  }
  const { host } = req.query;
  if (!host || typeof host !== 'string' || !isValidHost(host)) {
    res.status(400).json({ error: 'Invalid host' }); return;
  }
  const isWin = process.platform === 'win32';
  const [cmd, args] = isWin
    ? ['tracert', ['-d', '-h', '20', '-w', '500', host]]
    : ['traceroute', ['-n', '-m', '20', host]];
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 35_000 });
    res.json({ output: stdout });
  } catch (err: any) {
    res.json({ output: err.stdout || 'Traceroute failed.', error: true });
  }
});

// page-meta requires auth — it fetches arbitrary URLs server-side (SSRF risk if public)
router.get('/page-meta', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') { res.status(400).json({ error: 'url required' }); return; }

  const fullUrl = url.startsWith('http') ? url : `https://${url}`;

  const safeAgent = await makeSafeAgent(fullUrl);
  if (!safeAgent) {
    res.status(400).json({ error: 'URL not allowed' });
    return;
  }

  try {
    const response = await nodeFetch(fullUrl, {
      agent: safeAgent,
      timeout: 5000,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewTab/1.0)' },
    } as FetchOptions);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      res.json({ title: null });
      return;
    }

    // Read up to MAX_HTML_BYTES — stop collecting once limit is hit, and destroy
    // the stream so the origin stops sending. Resolving alone leaves the socket
    // open: the 5s timeout is an idle timer, so a page that keeps trickling bytes
    // holds a connection indefinitely.
    const html = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      // node-fetch v2 gives a Node Readable at runtime, typed as a web
      // ReadableStream by the ambient DOM lib — hence the cast for destroy().
      const body = response.body as unknown as Readable;
      const finish = (buf: string) => { if (!settled) { settled = true; body.destroy(); resolve(buf); } };
      response.body!.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        chunks.push(chunk);
        if (size >= MAX_HTML_BYTES) finish(Buffer.concat(chunks).toString('utf8'));
      });
      response.body!.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      response.body!.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    });

    const imgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const image = imgMatch && /^https?:\/\//i.test(imgMatch[1]) ? decodeEntities(imgMatch[1].trim()) : null;

    const description = metaContent(html, 'og:description')
      ?? metaContent(html, 'twitter:description')
      ?? metaContent(html, 'description');

    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (ogMatch) { res.json({ title: decodeEntities(ogMatch[1].trim()), image, description }); return; }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    res.json({
      title: titleMatch ? decodeEntities(titleMatch[1].trim()) : null,
      image,
      description,
    });
  } catch {
    res.json({ title: null, image: null, description: null });
  }
});

// check-frame requires auth — fetches arbitrary URL headers server-side (SSRF risk if public)
router.get('/check-frame', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') { res.status(400).json({ error: 'url required' }); return; }

  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  const safeAgent = await makeSafeAgent(fullUrl);
  if (!safeAgent) { res.status(400).json({ error: 'URL not allowed' }); return; }

  try {
    let headers: nodeFetch.Headers | null = null;

    // Try HEAD first (faster), fall back to GET if server returns 405
    const headResp = await nodeFetch(fullUrl, {
      agent: safeAgent,
      method: 'HEAD',
      timeout: 5000,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewTab/1.0)' },
    } as FetchOptions);

    if (headResp.status === 405) {
      const getResp = await nodeFetch(fullUrl, {
        agent: safeAgent,
        method: 'GET',
        timeout: 5000,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewTab/1.0)', Range: 'bytes=0-0' },
      } as FetchOptions);
      headers = getResp.headers;
    } else {
      headers = headResp.headers;
    }

    const embeddable = !isFrameBlocked(headers);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ embeddable });
  } catch {
    // Network error — optimistically allow (the iframe itself will show an error)
    res.json({ embeddable: true });
  }
});

function isFrameBlocked(headers: nodeFetch.Headers): boolean {
  const xfo = headers.get('x-frame-options')?.trim().toUpperCase();
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return true;

  const csp = headers.get('content-security-policy');
  if (csp) {
    const m = csp.match(/frame-ancestors\s+([^;]+)/i);
    if (m) {
      const val = m[1].trim().toLowerCase();
      if (val.includes("'none'")) return true;
      if (!val.includes('*')) return true; // only specific origins allowed, not ours
    }
  }

  return false;
}

export default router;
