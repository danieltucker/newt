// Seeds realistic demo comments (and the friends/notifications state that makes
// the friends-visibility tier visible) from a handful of persona test users onto
// whichever recent feed articles are currently in the DB.
//
//   npm run seed-comments                 # seed for the first admin found
//   npm run seed-comments -- <username>   # seed friends/notifs for this user
//
// Re-runnable: it wipes the personas' own comments and the notifications they
// generated for the target user before re-inserting, so it never piles up dupes.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma';
import { canonicalArticleKey, sanitizeCommentHtml } from '../src/lib/comments';

type PersonaKey = 'alex' | 'jordan' | 'sam' | 'priya';
type Visibility = 'public' | 'friends' | 'private';

const PERSONAS: Record<PersonaKey, { username: string; firstName: string; lastName: string }> = {
  alex:   { username: 'demo_alex',   firstName: 'Alex',  lastName: 'Rivera' },
  jordan: { username: 'demo_jordan', firstName: 'Jordan', lastName: 'Kim' },
  sam:    { username: 'demo_sam',    firstName: 'Sam',   lastName: 'Okafor' },
  priya:  { username: 'demo_priya',  firstName: 'Priya', lastName: 'Nair' },
};

interface SeedComment {
  match: string;           // case-insensitive substring of a recent article title
  author: PersonaKey;
  visibility: Visibility;
  body: string;
  replies?: { author: PersonaKey; body: string; visibility?: Visibility }[];
}

// Comments are written to read like genuine reactions to each piece.
const COMMENTS: SeedComment[] = [
  {
    match: 'satellite images of iran',
    author: 'alex', visibility: 'public',
    body: 'Delaying commercial satellite imagery during an active conflict is a rough precedent — that open data is exactly what journalists and OSINT researchers use to fact-check official claims.',
    replies: [
      { author: 'jordan', body: 'Fair, though the same frames double as targeting data. The line between transparency and operational risk is genuinely blurry here.' },
    ],
  },
  {
    match: 'blade runner 2099',
    author: 'priya', visibility: 'public',
    body: 'Cautiously optimistic. 2049 earned its slow burn; a series gives them room to breathe — as long as they resist the urge to over-explain the world.',
    replies: [
      { author: 'sam', body: "The ambiguity is the whole point. The moment a show spells out what a replicant 'really is', the magic's gone." },
    ],
  },
  {
    match: 'nearly matches flagship',
    author: 'jordan', visibility: 'public',
    body: 'Near-flagship quality at half the cost is the actual headline. The price/performance curve is bending way faster than anyone budgeted for a year ago.',
    replies: [
      { author: 'alex', body: "This quietly torpedoes a lot of 'we fine-tuned a tiny model to save money' roadmaps." },
    ],
  },
  {
    match: 'sixers sign lebron',
    author: 'sam', visibility: 'public',
    body: '10-1 to win it all feels generous even with LeBron. The whole question is how his usage fits next to Embiid.',
    replies: [
      { author: 'priya', body: 'As a lifelong Sixers fan I am NOT emotionally prepared for this. Trust the process, I guess?!', visibility: 'friends' },
    ],
  },
  {
    match: 'anduril',
    author: 'alex', visibility: 'friends',
    body: '3x in a single year on mostly government revenue — defense tech is clearly the new darling, but those multiples assume procurement cycles that historically move at a glacial pace.',
  },
  {
    match: 'alphafold',
    author: 'priya', visibility: 'public',
    body: 'Using structure prediction to cut off-target effects is a genuinely great application. Safety has always been the bottleneck between CRISPR and the clinic.',
  },
  {
    match: 'launches opus 5',
    author: 'jordan', visibility: 'public',
    body: "Leading with 'cheaper AND less restrictive' is a bold combination. Curious how that framing lands with the safety crowd.",
  },
  {
    match: 'google zero',
    author: 'sam', visibility: 'public',
    body: 'The old bargain — Google indexes you, you get traffic — is just gone. Answer engines keep the click, and publishers are left holding the hosting bill.',
    replies: [
      { author: 'alex', body: 'And the incentive to publish anything original erodes right as the models get hungrier for it. Feels like a slow-motion tragedy of the commons.' },
    ],
  },
];

const now = Date.now();
const MIN = 60_000;

async function ensurePersona(key: PersonaKey): Promise<string> {
  const p = PERSONAS[key];
  const existing = await prisma.user.findUnique({ where: { username: p.username }, select: { id: true } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { firstName: p.firstName, lastName: p.lastName } });
    return existing.id;
  }
  const passwordHash = await bcrypt.hash(`demo-${p.username}-${Math.random().toString(36).slice(2)}`, 10);
  const created = await prisma.user.create({
    data: { username: p.username, firstName: p.firstName, lastName: p.lastName, passwordHash },
    select: { id: true },
  });
  return created.id;
}

async function ensureAcceptedFriendship(a: string, b: string) {
  const existing = await prisma.friendship.findFirst({
    where: { OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] },
  });
  if (existing) {
    if (existing.status !== 'accepted') {
      await prisma.friendship.update({ where: { id: existing.id }, data: { status: 'accepted', respondedAt: new Date() } });
    }
    return;
  }
  await prisma.friendship.create({ data: { requesterId: a, addresseeId: b, status: 'accepted', respondedAt: new Date() } });
}

async function ensurePendingRequest(requesterId: string, addresseeId: string) {
  const existing = await prisma.friendship.findFirst({
    where: { OR: [{ requesterId, addresseeId }, { requesterId: addresseeId, addresseeId: requesterId }] },
  });
  if (existing) return;
  await prisma.friendship.create({ data: { requesterId, addresseeId, status: 'pending' } });
}

async function backdate(id: string, when: Date) {
  // Set both timestamps together so the comment isn't flagged as "edited".
  await prisma.$executeRaw`UPDATE "Comment" SET "createdAt" = ${when}, "updatedAt" = ${when} WHERE "id" = ${id}`;
}

async function main() {
  const targetUsername = process.argv.slice(2).find(a => !a.startsWith('--'));
  const target = targetUsername
    ? await prisma.user.findUnique({ where: { username: targetUsername }, select: { id: true, username: true } })
    : await prisma.user.findFirst({ where: { isAdmin: true }, orderBy: { createdAt: 'asc' }, select: { id: true, username: true } });
  if (!target) { console.error('No target user found (pass a username, or create an admin first).'); process.exit(1); }
  console.log(`Seeding demo content; friends/notifications target: @${target.username}`);

  // Personas
  const ids: Record<PersonaKey, string> = {
    alex: await ensurePersona('alex'),
    jordan: await ensurePersona('jordan'),
    sam: await ensurePersona('sam'),
    priya: await ensurePersona('priya'),
  };
  const personaIds = Object.values(ids);

  // Clean slate so re-runs don't duplicate
  await prisma.comment.deleteMany({ where: { userId: { in: personaIds } } });
  await prisma.notification.deleteMany({ where: { userId: target.id, actorId: { in: personaIds } } });

  // Friends graph: two personas are friends with the target (so their
  // friends-only comments are visible to them), one has a pending request in.
  await ensureAcceptedFriendship(target.id, ids.alex);
  await ensureAcceptedFriendship(target.id, ids.priya);
  await ensurePendingRequest(ids.jordan, target.id);
  await prisma.notification.create({ data: { userId: target.id, type: 'friend_request', actorId: ids.jordan } });

  // The friends of the target, so we know which friends-comments should notify them
  const targetFriendIds = new Set([ids.alex, ids.priya]);

  // Recent articles to hang comments off of
  const articles = await prisma.feedItem.findMany({
    orderBy: { pubDate: 'desc' }, take: 40,
    select: { title: true, link: true },
  });
  const findArticle = (needle: string) =>
    articles.find(a => a.title.toLowerCase().includes(needle.toLowerCase()));

  let commentCount = 0, replyCount = 0, skipped = 0, notifCount = 1; // 1 = the friend_request above
  let stagger = 0;

  for (const c of COMMENTS) {
    const article = findArticle(c.match);
    if (!article) { console.log(`  · skipped (no current article for "${c.match}")`); skipped++; continue; }

    const key = canonicalArticleKey(article.link);
    const rootWhen = new Date(now - (COMMENTS.length - stagger) * 47 * MIN);
    const root = await prisma.comment.create({
      data: {
        userId: ids[c.author], articleKey: key, articleUrl: article.link, articleTitle: article.title,
        parentId: null, title: null, body: sanitizeCommentHtml(`<p>${c.body}</p>`), visibility: c.visibility,
      },
      select: { id: true },
    });
    await backdate(root.id, rootWhen);
    commentCount++;
    if (c.visibility === 'friends' && targetFriendIds.has(ids[c.author])) {
      await prisma.notification.create({
        data: { userId: target.id, type: 'friend_comment', actorId: ids[c.author], articleKey: key, articleUrl: article.link, articleTitle: article.title, commentId: root.id },
      });
      notifCount++;
    }
    console.log(`  ✓ ${PERSONAS[c.author].firstName} on "${article.title.slice(0, 48)}"  [${c.visibility}]`);

    for (const [i, r] of (c.replies ?? []).entries()) {
      const vis = r.visibility ?? 'public';
      const reply = await prisma.comment.create({
        data: {
          userId: ids[r.author], articleKey: key, articleUrl: article.link, articleTitle: article.title,
          parentId: root.id, title: null, body: sanitizeCommentHtml(`<p>${r.body}</p>`), visibility: vis,
        },
        select: { id: true },
      });
      await backdate(reply.id, new Date(rootWhen.getTime() + (i + 1) * 12 * MIN));
      replyCount++;
    }
    stagger++;
  }

  console.log(`\nDone: ${commentCount} comments, ${replyCount} replies, ${notifCount} notifications for @${target.username}${skipped ? `, ${skipped} skipped` : ''}.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
