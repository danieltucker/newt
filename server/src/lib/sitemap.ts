import { escapeXml } from './htmlEscape';

// Rendering the sitemap documents. Pure, so the route stays about the queries.
//
// Who is *in* the sitemap is not decided here — that is indexableAuthorWhere in
// lib/trust.ts, which lives next to the trust ladder it mirrors so the two
// cannot drift apart.

/**
 * The protocol's hard ceiling: 50,000 URLs (or 50MB) per file. Sharding is not
 * optional above it — a sitemap with 50,001 entries is rejected whole, not
 * truncated.
 *
 * Deliberately used as the shard size rather than something smaller and tidier.
 * At the scale this app is likely to reach, it means exactly one shard per kind
 * and the index below is a formality; the point of shipping the index anyway is
 * that growing past one shard then costs nothing, where changing /sitemap.xml
 * from a urlset into an index later would mean re-submitting the site.
 */
export const SITEMAP_PAGE_SIZE = 50_000;

export interface SitemapUrl {
  loc: string;
  lastmod?: Date | null;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
}

function urlEntry(url: SitemapUrl): string {
  const parts = [`    <loc>${escapeXml(url.loc)}</loc>`];
  // W3C datetime. A date-only lastmod is legal and is all a crawler acts on, but
  // the full timestamp is what `updatedAt` actually knows, and an honest lastmod
  // is the whole mechanism by which a large site gets re-crawled cheaply: it is
  // what lets a crawler skip the 200,000 pages that have not changed.
  if (url.lastmod) parts.push(`    <lastmod>${url.lastmod.toISOString()}</lastmod>`);
  if (url.changefreq) parts.push(`    <changefreq>${url.changefreq}</changefreq>`);
  return `  <url>\n${parts.join('\n')}\n  </url>`;
}

export function renderUrlset(urls: SitemapUrl[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(urlEntry).join('\n')}
</urlset>`;
}

export function renderSitemapIndex(entries: { loc: string; lastmod?: Date | null }[]): string {
  const body = entries.map(e => {
    const parts = [`    <loc>${escapeXml(e.loc)}</loc>`];
    if (e.lastmod) parts.push(`    <lastmod>${e.lastmod.toISOString()}</lastmod>`);
    return `  <sitemap>\n${parts.join('\n')}\n  </sitemap>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>`;
}
