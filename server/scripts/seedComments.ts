// Seeds a rich, realistic demo of the comments system from a handful of persona
// test users onto whichever recent feed articles are currently in the DB:
// threaded replies, a few edits (which build real edit history), and a couple of
// deletes of comments that have replies (which tombstone rather than remove the
// thread). Also wires up the friends/notifications state so the friends-only
// tier and the People badge have something to show.
//
//   npm run seed-comments                 # target the first admin
//   npm run seed-comments -- <username>   # target a specific user
//
// Re-runnable: wipes the personas' own comments (and the notifications they made
// for the target) first, so it always rebuilds the same demo state.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma';
import { canonicalArticleKey, sanitizeCommentHtml } from '../src/lib/comments';

type PersonaKey = 'alex' | 'jordan' | 'sam' | 'priya';
type Visibility = 'public' | 'friends' | 'private';

const PERSONAS: Record<PersonaKey, { username: string; firstName: string; lastName: string }> = {
  alex:   { username: 'demo_alex',   firstName: 'Alex',   lastName: 'Rivera' },
  jordan: { username: 'demo_jordan', firstName: 'Jordan', lastName: 'Kim' },
  sam:    { username: 'demo_sam',    firstName: 'Sam',    lastName: 'Okafor' },
  priya:  { username: 'demo_priya',  firstName: 'Priya',  lastName: 'Nair' },
};

interface Node { author: PersonaKey; body: string; visibility?: Visibility; tag?: string; replies?: Node[] }
interface Thread { match: string; root: Node }

// Each thread is matched to a current article by a case-insensitive title substring.
const THREADS: Thread[] = [
  {
    match: 'qualcomm is about to raise prices',
    root: {
      author: 'alex', tag: 'qualcomm-root',
      body: 'If Qualcomm raises modem prices it flows straight into every flagship Android BOM, and eventually onto the sticker price. There is no real second source at the high end right now.',
      replies: [
        { author: 'jordan', body: "Apple's own-modem timeline suddenly looks a lot more strategic than stubborn." },
      ],
    },
  },
  {
    match: 'moderation nightmare for its smart glasses',
    root: {
      author: 'priya',
      body: 'The moment always-on capture meets a moderation pipeline you get an impossible latency-vs-safety tradeoff. Glasses also make the bystander-consent problem physical.',
      replies: [
        { author: 'sam', body: 'Right — the person being recorded never opted into anyone’s moderation policy.' },
      ],
    },
  },
  {
    match: 'coiner of ‘enshittification’',
    root: {
      author: 'sam',
      body: 'Doctorow endorsing “dickover” is peak 2026. We genuinely needed a verb for the slow bleed of a product’s soul once the growth team takes over.',
    },
  },
  {
    match: 'midjourney bought the astrology app',
    root: {
      author: 'jordan',
      body: 'An image model buying Co-Star reads as a non-sequitur until you realize the actual asset is a daily-engagement habit and a very online audience.',
      replies: [
        { author: 'alex', body: 'Distribution is the moat now, not the model. Everyone has a good-enough model.' },
      ],
    },
  },
  {
    match: 'satellite images of iran',
    root: {
      author: 'alex', tag: 'satellite-root',
      body: 'Delaying commercial satellite imagery during an active conflict is a rough precedent — that open data is exactly what journalists and OSINT researchers use to fact-check official claims.',
      replies: [
        { author: 'jordan', body: 'Fair, though the same frames double as targeting data. The line between transparency and operational risk is genuinely blurry here.' },
      ],
    },
  },
  {
    match: 'nearly matches flagship',
    root: {
      author: 'jordan', tag: 'opus5-root',
      body: 'Near-flagship quality at half the cost is the actual headline. The price/performance curve is bending faster than anyone budgeted for a year ago.',
      replies: [
        { author: 'alex', body: "This quietly torpedoes a lot of 'we fine-tuned a tiny model to save money' roadmaps." },
      ],
    },
  },
  {
    match: 'sixers sign lebron',
    root: {
      author: 'sam',
      body: '10-1 to win it all feels generous even with LeBron. The whole question is how his usage fits next to Embiid.',
      replies: [
        { author: 'priya', visibility: 'friends', tag: 'sixers-reply',
          body: 'As a lifelong Sixers fan I am NOT emotionally prepared for this. Trust the process, I guess?!' },
      ],
    },
  },
  {
    match: 'anduril',
    root: {
      author: 'alex', visibility: 'friends',
      body: '3x in a single year on mostly government revenue — defense tech is clearly the new darling, but those multiples assume procurement cycles that historically move at a glacial pace.',
    },
  },
  {
    match: 'google zero',
    root: {
      author: 'sam', tag: 'googlezero-root',
      body: 'The old bargain — Google indexes you, you get traffic — is just gone. Answer engines keep the click and publishers are left holding the hosting bill.',
      replies: [
        {
          author: 'alex',
          body: 'And the incentive to publish anything original erodes right as the models get hungrier for it.',
          replies: [
            { author: 'priya', body: 'Tragedy of the commons, except the commons is the entire open web.' },
          ],
        },
      ],
    },
  },
  {
    match: 'founder under 20',
    root: {
      author: 'priya',
      body: 'Building in public is great until the failure is also in public and permanent. That is a lot of exposure to carry at nineteen.',
    },
  },
  {
    match: 'went rogue before kimi',
    root: {
      author: 'jordan',
      body: "'Went rogue' is doing heavy lifting in that headline, but the Kimi reaction shows how jumpy the market is about open models right now.",
      replies: [
        { author: 'sam', body: 'The vibes-based valuation swings are the real story here.' },
      ],
    },
  },
];

// Applied after creation, in order. A tag edited twice yields two history entries.
const EDITS: { tag: string; body?: string; visibility?: Visibility }[] = [
  { tag: 'opus5-root', body: 'Near-flagship quality at half the cost is the actual headline. The price/performance curve is bending faster than anyone priced in a year ago — and this is the floor, not the ceiling.' },
  { tag: 'opus5-root', body: 'Near-flagship quality at roughly half the cost is the whole story. (Edited to add: the second-order effect is that "use a cheap model for the boring 80%" architectures stop making economic sense.)' },
  { tag: 'sixers-reply', body: 'As a lifelong Sixers fan I am NOT emotionally prepared for this. Trust the process — again. (Okay, I have made my peace with it.)' },
  { tag: 'qualcomm-root', body: 'If Qualcomm raises modem prices it flows straight into every flagship Android BOM and eventually onto the sticker price — there is no real second source at the high end. Worth watching whether Samsung leans harder on Exynos because of exactly this.' },
];

// Roots (each with replies) to delete — these should tombstone, not remove the thread.
const DELETE_TAGS = ['satellite-root', 'googlezero-root'];

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
  // createdAt + updatedAt together, so a freshly-created comment isn't flagged as edited.
  await prisma.$executeRaw`UPDATE "Comment" SET "createdAt" = ${when}, "updatedAt" = ${when} WHERE "id" = ${id}`;
}

async function main() {
  const targetUsername = process.argv.slice(2).find(a => !a.startsWith('--'));
  const target = targetUsername
    ? await prisma.user.findUnique({ where: { username: targetUsername }, select: { id: true, username: true } })
    : await prisma.user.findFirst({ where: { isAdmin: true }, orderBy: { createdAt: 'asc' }, select: { id: true, username: true } });
  if (!target) { console.error('No target user found (pass a username, or create an admin first).'); process.exit(1); }
  console.log(`Seeding demo activity; friends/notifications target: @${target.username}\n`);

  const ids: Record<PersonaKey, string> = {
    alex: await ensurePersona('alex'),
    jordan: await ensurePersona('jordan'),
    sam: await ensurePersona('sam'),
    priya: await ensurePersona('priya'),
  };
  const personaIds = Object.values(ids);

  // Clean slate (comment deletes cascade their revisions + replies)
  await prisma.comment.deleteMany({ where: { userId: { in: personaIds } } });
  await prisma.notification.deleteMany({ where: { userId: target.id, actorId: { in: personaIds } } });

  // Friends graph: two personas are friends with the target, one has a pending request in.
  await ensureAcceptedFriendship(target.id, ids.alex);
  await ensureAcceptedFriendship(target.id, ids.priya);
  await ensurePendingRequest(ids.jordan, target.id);
  await prisma.notification.create({ data: { userId: target.id, type: 'friend_request', actorId: ids.jordan } });
  const targetFriendIds = new Set([ids.alex, ids.priya]);

  const articles = await prisma.feedItem.findMany({
    orderBy: { pubDate: 'desc' }, take: 40, select: { title: true, link: true },
  });
  const findArticle = (needle: string) =>
    articles.find(a => a.title.toLowerCase().includes(needle.toLowerCase()));

  const tagToId = new Map<string, string>();
  const counters = { roots: 0, replies: 0, notifs: 1, skipped: 0 };
  const now = Date.now();

  // Create a node and its reply subtree.
  async function createNode(node: Node, ctx: { key: string; url: string; title: string; parentId: string | null; when: Date }): Promise<void> {
    const vis: Visibility = node.visibility ?? 'public';
    const created = await prisma.comment.create({
      data: {
        userId: ids[node.author], articleKey: ctx.key, articleUrl: ctx.url, articleTitle: ctx.title,
        parentId: ctx.parentId, title: null, body: sanitizeCommentHtml(`<p>${node.body}</p>`), visibility: vis,
      },
      select: { id: true },
    });
    await backdate(created.id, ctx.when);
    if (node.tag) tagToId.set(node.tag, created.id);
    if (ctx.parentId) counters.replies++; else counters.roots++;

    // A friends-only root notifies the target if its author is their friend
    if (vis === 'friends' && !ctx.parentId && targetFriendIds.has(ids[node.author])) {
      await prisma.notification.create({
        data: { userId: target.id, type: 'friend_comment', actorId: ids[node.author], articleKey: ctx.key, articleUrl: ctx.url, articleTitle: ctx.title, commentId: created.id },
      });
      counters.notifs++;
    }

    let childWhen = ctx.when;
    for (const child of node.replies ?? []) {
      childWhen = new Date(childWhen.getTime() + 13 * MIN);
      await createNode(child, { ...ctx, parentId: created.id, when: childWhen });
    }
  }

  // Seed the threads, spaced out over the past day
  for (const [i, t] of THREADS.entries()) {
    const article = findArticle(t.match);
    if (!article) { console.log(`  · skipped (no current article for "${t.match}")`); counters.skipped++; continue; }
    const when = new Date(now - (THREADS.length - i) * 41 * MIN);
    await createNode(t.root, { key: canonicalArticleKey(article.link), url: article.link, title: article.title, parentId: null, when });
    console.log(`  ✓ thread on "${article.title.slice(0, 52)}"`);
  }

  // Apply edits (each snapshots the prior version into history)
  let editsApplied = 0;
  for (const e of EDITS) {
    const id = tagToId.get(e.tag);
    if (!id) continue;
    const cur = await prisma.comment.findUnique({ where: { id }, select: { title: true, body: true, visibility: true } });
    if (!cur) continue;
    const data: Record<string, unknown> = {};
    if (e.body !== undefined) data.body = sanitizeCommentHtml(`<p>${e.body}</p>`);
    if (e.visibility !== undefined) data.visibility = e.visibility;
    const changed =
      ('body' in data && data.body !== cur.body) ||
      ('visibility' in data && data.visibility !== cur.visibility);
    if (!changed) continue;
    await prisma.$transaction(async tx => {
      await tx.commentRevision.create({ data: { commentId: id, title: cur.title, body: cur.body, visibility: cur.visibility } });
      await tx.comment.update({ where: { id }, data });
    });
    editsApplied++;
  }

  // Delete (tombstone) roots that have replies
  let tombstoned = 0;
  for (const tag of DELETE_TAGS) {
    const id = tagToId.get(tag);
    if (!id) continue;
    const replies = await prisma.comment.count({ where: { parentId: id } });
    if (replies === 0) continue;
    await prisma.$transaction([
      prisma.commentRevision.deleteMany({ where: { commentId: id } }),
      prisma.comment.update({ where: { id }, data: { deletedAt: new Date(), body: '', title: null } }),
    ]);
    tombstoned++;
  }

  console.log(
    `\nDone: ${counters.roots} threads, ${counters.replies} replies, ` +
    `${editsApplied} edits, ${tombstoned} deleted-with-replies (tombstoned), ` +
    `${counters.notifs} notifications for @${target.username}` +
    (counters.skipped ? `, ${counters.skipped} skipped` : '') + '.'
  );
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
