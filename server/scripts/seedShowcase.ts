// Seeds the accounts the marketing screenshots are taken from — the seven shots
// specified in client/src/marketing/sections.ts (and mirrored in
// client/public/shots/README.md). Each shot names what must be on screen; this
// script is the other half of that contract, putting the data behind it.
//
//   npm run seed-showcase
//
// Re-runnable: it deletes the showcase cast outright and rebuilds them, so the
// state is the same every time. Nothing outside CAST is touched — the demo_*,
// persona_* and ad-hoc test accounts already in a dev database are left alone.
//
// Two things are deliberately *not* invented here:
//
//  - Feed articles. The shots call for real headlines, and the database already
//    holds genuinely fetched ones. Everything feed-shaped (the RSS folders, the
//    reading list, the artwork on the cards) is selected from FeedItem rather
//    than written, so no fake headline can reach a published screenshot.
//
//  - Anything identifying. The cast is fictional and the only email addresses
//    are @example.com, which is reserved for exactly this.
//
// The generated images are abstract gradients rather than photographs, for the
// same reason: a screenshot going on a public page should not carry a picture
// whose provenance nobody can account for.
import 'dotenv/config';
import zlib from 'zlib';
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma';
import { canonicalArticleKey, sanitizeCommentHtml } from '../src/lib/comments';
import { sanitizeBlogHtml, excerptOf, postUrlFor, slugify } from '../src/lib/blog';
import { imagePathFor } from '../src/lib/images';
import { friendPairKey } from '../src/lib/friends';
import { syncBookmarkBadges } from '../src/lib/unread';

// One password for the whole cast. These accounts exist to be logged into by
// hand while taking shots and by tests afterwards; a different password each
// would be friction with nothing bought for it. It is printed at the end.
const PASSWORD = 'ShowcaseNewt!2026';

type CastKey = 'maren' | 'theo' | 'iris' | 'sana';

const CAST: Record<CastKey, {
  username: string; firstName: string; lastName: string; email: string;
  // Two stops for the generated avatar, and the profile cover gradient preset.
  avatar: [string, string];
}> = {
  // The account every shot but `social` is taken from.
  maren: {
    username: 'maren', firstName: 'Maren', lastName: 'Ashby',
    email: 'maren@example.com', avatar: ['#5E6AD2', '#00A8E8'],
  },
  theo: {
    username: 'theovance', firstName: 'Theo', lastName: 'Vance',
    email: 'theo@example.com', avatar: ['#F48024', '#EA4C89'],
  },
  iris: {
    username: 'irisbello', firstName: 'Iris', lastName: 'Bello',
    email: 'iris@example.com', avatar: ['#0FB57B', '#24A0ED'],
  },
  sana: {
    username: 'sanakaur', firstName: 'Sana', lastName: 'Kaur',
    email: 'sana@example.com', avatar: ['#A259FF', '#E0479E'],
  },
};

const USERNAMES = Object.values(CAST).map(c => c.username);

// ── PNG generation ────────────────────────────────────────────────────
// A minimal encoder, rather than a dependency. The script needs exactly two
// shapes — a square avatar and a wide post cover — both of which are smooth
// gradients, and PNG's stored-deflate path is short enough that pulling in an
// image library to reach it would be the larger cost. zlib is built in.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB8 PNG from a per-pixel colour function. */
function png(width: number, height: number, at: (x: number, y: number) => [number, number, number]): Buffer {
  // One filter byte (0 = None) per scanline, then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));

/** Diagonal two-stop gradient with a soft off-centre highlight. */
function gradient(width: number, height: number, from: string, to: string): Buffer {
  const [r1, g1, b1] = hexRgb(from);
  const [r2, g2, b2] = hexRgb(to);
  const cx = width * 0.32, cy = height * 0.28;
  const reach = Math.hypot(width, height) * 0.55;
  return png(width, height, (x, y) => {
    const t = (x / width + y / height) / 2;
    const glow = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / reach) ** 2 * 0.28;
    return [
      mix(r1, r2, t) + Math.round(255 * glow) * 0.4 | 0,
      mix(g1, g2, t) + Math.round(255 * glow) * 0.4 | 0,
      mix(b1, b2, t) + Math.round(255 * glow) * 0.4 | 0,
    ].map(v => Math.min(255, v)) as [number, number, number];
  });
}

/**
 * A post cover. A flat gradient at this size reads as a missing image rather
 * than a chosen one, so this adds the two things that make an abstract cover
 * look art-directed: soft diagonal banding, and a vignette that keeps the
 * corners from glowing. Still abstract on purpose — a marketing screenshot
 * should not carry a photograph whose provenance nobody can account for.
 */
function cover(width: number, height: number, from: string, to: string): Buffer {
  const [r1, g1, b1] = hexRgb(from);
  const [r2, g2, b2] = hexRgb(to);
  const diag = width + height;
  return png(width, height, (x, y) => {
    const t = (x / width) * 0.65 + (1 - y / height) * 0.35;
    // Four wide bands running across the diagonal, each a few percent apart —
    // enough to catch the light, not enough to read as stripes.
    const band = Math.sin(((x + y) / diag) * Math.PI * 4) * 0.045;
    // Vignette, strongest in the corners.
    const dx = (x / width - 0.5) * 2, dy = (y / height - 0.5) * 2;
    const vig = 1 - Math.min(1, (dx * dx + dy * dy) * 0.28);
    const shade = (1 + band) * vig;
    return [
      Math.max(0, Math.min(255, Math.round(mix(r1, r2, t) * shade))),
      Math.max(0, Math.min(255, Math.round(mix(g1, g2, t) * shade))),
      Math.max(0, Math.min(255, Math.round(mix(b1, b2, t) * shade))),
    ];
  });
}

async function storeImage(userId: string, buf: Buffer, width: number, height: number): Promise<string> {
  const img = await prisma.image.create({
    // Copied into a plain Uint8Array: Prisma's Bytes wants one backed by an
    // ArrayBuffer, and a Node Buffer's may be a SharedArrayBuffer as far as the
    // types are concerned.
    data: { userId, mime: 'image/png', data: new Uint8Array(buf), size: buf.length, width, height },
  });
  return imagePathFor(img.id);
}

// ── Bookmarks ─────────────────────────────────────────────────────────
// Five colour-coded folders, which is what the bookmarks shot asks for. Sites
// are real and well-known: a screenshot full of invented brands is the fastest
// way to make a product page look staged.

interface Site { domain: string; name: string; pinned?: boolean; feed?: string }

const FOLDERS: { name: string; color: string; sites: Site[] }[] = [
  {
    name: 'Daily', color: '#5E6AD2',
    sites: [
      { domain: 'mail.google.com', name: 'Mail', pinned: true },
      { domain: 'calendar.google.com', name: 'Calendar', pinned: true },
      { domain: 'github.com', name: 'GitHub', pinned: true },
      { domain: 'figma.com', name: 'Figma', pinned: true },
      { domain: 'linear.app', name: 'Linear', pinned: true },
      { domain: 'notion.so', name: 'Notion' },
      { domain: 'slack.com', name: 'Slack' },
      { domain: 'todoist.com', name: 'Todoist' },
    ],
  },
  {
    name: 'Reading', color: '#FF4500',
    sites: [
      { domain: 'theverge.com', name: 'The Verge', feed: 'https://theverge.com/rss/index.xml' },
      { domain: 'arstechnica.com', name: 'Ars Technica', feed: 'https://arstechnica.com/feed' },
      { domain: 'macrumors.com', name: 'MacRumors', feed: 'https://feeds.macrumors.com/MacRumors-All' },
      { domain: 'daringfireball.net', name: 'Daring Fireball', feed: 'https://daringfireball.net/feeds/main' },
      { domain: 'techcrunch.com', name: 'TechCrunch', feed: 'https://techcrunch.com/feed/' },
    ],
  },
  {
    name: 'Build', color: '#0FB57B',
    sites: [
      { domain: 'developer.mozilla.org', name: 'MDN' },
      { domain: 'caniuse.com', name: 'Can I Use' },
      { domain: 'npmjs.com', name: 'npm' },
      { domain: 'stackoverflow.com', name: 'Stack Overflow' },
      { domain: 'news.ycombinator.com', name: 'Hacker News' },
      { domain: 'typescriptlang.org', name: 'TypeScript' },
    ],
  },
  {
    name: 'Garage', color: '#00A8E8',
    sites: [
      { domain: 'autoblog.com', name: 'Autoblog', feed: 'https://www.autoblog.com/.rss/feed/7a401613-317c-4892-acfb-6f19ee932643.xml' },
      { domain: 'autotrader.com', name: 'Autotrader', feed: 'https://autotrader.com/feed' },
      { domain: 'rockauto.com', name: 'RockAuto' },
      { domain: 'tirerack.com', name: 'Tire Rack' },
    ],
  },
  {
    name: 'Local', color: '#A259FF',
    sites: [
      { domain: 'cascadiadaily.com', name: 'Cascadia Daily', feed: 'https://www.cascadiadaily.com/feed/' },
      { domain: 'wsdot.wa.gov', name: 'WSDOT' },
      { domain: 'wta.org', name: 'WTA Hikes' },
      { domain: 'openstreetmap.org', name: 'OpenStreetMap' },
    ],
  },
];

// ── Library shelves ───────────────────────────────────────────────────

const SHELVES: { name: string; color: string }[] = [
  { name: 'To read', color: '#5E6AD2' },
  { name: 'Reference', color: '#0FB57B' },
  { name: 'Long reads', color: '#F48024' },
];

// ── Tagging saved articles ────────────────────────────────────────────
// A tag has to actually describe its headline. These shots go on a public page,
// and a "Security" chip on a story about a pickup truck is the exact tell that
// makes a screenshot read as staged — so nothing here is assigned positionally.
// Three sources, in descending order of confidence:
//
//   1. the feed's own category, when it is one we recognise;
//   2. the section in the article's URL, which is how Ars and Autoblog file
//      things (they publish no categories at all);
//   3. the publication, which is always true if not always specific.
//
// An article that satisfies none of them keeps no tag rather than a wrong one.
const KNOWN_TAGS = [
  'AI', 'Apple', 'Security', 'Space', 'Gaming', 'Policy', 'Design',
  'Science', 'Cars', 'Hardware', 'Privacy', 'Business',
];

const TAG_BY_URL_SECTION: Record<string, string> = {
  security: 'Security', space: 'Space', gaming: 'Gaming', games: 'Gaming',
  'tech-policy': 'Policy', policy: 'Policy', ai: 'AI', science: 'Science',
  cars: 'Cars', health: 'Science', 'information-technology': 'Hardware',
};

const TAG_BY_SOURCE: Record<string, string> = {
  'The Verge': 'Tech',
  'Ars Technica': 'Science',
  'MacRumors': 'Apple',
  'Autoblog': 'Cars',
  'Cascadia Daily': 'Local',
};

function tagFor(categories: string[], link: string, source: string): string {
  const known = categories.find(c => KNOWN_TAGS.includes(c));
  if (known) return known;
  try {
    for (const seg of new URL(link).pathname.split('/')) {
      if (TAG_BY_URL_SECTION[seg]) return TAG_BY_URL_SECTION[seg];
    }
  } catch { /* a malformed link just falls through */ }
  return TAG_BY_SOURCE[source] ?? '';
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The stored markup for a reference card, mirroring buildEmbedHtml in
 * client/src/utils/noteEmbed.ts. Duplicated across the boundary the same way
 * the sanitizer's allowlist in lib/comments.ts already duplicates the class and
 * data-attribute names — the markup is deliberately inert and self-describing,
 * which is what makes copying it safe.
 */
function embedHtml(data: {
  kind: 'article' | 'post' | 'page';
  href: string; url: string; title: string; source: string;
  image?: string; meta?: string; description?: string;
}, variant: 'link' | 'small' | 'large' = 'small'): string {
  const attr = (n: string, v?: string) => (v ? ` ${n}="${escapeHtml(v)}"` : '');
  const title = `<span class="note-embed-title">${escapeHtml(data.title)}</span>`;
  const favicon = data.kind !== 'post' && data.source
    ? `<img class="note-embed-fav" src="/api/v1/util/favicon?domain=${encodeURIComponent(data.source)}" alt="">`
    : '';
  const metaText = [data.source, data.meta].filter(Boolean).join(' · ');
  const metaLine = metaText
    ? `<span class="note-embed-meta">${favicon}${escapeHtml(metaText)}</span>` : '';

  let inner: string;
  if (variant === 'large') {
    const cover = data.image
      ? `<img class="note-embed-cover" src="${escapeHtml(data.image)}" alt="" loading="lazy">` : '';
    const kicker = data.kind === 'article' ? 'Saved article' : data.kind === 'post' ? 'Blog post' : '';
    inner = cover + '<span class="note-embed-body">' +
      (kicker ? `<span class="note-embed-kicker">${kicker}</span>` : '') + title +
      (data.description ? `<span class="note-embed-desc">${escapeHtml(data.description)}</span>` : '') +
      metaLine + '</span>';
  } else if (variant === 'link') {
    inner = favicon + title;
  } else {
    const thumb = data.image
      ? `<img class="note-embed-thumb" src="${escapeHtml(data.image)}" alt="" loading="lazy">` : '';
    inner = thumb + '<span class="note-embed-body">' + title + metaLine + '</span>';
  }

  const commentsRow = variant !== 'link' && /^https?:\/\//i.test(data.url)
    ? `<a class="note-embed-comments" href="${escapeHtml(data.href)}"></a>` : '';

  return `<span class="note-embed" data-embed="${data.kind}" data-variant="${variant}"` +
    attr('data-href', data.href) + attr('data-url', data.url) + attr('data-title', data.title) +
    attr('data-source', data.source) + attr('data-image', data.image) +
    attr('data-meta', data.meta) + attr('data-description', data.description) +
    ` contenteditable="false"><a class="note-embed-a" href="${escapeHtml(data.href)}" ` +
    `target="_blank" rel="noopener noreferrer">${inner}</a>${commentsRow}</span>`;
}

const nid = (p: string, n: number) => `${p}-${n}-${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  const argvUser = process.argv[2];
  if (argvUser) console.log(`(ignoring argument "${argvUser}" — this script owns its own cast)`);

  // ── Reset ───────────────────────────────────────────────────────────
  // Deleting the users cascades to everything they own: folders, bookmarks,
  // feed subscriptions, read state, reading list, posts, comments, images,
  // friendships and notifications.
  const removed = await prisma.user.deleteMany({ where: { username: { in: USERNAMES } } });
  if (removed.count > 0) console.log(`Cleared ${removed.count} existing showcase account(s).`);

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const ids = {} as Record<CastKey, string>;

  for (const key of Object.keys(CAST) as CastKey[]) {
    const c = CAST[key];
    const user = await prisma.user.create({
      data: {
        username: c.username, email: c.email, passwordHash,
        firstName: c.firstName, lastName: c.lastName,
      },
    });
    ids[key] = user.id;
    const avatar = gradient(320, 320, c.avatar[0], c.avatar[1]);
    await prisma.user.update({
      where: { id: user.id },
      data: { avatar: `data:image/png;base64,${avatar.toString('base64')}` },
    });
  }
  console.log(`Created ${USERNAMES.length} accounts.`);

  const marenId = ids.maren;

  // ── Profile ─────────────────────────────────────────────────────────
  const coverBuf = cover(1500, 500, '#1B2A4A', '#5E6AD2');
  await prisma.user.update({
    where: { id: marenId },
    data: {
      coverImage: await storeImage(marenId, coverBuf, 1500, 500),
      profileLinks: [
        { platform: 'website', url: 'https://example.com/maren' },
        { platform: 'github', url: 'https://github.com/example' },
      ],
    },
  });

  // ── Folders, bookmarks, pins, feed subscriptions ────────────────────
  const feedRows = await prisma.feed.findMany({ select: { id: true, fetchUrl: true, canonicalKey: true } });
  const feedByUrl = new Map(feedRows.map(f => [f.fetchUrl, f]));

  const folderIds: Record<string, string> = {};
  // Feed subscriptions are unique per (user, url) now and live in their own
  // categories, so position counts across the whole account rather than
  // restarting inside each bookmark folder.
  const seededFeedUrls = new Set<string>();
  let feedPosition = 0;

  for (const [fi, f] of FOLDERS.entries()) {
    const folder = await prisma.folder.create({
      data: { userId: marenId, name: f.name, color: f.color, position: fi },
    });
    folderIds[f.name] = folder.id;

    // Mirrors the bookmark folder, created only if it turns out to hold feeds —
    // an empty category would be noise in the filter bar.
    let feedFolderId: string | null = null;

    for (const [si, s] of f.sites.entries()) {
      await prisma.bookmark.create({
        data: {
          userId: marenId, folderId: folder.id, domain: s.domain, name: s.name,
          faviconUrl: `/api/v1/util/favicon?domain=${encodeURIComponent(s.domain)}`,
          color: f.color, position: si, pinned: s.pinned === true,
          feedUrl: s.feed ?? null,
          feedCheckedAt: s.feed ? new Date() : null,
          lastVisitedAt: new Date(Date.now() - si * 3_600_000),
        },
      });
      if (s.feed && !seededFeedUrls.has(s.feed)) {
        if (!feedFolderId) {
          const cat = await prisma.feedFolder.create({
            data: { userId: marenId, name: f.name, color: f.color, position: fi },
          });
          feedFolderId = cat.id;
        }
        await prisma.feedSubscription.create({
          data: { userId: marenId, feedFolderId, url: s.feed, name: s.name, position: feedPosition++ },
        });
        seededFeedUrls.add(s.feed);
      }
    }
  }
  console.log(`Created ${FOLDERS.length} folders and their bookmarks.`);

  // ── Read state ──────────────────────────────────────────────────────
  // Everything is unread by default, which would put a dot on every single row
  // and make the indicator meaningless. Mark all but the newest few per feed as
  // read, so the shots show a handful of genuine unread items.
  // Two competing constraints. The hero wants "a couple of unread dots" in the
  // sidebar, not a backlog; the feeds shot wants at least two unread cards
  // visible in a list sorted newest-first across five feeds. Three per feed is
  // the number that satisfies both — the folder badge stays in the teens while
  // the top of the article list is reliably unread.
  //
  // Note this state is perishable: the background feed scheduler keeps pulling
  // in new items, and every one of those arrives unread. Re-run this script
  // immediately before capturing.
  const UNREAD_PER_FEED = 3;
  const subscribed = FOLDERS.flatMap(f => f.sites).filter(s => s.feed).map(s => s.feed!);
  let readCount = 0;
  for (const url of subscribed) {
    const feed = feedByUrl.get(url);
    if (!feed) { console.warn(`  ! no Feed row for ${url} — its folder will look empty`); continue; }
    const items = await prisma.feedItem.findMany({
      where: { feedId: feed.id },
      orderBy: [{ pubDate: 'desc' }, { fetchedAt: 'desc' }],
      select: { id: true },
    });
    const toRead = items.slice(UNREAD_PER_FEED);
    if (toRead.length > 0) {
      await prisma.readFeedItem.createMany({
        data: toRead.map(i => ({ userId: marenId, itemId: i.id })),
        skipDuplicates: true,
      });
      readCount += toRead.length;
    }
  }
  console.log(`Marked ${readCount} items read, leaving ~${UNREAD_PER_FEED} unread per feed.`);

  await syncBookmarkBadges(marenId, feedRows.map(f => f.id));

  // ── Reading list ────────────────────────────────────────────────────
  // Real, recent, illustrated articles. The magazine layout leads on the first
  // item, so the newest well-illustrated one goes first.
  const shelfIds: string[] = [];
  for (const [i, s] of SHELVES.entries()) {
    const shelf = await prisma.readingFolder.create({
      data: { userId: marenId, name: s.name, color: s.color, position: i },
    });
    shelfIds.push(shelf.id);
  }

  const candidates = await prisma.feedItem.findMany({
    where: {
      imageUrl: { not: null },
      NOT: { imageUrl: '' },
      feed: { title: { in: ['The Verge', 'Ars Technica', 'MacRumors: Mac News and Rumors - All Stories', 'Autoblog News'] } },
    },
    orderBy: [{ pubDate: 'desc' }],
    take: 40,
    select: { title: true, link: true, imageUrl: true, readTime: true, snippet: true, categories: true, feed: { select: { title: true } } },
  });

  // One per publication first, so the list doesn't read as a single site's feed.
  const bySource = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const k = c.feed.title;
    if (!bySource.has(k)) bySource.set(k, [] as unknown as typeof candidates);
    bySource.get(k)!.push(c);
  }
  const interleaved: typeof candidates = [] as unknown as typeof candidates;
  for (let round = 0; round < 6; round++) {
    for (const list of bySource.values()) if (list[round]) interleaved.push(list[round]);
  }

  const sourceName = (feedTitle: string) =>
    feedTitle.replace(/:.*$/, '').replace(/ News$/, '').trim();

  // The magazine layout leads on a "feature" card, and magazineVariants() in
  // ReadingList.tsx only promotes an item that has artwork *and* a read time of
  // four minutes or more (the other two routes to it are a 240-character note
  // or a hash of the id, neither of which is worth depending on). Float the
  // first article that qualifies to the top so the layout is deterministic
  // rather than a coin flip on whatever id Prisma generated.
  const leadIdx = interleaved.findIndex(a => a.imageUrl && (a.readTime ?? 0) >= 4);
  if (leadIdx > 0) interleaved.unshift(...interleaved.splice(leadIdx, 1));

  const picked = interleaved.slice(0, 12);
  for (const [i, a] of picked.entries()) {
    const tag = tagFor(a.categories, a.link, sourceName(a.feed.title));
    await prisma.readingListItem.create({
      data: {
        userId: marenId,
        url: a.link,
        title: a.title,
        source: sourceName(a.feed.title),
        readTime: `${a.readTime ?? 3 + (i % 7)} min`,
        tag,
        notes: i === 0 ? 'Worth coming back to — the middle section is the actual argument.' : '',
        imageUrl: a.imageUrl ?? '',
        // The first eight stay in the active reading list (what the reading
        // shot captures); the rest go to Library shelves so those have content.
        inLibrary: i >= 8,
        folderId: i >= 8 ? shelfIds[(i - 8) % shelfIds.length] : null,
        savedAt: new Date(Date.now() - i * 5_400_000),
      },
    });
  }
  console.log(`Saved ${picked.length} real articles to the reading list and Library.`);

  // ── Blog posts ──────────────────────────────────────────────────────
  // A banner, not 16:9. At the post page's ~1150px content width a 1600×840
  // cover renders about 590px tall — two thirds of the blog shot's 900px frame,
  // leaving no room for the reference card and the comment thread the same shot
  // has to show. At 1600×300 it is ~215px, which is the budget that lets all
  // four things the spec asks for share one frame.
  const heroBuf = cover(1600, 300, '#101B33', '#0E7FB8');
  const heroPath = await storeImage(marenId, heroBuf, 1600, 300);

  // The reference card that sits in the main post's body points at a real
  // article the reading list also holds — which is the thing the card is for.
  const refArticle = picked[1] ?? picked[0];
  // `source` is the hostname here, not the publication name, because an
  // article-kind embed looks its favicon up by that field (see favicon() in
  // client/src/utils/noteEmbed.ts, and DOMAIN_SOURCE_KINDS above it).
  //
  // Worth knowing: the app itself does not do this. GET /folders/:id/articles
  // returns `source: feed.title`, so an article saved from a feed carries "The
  // Verge", and a reference card built from it asks the favicon proxy for a
  // domain called "The Verge" and renders a broken image. That is a real bug in
  // the app, not an artefact of this seed — it is just not one a marketing
  // screenshot should be the first to publish.
  const refHost = (() => {
    try { return new URL(refArticle.link).hostname.replace(/^www\./, ''); }
    catch { return sourceName(refArticle.feed.title); }
  })();
  const refEmbed = refArticle ? embedHtml({
    kind: 'article',
    href: `/a/${Buffer.from(refArticle.link, 'utf8').toString('base64url')}`,
    url: refArticle.link,
    title: refArticle.title,
    source: refHost,
    image: refArticle.imageUrl ?? undefined,
    meta: `${refArticle.readTime ?? 4} min`,
    // No description, deliberately. A large card renders it as two more lines,
    // ~100px, and that is exactly the margin by which the post's own cover was
    // being pushed out of the blog shot. The card still carries the cover, the
    // kicker, the headline, the source and the comments row.
  }, 'large') : '';

  const POSTS: { title: string; body: string; hero?: string; visibility: string; daysAgo: number }[] = [
    {
      title: 'A homepage you actually chose',
      visibility: 'public', daysAgo: 2, hero: heroPath,
      // Kept deliberately short. The blog shot has to fit the hero, the byline,
      // a reference card and the top of the comment thread into 900px; a longer
      // body pushes the card and the thread apart until no single frame holds
      // both, and the shot stops making its point.
      body:
        '<p>Every browser ships a new tab page, and every one of them is a storefront. ' +
        'Mine used to be a grid of the sites an algorithm had decided I visited most, ' +
        'which is not the same thing as the sites I wanted one keystroke away.</p>' +
        '<p>The piece that convinced me this was worth doing properly:</p>' +
        refEmbed,
    },
    {
      title: 'Notes are not documents',
      visibility: 'public', daysAgo: 9,
      body:
        '<p>I keep trying to store short thoughts in tools built for long ones. ' +
        'A note that lives three clicks and a load spinner away is a note I will not write.</p>' +
        '<p>What I want is closer to a drawer than a filing cabinet: it opens over ' +
        'whatever I was doing, it takes what I give it, and it closes.</p>' +
        '<ul><li>Open it without leaving the page</li><li>Write without choosing a folder first</li>' +
        '<li>Find it later by typing three words of it</li></ul>' +
        '<p>Everything past that is a document, and documents can wait.</p>',
    },
    {
      title: 'On reading the whole thing',
      visibility: 'public', daysAgo: 21,
      body:
        '<p>A saved article is a promise you make to yourself, and most of mine were lies. ' +
        'The fix was not a better queue — it was admitting how long the queue is allowed to be.</p>' +
        '<p>Eight. If a ninth thing is worth saving, something else was not.</p>',
    },
    {
      title: 'Draft: what a feed reader owes the writer',
      visibility: 'private', daysAgo: 1,
      body: '<p>Half-finished. The argument is that a reader which keeps you inside it ' +
        'is taking something that was never on offer.</p>',
    },
  ];

  const postRows: { id: string; title: string; url: string; slug: string; excerpt: string; heroImage: string }[] = [];
  for (const p of POSTS) {
    const slug = slugify(p.title);
    const url = postUrlFor(CAST.maren.username, slug);
    const body = sanitizeBlogHtml(p.body);
    const publishedAt = new Date(Date.now() - p.daysAgo * 86_400_000);
    const row = await prisma.blogPost.create({
      data: {
        userId: marenId, title: p.title, slug, body,
        excerpt: excerptOf(body), heroImage: p.hero ?? '',
        visibility: p.visibility, commentsEnabled: true,
        url, articleKey: canonicalArticleKey(url),
        publishedAt, createdAt: publishedAt,
      },
    });
    postRows.push({ id: row.id, title: p.title, url, slug, excerpt: row.excerpt, heroImage: row.heroImage });
  }
  console.log(`Published ${POSTS.length - 1} posts (plus one draft).`);

  // ── Comments ────────────────────────────────────────────────────────
  // A thread three replies deep on the lead post, which is what both the blog
  // and social shots ask for.
  const lead = postRows[0];
  const leadKey = canonicalArticleKey(lead.url);

  async function comment(
    userId: string, body: string, parentId: string | null, minutesAgo: number, title?: string,
  ): Promise<string> {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const row = await prisma.comment.create({
      data: {
        userId, articleKey: leadKey, articleUrl: lead.url, articleTitle: lead.title,
        parentId, title: parentId ? null : (title ?? null),
        body: sanitizeCommentHtml(body), visibility: 'public',
        createdAt: at, updatedAt: at,
      },
    });
    return row.id;
  }

  const c1 = await comment(
    ids.theo,
    '<p>The bit about deleting a folder that stopped earning its place is the whole thing. ' +
    'I have carried a "Later" folder across three browsers and eleven years and have never once opened it.</p>',
    null, 320, 'The folder you never open',
  );
  const c2 = await comment(
    ids.maren,
    '<p>Mine was called "Research". Same folder, better marketing.</p>',
    c1, 260,
  );
  await comment(
    ids.iris,
    '<p>What finally worked for me was making the queue visibly finite. ' +
    'A list that shows eight things and says so is a different object from one that scrolls forever.</p>',
    c2, 180,
  );
  const c4 = await comment(
    ids.sana,
    '<p>Counterpoint, gently: some of us genuinely do go back to the pile, just on a much ' +
    'longer cycle than a week. An archive is not a failed inbox.</p>',
    null, 120, 'In defence of the pile',
  );
  await comment(
    ids.maren,
    '<p>That is fair, and it is why the shelves exist separately from the list. ' +
    'The list is a commitment; the shelves are just storage.</p>',
    c4, 55,
  );
  console.log('Seeded a comment thread three replies deep.');

  // ── Friends and notifications ───────────────────────────────────────
  async function friendship(a: string, b: string, status: 'accepted' | 'pending') {
    await prisma.friendship.create({
      data: {
        requesterId: a, addresseeId: b, status,
        respondedAt: status === 'accepted' ? new Date() : null,
        pairKey: friendPairKey(a, b),
      },
    });
  }
  await friendship(ids.theo, marenId, 'accepted');
  await friendship(marenId, ids.iris, 'accepted');
  await friendship(ids.sana, marenId, 'pending');   // an unanswered request, for the bell

  await prisma.notification.createMany({
    data: [
      { userId: marenId, type: 'friend_request', actorId: ids.sana },
      {
        userId: marenId, type: 'comment_reply', actorId: ids.theo,
        articleKey: leadKey, articleUrl: lead.url, articleTitle: lead.title, commentId: c1,
      },
      {
        userId: marenId, type: 'friend_comment', actorId: ids.iris,
        articleKey: leadKey, articleUrl: lead.url, articleTitle: lead.title,
      },
    ],
  });
  console.log('Wired up friendships and notifications.');

  // ── Notes ───────────────────────────────────────────────────────────
  // Stored on the user, not in a table — see UserSettings in routes/settings.ts.
  const noteFolders = [
    { id: nid('nf', 1), name: 'Work', color: '#5E6AD2' },
    { id: nid('nf', 2), name: 'Personal', color: '#0FB57B' },
  ];

  const postEmbed = embedHtml({
    kind: 'post',
    href: `/u/${CAST.maren.username}/${postRows[1].slug}`,
    url: postUrlFor(CAST.maren.username, postRows[1].slug),
    title: postRows[1].title,
    source: `${CAST.maren.firstName} ${CAST.maren.lastName}`,
    meta: 'Jul 22, 2026',
    description: postRows[1].excerpt,
  }, 'small');

  const now = Date.now();
  const noteDocs = [
    {
      id: nid('nd', 1), folderId: noteFolders[0].id, updatedAt: now - 900_000,
      title: 'Homepage rewrite — week 3',
      // Short on purpose, and in this order. The notes shot needs the heading,
      // the to-dos and the reference card all visible *and* the slash menu
      // open — and that menu is ~430px tall, so it only opens downward (rather
      // than flipping up over the note) when there is that much room below the
      // caret. Every line here is one the menu would otherwise cover.
      body:
        '<h2>Where this stands</h2>' +
        '<div class="note-todo" data-checked="true">Pinned row survives a reorder</div>' +
        '<div class="note-todo">Read-time estimates on saved articles</div>' +
        '<p>The argument I keep coming back to:</p>' +
        postEmbed +
        // A trailing empty paragraph, so the notes shot has somewhere to put
        // the caret that is genuinely *after* the reference card. Ctrl+End
        // otherwise lands inside the embed's own paragraph, and the Enter that
        // followed split it — pushing the card below the caret and straight
        // under the slash menu that was about to open there.
        '<p><br></p>',
    },
    {
      id: nid('nd', 2), folderId: noteFolders[0].id, updatedAt: now - 3_600_000 * 5,
      title: 'Feed discovery — what to check',
      body:
        '<p>Order matters here. Try the bookmark\'s own <code>&lt;link rel="alternate"&gt;</code> ' +
        'before guessing at <code>/feed</code>.</p>' +
        '<div class="note-todo" data-checked="true">Parse the head</div>' +
        '<div class="note-todo">Fall back to the three common paths</div>',
    },
    {
      id: nid('nd', 3), folderId: noteFolders[1].id, updatedAt: now - 86_400_000,
      title: 'Cascade trip — packing',
      body:
        '<h2>Saturday</h2>' +
        '<div class="note-todo" data-checked="true">Book the ferry</div>' +
        '<div class="note-todo">Rain shell, the good one</div>' +
        '<div class="note-todo">Download the map before the pass</div>',
    },
    {
      id: nid('nd', 4), folderId: noteFolders[1].id, updatedAt: now - 86_400_000 * 4,
      title: 'Books, eventually',
      body: '<ul><li>The Making of the Atomic Bomb</li><li>Seeing Like a State</li>' +
        '<li>A Pattern Language — reread</li></ul>',
    },
    {
      id: nid('nd', 5), updatedAt: now - 86_400_000 * 2,
      title: 'Scratch',
      body: '<p>Ask about the nginx cache headers on the images route.</p>',
    },
  ];

  // Folders first, each followed by its own notes — the flat order the tree
  // rebuilds itself from.
  const order = [
    noteFolders[0].id, noteDocs[0].id, noteDocs[1].id,
    noteFolders[1].id, noteDocs[2].id, noteDocs[3].id,
    noteDocs[4].id,
  ];

  await prisma.user.update({
    where: { id: marenId },
    data: {
      settings: {
        searchEngine: 'duckduckgo',
        searchNewTab: false,
        theme: 'dark',
        consoleEnabled: true,
        notes: '',
        noteDocs,
        noteFolders,
        noteTreeOrder: order,
        noteSidebarWidth: 210,
        articleOpenMode: 'new-tab',
        readingListOpenMode: 'reader',
        bookmarkOpenMode: 'same-tab',
        bookmarkLayout: 'panel',
        backgroundGradient: 'none',
        rssLayout: 'cards',
        readingListLayout: 'magazine',   // the reading shot asks for it by name
        readingListCollapsed: false,
        rssEnabled: true,
        saveArticleMode: 'dialog',
        // Must stay on. FolderArticles computes isNew as
        // `markReadOnScroll && !readIds.has(id)`, so turning it off to stop the
        // capture clearing the dots removes the unread outlines and the newDot
        // along with it — which is the very thing the feeds shot is of.
        markReadOnScroll: true,
        commentsShowPublic: true,
        commentsDefaultVisibility: 'public',
        commentsSort: 'newest',
        commentsAutoExpand: true,
        // The gold in the feeds shot. These have to be tags that actually show
        // on a card: a card renders only its first few categories, so
        // favouriting a rare one gilds the card's outline while every visible
        // chip stays grey. 'AI' and 'Apple' are the two that turn up most in
        // these feeds, and turn up early enough in the list to be displayed.
        favoriteTags: ['AI', 'Apple'],
        rssFeedUrls: [],
      },
    },
  });

  // The supporting cast get a usable-but-plain setup, so logging in as one for
  // the social shot doesn't land on an empty page.
  for (const key of ['theo', 'iris', 'sana'] as CastKey[]) {
    await prisma.user.update({
      where: { id: ids[key] },
      data: { settings: { theme: 'dark', commentsShowPublic: true, commentsAutoExpand: true } },
    });
  }
  console.log('Wrote notes and settings.');

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────');
  console.log('Showcase accounts ready. Password for all:');
  console.log(`\n    ${PASSWORD}\n`);
  for (const key of Object.keys(CAST) as CastKey[]) {
    const c = CAST[key];
    const role = key === 'maren' ? 'main — every shot but `social`' : 'supporting cast';
    console.log(`  ${c.username.padEnd(12)} ${c.firstName} ${c.lastName}  (${role})`);
  }
  console.log('\nTake `social` while signed in as theovance, viewing /u/maren —');
  console.log('that is what shows the Follow button in its un-followed state.');
  console.log('─────────────────────────────────────────────');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
