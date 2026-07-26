// Seeds a cast of opinionated-but-good-faith commenters onto whichever recent
// feed articles are currently in the DB, so the moderation surfaces have real
// discussions to work through: multi-level threads, disagreements that stay
// civil, edit history, and a couple of friends-only comments.
//
// Everything here is ordinary content. Nothing is written to be deleted — the
// point is to practise the judgement, not to stock a queue with obvious spam.
//
//   npm run seed-personas                 # target the first admin
//   npm run seed-personas -- <username>   # target a specific user
//
// Re-runnable, and scoped: it wipes only *these* personas' comments, so the
// demo_* cast from seed-comments and seed-deep-threads is left alone.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma';
import { canonicalArticleKey, sanitizeCommentHtml } from '../src/lib/comments';

type PersonaKey = 'hattie' | 'toby' | 'nadia' | 'ellis' | 'rosa' | 'gus';
type Visibility = 'public' | 'friends' | 'private';

// Distinct enough that you can tell who is talking with the name covered — that
// is what makes a seeded thread read like an argument instead of filler.
const PERSONAS: Record<PersonaKey, {
  username: string; firstName: string; lastName: string; voice: string;
}> = {
  hattie: {
    username: 'persona_hattie', firstName: 'Hattie', lastName: 'Boyd',
    voice: 'The skeptic. Twenty years turning wrenches. Distrusts press releases and spec sheets; asks what breaks at 80,000 miles. Dry, concrete, first-hand.',
  },
  toby: {
    username: 'persona_toby', firstName: 'Toby', lastName: 'Whelan',
    voice: 'The enthusiast. Unembarrassed superlatives, exclamation marks, loves a manual gearbox and a big engine. Warm, a little much.',
  },
  nadia: {
    username: 'persona_nadia', firstName: 'Nadia', lastName: 'Osei',
    voice: 'The analyst. Numbers first — margins, volumes, supply chains. Hedges carefully, writes in structured paragraphs.',
  },
  ellis: {
    username: 'persona_ellis', firstName: 'Ellis', lastName: 'Park',
    voice: 'The contrarian. Takes the other side on principle. Sharp and blunt, but argues the substance and never the person.',
  },
  rosa: {
    username: 'persona_rosa', firstName: 'Rosa', lastName: 'Delgado',
    voice: 'The bridge-builder. Restates the disagreement, finds the shared premise, asks the clarifying question that unsticks a thread.',
  },
  gus: {
    username: 'persona_gus', firstName: 'Gus', lastName: 'Trainor',
    voice: 'The old hand. Historical context and "we tried this in 1997" anecdotes. Charming, occasionally tangential.',
  },
};

interface Node { author: PersonaKey; body: string; visibility?: Visibility; tag?: string; replies?: Node[] }
interface Thread { match: string; title?: string; root: Node }

// Matched to a current article by case-insensitive title substring, the same way
// the other seed scripts do it. A thread whose article has rolled out of the
// feed is skipped rather than misfiled.
const THREADS: Thread[] = [
  {
    match: 'vulnerable to theft due to dealer-installed',
    title: 'This is a supply-chain problem, not a car problem',
    root: {
      author: 'hattie', tag: 'bluetooth-root',
      body: 'Worth being precise about where this went wrong: the manufacturer did not ship this. A dealer bolted on an aftermarket tracker to sell a finance add-on, and that box speaks Bluetooth with a default pairing key. Every one of these I have pulled had the same key printed on the housing.',
      replies: [
        {
          author: 'nadia',
          body: 'That distinction matters commercially too. Dealer-installed accessories sit outside the OEM security review entirely, and they are high-margin enough that nobody in the chain is motivated to ask hard questions. The recall exposure lands on the brand regardless of who fitted the part.',
          replies: [
            {
              author: 'ellis',
              body: 'I would push back on "not a car problem". If your vehicle exposes a port that lets a third-party dongle authorise unlock and start, you have delegated your security boundary to whoever is cheapest at the dealership. That is a design decision, not an accident.',
              replies: [
                {
                  author: 'hattie',
                  body: 'Fair. I will meet you halfway — the bus was never designed with a hostile-accessory threat model, and it shows. But the fix people keep proposing (lock the bus down entirely) also ends independent repair, so I want that trade named out loud rather than assumed.',
                  replies: [
                    { author: 'rosa', body: 'So the actual disagreement is narrower than it looked: you both think the accessory is the proximate cause, and you differ on whether the open bus is a defect or a deliberate trade-off that has aged badly. Is that fair to both of you?' },
                  ],
                },
              ],
            },
            {
              author: 'gus',
              body: 'We went round this exact loop with aftermarket alarms in the nineties. Half of them tapped the ignition wire directly and a determined teenager with a screwdriver could defeat the lot. The lesson then was the same as now: the weakest thing anyone bolts on becomes the security of the whole vehicle.',
            },
          ],
        },
        {
          author: 'toby',
          body: 'Genuine question from someone who is not a security person — is there anything an owner can actually do here besides "have the dealer remove the box"? Because that is the advice in every one of these articles and it is not much help if the finance deal required it!',
          replies: [
            { author: 'hattie', body: 'Removal is genuinely the answer, and it is usually a fifteen-minute job. Ask for it in writing though — some contracts tie the rate to the tracker staying fitted, and you want the paper trail before you pull it.' },
          ],
        },
      ],
    },
  },

  {
    match: 'm2 cs is one manual away',
    root: {
      author: 'toby', tag: 'm2-root',
      body: 'One manual away is exactly right and it is genuinely maddening!! The chassis is there, the engine is there, and then you open the door and it is another paddle-shift automatic. I know the DCT is quicker. I do not care that the DCT is quicker.',
      replies: [
        {
          author: 'nadia',
          body: 'The take rate is the whole story, unfortunately. Manual uptake on the previous car was in the low teens by percentage, and a third pedal means a separate homologation and crash-test programme in several markets. At that volume it is very hard to make the maths work.',
          replies: [
            {
              author: 'ellis',
              body: 'Take rate is a circular argument though. You offer the manual on one trim, market it nowhere, quote a longer lead time, and then cite the resulting low uptake as proof nobody wanted it. The demand was measured through a funnel built to suppress it.',
              replies: [
                { author: 'nadia', body: 'That is a reasonable challenge and I do not have a clean rebuttal. I would only note the effect is real even where the manual was promoted heavily — but you are right that "nobody wants them" is doing more work in these discussions than the data supports.' },
                { author: 'gus', body: 'Every enthusiast car I have owned since about 2005 has come with a version of this conversation attached. At some point the manual stops being a transmission and starts being a statement, and manufacturers are quite bad at pricing statements.' },
              ],
            },
          ],
        },
        { author: 'hattie', body: 'Practical note from the workshop: the manuals are also the ones still driving at 150,000 miles. Dual-clutch units are superb until the mechatronics go, and then the bill is a meaningful fraction of the car.' },
      ],
    },
  },

  {
    match: 'privacy-focused smart glasses',
    title: 'Privacy-focused is doing a lot of work in that headline',
    root: {
      author: 'ellis', tag: 'glasses-root',
      body: 'Calling a camera you wear on your face "privacy-focused" is a category error. The privacy question was never about the wearer — it is about everyone in the room who did not agree to be in frame. No amount of on-device processing addresses that.',
      replies: [
        {
          author: 'rosa',
          body: 'I think you are both defining privacy differently and talking past the article as a result. It seems to mean "your captures do not leave your device", which is a real and meaningful guarantee. Your objection is about bystander consent, which is a different problem that the phrase quietly papers over. Both can be true.',
          replies: [
            { author: 'ellis', body: 'Accepted, and that is a better framing than mine. My worry is that the marketing collapses the two on purpose, so buyers hear the second guarantee when only the first was offered.' },
            {
              author: 'nadia',
              body: 'The recording indicator is where this gets decided in practice. A visible hardware LED that cannot be disabled in software is the only version of this that survives contact with regulators — and it is also the version that hurts the industrial design, which is why it keeps getting quietly dropped.',
              replies: [
                { author: 'hattie', body: 'And an LED that can be covered with a bit of electrical tape is not a control, it is a gesture. Ask me how the dashcam market went.' },
              ],
            },
          ],
        },
        { author: 'toby', body: 'I will be the person who admits they want these anyway. Hands-free navigation while driving is genuinely the thing I have wanted for a decade!' },
      ],
    },
  },

  {
    match: 'subaru',
    root: {
      author: 'gus',
      body: 'The Outback America Lost is a good line, but the car America actually lost was smaller than people remember it being. The 1998 car was the size of a modern Impreza. Nostalgia keeps quietly resizing it upward to match what we would tolerate today.',
      replies: [
        {
          author: 'nadia',
          body: 'This is the crossover ratchet in one paragraph. Each generation grows slightly because the outgoing car set the customer expectation, and footprint-based efficiency rules make the larger version comparatively cheaper to certify. Nobody decides to build a bigger wagon; it is the accumulated result of many small rational choices.',
        },
        { author: 'rosa', body: 'Is there a market where the smaller version survived? Genuinely asking — it would be useful to know whether this is a regulatory story or a preference story, and a counterexample would settle it.' },
      ],
    },
  },

  {
    match: 'ford is partnering with a chinese automaker',
    root: {
      author: 'nadia', tag: 'ford-root', visibility: 'friends',
      body: 'The structure is the interesting part. Partnering everywhere except the domestic market lets them absorb the platform and battery cost base without triggering the political exposure at home. It is a hedge against two different futures, and it is not cheap to hold both open.',
      replies: [
        { author: 'ellis', body: 'It is also an admission that the cost gap is not closing on its own. You do not license someone else\'s platform if you believe your own is eighteen months from parity.' },
        { author: 'hattie', body: 'From the service side, all I want to know is whether parts availability follows the platform. A shared architecture is fine right up until a common component has a twelve-week lead time and no aftermarket equivalent.' },
      ],
    },
  },

  {
    match: 'obsessed with going off-road',
    root: {
      author: 'hattie',
      body: 'The obsession is real, the off-roading mostly is not. I see a lot of skid plates with the paint still on them and all-terrain tyres worn flat and square from motorway miles. Which is fine — people are allowed to buy what they like — but the capability is being sold as an identity, not a use case.',
      replies: [
        {
          author: 'toby',
          body: 'Guilty as charged and completely unrepentant! Mine has been off tarmac exactly twice. But knowing it *could* changes how I feel every time I load it up, and I think that is worth something even if it never shows up in a spec comparison.',
          replies: [
            { author: 'rosa', body: 'That is an honest answer and I suspect it is the majority one. It might be worth separating "is this capability used" from "is this capability worth buying" — the thread keeps sliding between the two.' },
            { author: 'gus', body: 'The Range Rover was doing this in 1970. Sold on Rhodesian river crossings, bought for the school run in Surrey. The marketing has changed considerably; the buyer has not.' },
          ],
        },
      ],
    },
  },

  {
    match: 'radical transparency',
    root: {
      author: 'ellis', tag: 'transparency-root',
      body: 'Radical transparency is the easiest thing in the world to call for after somebody else has been breached. The test is whether the same standard gets applied when it is your own incident, your own timeline, and your own uncomfortable root cause.',
      replies: [
        {
          author: 'nadia',
          body: 'The asymmetry is structural rather than hypocritical, I think. Disclosure is cheap when it costs a competitor and expensive when it costs you, so the industry consistently lands on norms nobody follows under pressure. That is an argument for a disclosure requirement rather than a disclosure culture.',
          replies: [
            {
              author: 'rosa',
              body: 'Would a requirement actually have helped here? I am trying to work out whether the objection is to the sincerity of the call or to its usefulness, because those point at different fixes.',
              replies: [
                { author: 'ellis', body: 'The usefulness, mostly. I do not doubt he means it. I doubt that anything changes when a norm has no teeth and the incentive runs the other way.' },
              ],
            },
          ],
        },
        { author: 'gus', body: 'Every security era gets one of these speeches. The good ones come with a published post-mortem attached; the rest come with a press cycle.' },
      ],
    },
  },

  {
    match: 'cadillac optiq',
    root: {
      author: 'hattie', tag: 'optiq-root',
      body: 'Heat-related quality issues showing up in the first summer is the pattern you least want, because it means the validation programme did not cover a condition that a third of the customer base lives in year-round. That is a process finding, not a parts finding.',
      replies: [
        { author: 'toby', body: 'Is this the kind of thing a software update can sort, or is it a "bring it in and we will replace the component" job? Never sure where the line is on the electric ones.' },
        { author: 'nadia', body: 'Depends entirely on whether the failure is thermal management strategy or a materials choice. The first is a calibration change and cheap; the second is a running change plus a warranty reserve, and those are the ones that show up in a quarterly filing.' },
      ],
    },
  },
];

// A comment left on the target's own blog post, so there is something to
// moderate on content you own rather than only on syndicated articles.
const BLOG_THREAD: Node = {
  author: 'rosa',
  body: 'Congratulations on getting the first one out — that is genuinely the hard part. The bit about the UI work still to come resonates; every project I have shipped had a long tail of exactly that, and it is much more visible from the inside than from out here.',
  replies: [
    {
      author: 'toby', tag: 'blog-reply',
      body: 'Seconded! Also selfishly hoping the comment system stays this readable as threads get longer — the nesting here is much easier to follow than most sites I use.',
      replies: [
        { author: 'ellis', body: 'It reads well now, but the real test is the first argument that runs forty comments deep. Threading always looks clean until people start replying three levels up.' },
      ],
    },
    { author: 'gus', body: 'First posts are always slightly embarrassing in hindsight and that is exactly why they should stay up. Leave it exactly as it is.' },
  ],
};

// Applied after creation, in order — each snapshots the prior version into
// history, so the edit trail has something in it.
const EDITS: { tag: string; body?: string; visibility?: Visibility }[] = [
  { tag: 'bluetooth-root', body: 'Worth being precise about where this went wrong: the manufacturer did not ship this. A dealer bolted on an aftermarket tracker to sell a finance add-on, and that box speaks Bluetooth with a default pairing key. Every one of these I have pulled had the same key printed on the housing — not a per-unit key, the same one across the production run.' },
  { tag: 'm2-root', body: 'One manual away is exactly right and it is genuinely maddening!! The chassis is there, the engine is there, and then you open the door and it is another paddle-shift automatic. I know the DCT is quicker. I do not care that the DCT is quicker. (Edited because I have been told, repeatedly, that I should care.)' },
  { tag: 'glasses-root', body: 'Calling a camera you wear on your face "privacy-focused" is a category error. The privacy question was never about the wearer — it is about everyone in the room who did not agree to be in frame. No amount of on-device processing addresses that, because the person being recorded never got to read your privacy policy.' },
  { tag: 'optiq-root', visibility: 'friends' },
];

const MIN = 60_000;

async function ensurePersona(key: PersonaKey): Promise<string> {
  const p = PERSONAS[key];
  const existing = await prisma.user.findUnique({ where: { username: p.username }, select: { id: true } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { firstName: p.firstName, lastName: p.lastName } });
    return existing.id;
  }
  // Random password: these accounts exist to author content, not to be logged
  // into. Sign in as one by resetting it directly if you ever need to.
  const passwordHash = await bcrypt.hash(`persona-${p.username}-${Math.random().toString(36).slice(2)}`, 10);
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
  console.log(`Seeding persona discussions; friends/blog target: @${target.username}\n`);

  const ids = {} as Record<PersonaKey, string>;
  for (const key of Object.keys(PERSONAS) as PersonaKey[]) ids[key] = await ensurePersona(key);
  const personaIds = Object.values(ids);

  // Clean slate for *these* personas only — the demo_* cast is untouched.
  await prisma.comment.deleteMany({ where: { userId: { in: personaIds } } });
  await prisma.notification.deleteMany({ where: { userId: target.id, actorId: { in: personaIds } } });

  // Two are friends with the target, so friends-only comments have an audience.
  await ensureAcceptedFriendship(target.id, ids.nadia);
  await ensureAcceptedFriendship(target.id, ids.hattie);
  const targetFriendIds = new Set([ids.nadia, ids.hattie]);

  const articles = await prisma.feedItem.findMany({
    orderBy: { pubDate: 'desc' }, take: 60, select: { title: true, link: true },
  });
  const findArticle = (needle: string) =>
    articles.find(a => a.title.toLowerCase().includes(needle.toLowerCase()));

  const tagToId = new Map<string, string>();
  const counters = { roots: 0, replies: 0, notifs: 0, skipped: 0 };
  const now = Date.now();

  async function createNode(node: Node, ctx: { key: string; url: string; title: string; parentId: string | null; when: Date; rootTitle?: string }): Promise<void> {
    const vis: Visibility = node.visibility ?? 'public';
    const created = await prisma.comment.create({
      data: {
        userId: ids[node.author], articleKey: ctx.key, articleUrl: ctx.url, articleTitle: ctx.title,
        parentId: ctx.parentId,
        title: ctx.parentId ? null : (ctx.rootTitle ?? null),   // titles are root-only
        body: sanitizeCommentHtml(`<p>${node.body}</p>`), visibility: vis,
      },
      select: { id: true },
    });
    await backdate(created.id, ctx.when);
    if (node.tag) tagToId.set(node.tag, created.id);
    if (ctx.parentId) counters.replies++; else counters.roots++;

    if (vis === 'friends' && !ctx.parentId && targetFriendIds.has(ids[node.author])) {
      await prisma.notification.create({
        data: {
          userId: target.id, type: 'friend_comment', actorId: ids[node.author],
          articleKey: ctx.key, articleUrl: ctx.url, articleTitle: ctx.title, commentId: created.id,
        },
      });
      counters.notifs++;
    }

    // Replies land after their parent, and siblings are spread out, so the
    // thread reads as a conversation rather than a simultaneous dogpile.
    let childWhen = ctx.when;
    for (const child of node.replies ?? []) {
      childWhen = new Date(childWhen.getTime() + (9 + Math.floor(Math.random() * 26)) * MIN);
      await createNode(child, { ...ctx, parentId: created.id, when: childWhen });
    }
  }

  for (const [i, t] of THREADS.entries()) {
    const article = findArticle(t.match);
    if (!article) { console.log(`  · skipped — no current article matching "${t.match}"`); counters.skipped++; continue; }
    const when = new Date(now - (THREADS.length - i) * 97 * MIN);
    await createNode(t.root, {
      key: canonicalArticleKey(article.link), url: article.link, title: article.title,
      parentId: null, when, rootTitle: t.title,
    });
    console.log(`  ✓ ${article.title.slice(0, 62)}`);
  }

  // The target's own blog post, so moderation has a case on content you own.
  const post = await prisma.blogPost.findFirst({
    where: { userId: target.id, visibility: { not: 'private' } },
    orderBy: { publishedAt: 'desc' },
    select: { title: true, url: true, articleKey: true },
  });
  if (post) {
    await createNode(BLOG_THREAD, {
      key: post.articleKey, url: post.url, title: post.title,
      parentId: null, when: new Date(now - 140 * MIN),
    });
    console.log(`  ✓ blog post "${post.title}"`);
  } else {
    console.log('  · skipped blog thread — @' + target.username + ' has no published post');
  }

  // Edits, each snapshotting the prior version into history
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

  const total = await prisma.comment.count({ where: { userId: { in: personaIds } } });
  console.log(
    `\nDone: ${counters.roots} threads, ${counters.replies} replies (${total} comments), ` +
    `${editsApplied} edits, ${counters.notifs} notifications for @${target.username}` +
    (counters.skipped ? `, ${counters.skipped} skipped` : '') + '.'
  );
  console.log('\nCast:');
  for (const [key, p] of Object.entries(PERSONAS)) {
    console.log(`  @${p.username.padEnd(16)} ${p.firstName} ${p.lastName} — ${p.voice.split('.')[0]}`);
    void key;
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
