import { Router, Request, Response } from 'express';
import nodeFetch from 'node-fetch';
import { requireAuth } from '../middleware/auth';
import { makeSafeAgent } from '../lib/isSafeUrl';
import { decodeXmlEntities, cleanContent, parseFeedTitle } from '../lib/feedUtils';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

const router = Router();
router.use(requireAuth);

function parseRss(xml: string, limit = 8): Array<{ title: string; link: string; date: string | null }> {
  const items: Array<{ title: string; link: string; date: string | null }> = [];
  const isAtom = xml.includes('<feed') && (xml.includes('<entry>') || xml.includes('<entry '));

  const itemRe = isAtom
    ? /<entry[\s>]([\s\S]*?)<\/entry>/gi
    : /<item[\s>]([\s\S]*?)<\/item>/gi;

  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const e = m[1];
    const rawTitle = e.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
    const title = cleanContent(rawTitle);
    const link = isAtom
      ? (e.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? e.match(/<link>([^<]+)<\/link>/i)?.[1] ?? '')
      : (e.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1] ?? e.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '');
    const date = isAtom
      ? (e.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ?? e.match(/<published>([\s\S]*?)<\/published>/i)?.[1] ?? null)
      : (e.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? e.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)?.[1] ?? null);

    if (title && link.trim()) items.push({ title, link: link.trim(), date: date?.trim() ?? null });
  }
  return items;
}

// GET /api/widgets/rss?url=...
router.get('/rss', async (req: Request, res: Response): Promise<void> => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') { res.status(400).json({ error: 'url required' }); return; }

  const safeAgent = await makeSafeAgent(url);
  if (!safeAgent) { res.status(400).json({ error: 'Invalid or private URL' }); return; }

  try {
    const resp = await nodeFetch(url, {
      agent: safeAgent,
      timeout: 8000,
      // Caller-supplied URL: bound the body by bytes, not just by the idle
      // timeout, so an endless feed can't buffer into the heap.
      size: 2_000_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewTab/1.0; +RSS)' },
    } as FetchOptions);
    if (!resp.ok) { res.status(502).json({ error: `Feed returned ${resp.status}` }); return; }

    const xml = await resp.text();
    const items = parseRss(xml);
    const title = parseFeedTitle(xml);

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ title, items });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch feed' });
  }
});

export default router;
