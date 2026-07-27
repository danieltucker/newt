// Seeds 50 comments spread across ~25 of the articles published in the last few
// days, backdated so the activity trails off behind "now" instead of all landing
// in the same minute. Uses the same demo_* cast as seed-comments and
// seed-deep-threads, but deliberately targets *different* articles, so the three
// scripts compose rather than fight.
//
//   npm run seed-recent-chatter                 # target the first admin
//   npm run seed-recent-chatter -- <username>   # target a specific user
//
// The target only matters for the friends-only tier: a friends-visibility root
// notifies the target when its author is already an accepted friend. This script
// never edits the friends graph — run seed-comments first if you want one.
//
// Re-runnable, and narrowly scoped: it wipes only these personas' comments on the
// articles it is about to seed, so the other seeds' threads survive.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma';
import { canonicalArticleKey, sanitizeCommentHtml } from '../src/lib/comments';

type PersonaKey = 'alex' | 'jordan' | 'sam' | 'priya' | 'maya' | 'diego' | 'ren' | 'fatima';
type Visibility = 'public' | 'friends' | 'private';

const PERSONAS: Record<PersonaKey, { username: string; firstName: string; lastName: string }> = {
  alex:   { username: 'demo_alex',   firstName: 'Alex',   lastName: 'Rivera' },
  jordan: { username: 'demo_jordan', firstName: 'Jordan', lastName: 'Kim' },
  sam:    { username: 'demo_sam',    firstName: 'Sam',    lastName: 'Okafor' },
  priya:  { username: 'demo_priya',  firstName: 'Priya',  lastName: 'Nair' },
  maya:   { username: 'demo_maya',   firstName: 'Maya',   lastName: 'Torres' },
  diego:  { username: 'demo_diego',  firstName: 'Diego',  lastName: 'Santos' },
  ren:    { username: 'demo_ren',    firstName: 'Ren',    lastName: 'Nakamura' },
  fatima: { username: 'demo_fatima', firstName: 'Fatima', lastName: 'Hassan' },
};

interface Node { author: PersonaKey; body: string; visibility?: Visibility; replies?: Node[] }
// `match` is a case-insensitive title substring (ASCII only — feed titles are
// full of curly quotes, so match around them). `hoursAgo` places the root; each
// reply lands a little after its parent.
interface Thread { match: string; hoursAgo: number; root: Node }

const THREADS: Thread[] = [
  {
    match: 'partnering with a chinese automaker', hoursAgo: 3,
    root: {
      author: 'alex',
      body: 'Partnering everywhere except the one market where the tariffs bite is the whole strategy in a sentence. Ford gets the platform economics without the political fight.',
      replies: [
        { author: 'diego', body: 'It also means the cost gap keeps widening for US buyers specifically, which is a strange thing to engineer on purpose.' },
      ],
    },
  },
  {
    match: 'rav4 awd system has one weakness', hoursAgo: 5,
    root: {
      author: 'maya',
      body: 'Every on-demand AWD system has this weakness — it reacts after slip instead of before it. Fine for a wet on-ramp, not what people picture when they read "all-wheel drive" on the window sticker.',
      replies: [
        { author: 'ren', body: 'The marketing gap is the real problem. Nobody buying a RAV4 is reading a clutch-pack spec sheet.' },
      ],
    },
  },
  {
    match: 'bmw m2 cs is one manual away', hoursAgo: 7,
    root: {
      author: 'diego',
      body: 'A CS with two pedals is a fantastic car and a slightly sad one. The whole CS premise is "we removed the compromises", and then the biggest one stays.',
      replies: [
        {
          author: 'fatima',
          body: 'Take rates for manuals are low enough that the business case basically writes itself against you, sadly.',
          replies: [
            { author: 'jordan', body: 'Low take rates on a halo car are kind of the point though — nobody expects the CS to pay for itself.' },
          ],
        },
      ],
    },
  },
  {
    match: 'obsessed with going off-road', hoursAgo: 9,
    root: {
      author: 'sam',
      body: 'Ninety percent of these trucks will never see anything rougher than a gravel campground road, and honestly that is fine. People buy the option to, not the activity.',
    },
  },
  {
    match: '26,000 hybrid wagon', hoursAgo: 12,
    root: {
      author: 'ren',
      body: 'A $26k hybrid wagon is exactly the car everyone claims to want right up until the moment they walk past it to the crossover on the next row.',
      replies: [
        { author: 'maya', body: 'To be fair, we never actually got the chance to walk past it — it was never offered here.' },
      ],
    },
  },
  {
    match: 'vulnerable to theft due to dealer-installed', hoursAgo: 14,
    root: {
      author: 'priya',
      body: 'The part that should worry people is that this is dealer-installed aftermarket hardware. It sits outside the automaker’s security review and outside its update pipeline, so nobody owns the patch.',
      replies: [
        {
          author: 'alex',
          body: 'Right — the OEM will point at the dealer, the dealer will point at the vendor, and the vendor is three acquisitions deep by now.',
          replies: [
            { author: 'sam', body: 'And the owner has no way to even find out the box is on their car unless they go looking behind the dash.' },
          ],
        },
      ],
    },
  },
  {
    match: 'calling 911 on sleeping passengers', hoursAgo: 17,
    root: {
      author: 'jordan',
      body: 'An unresponsive passenger is a genuinely hard call to automate. Escalate every time and you are wasting dispatchers on nappers; escalate never and eventually you miss a real emergency.',
      replies: [
        { author: 'fatima', body: 'A human driver makes that judgement in two seconds with context a camera cannot get. That is the whole gap in one example.' },
      ],
    },
  },
  {
    match: '50 exhaust filter', hoursAgo: 20,
    root: {
      author: 'maya',
      body: 'Great project, and I hope they keep at it — but "74% in bench conditions" and "74% over a durability cycle at temperature" are very different numbers.',
      replies: [
        { author: 'diego', body: 'The teardown after 30,000 miles is the interesting result. Everything upstream of that is a science fair.' },
      ],
    },
  },
  {
    match: 'supra fire recall', hoursAgo: 23,
    root: {
      author: 'diego',
      body: '300,000 vehicles across two brands sharing one platform is the shared-development bill coming due. The savings were real; so is this.',
    },
  },
  {
    match: 'cadillac optiq', hoursAgo: 26,
    root: {
      author: 'ren',
      body: 'Heat-related quality issues showing up in the first summer is the kind of thing that used to surface in year three, back when validation cycles were longer than product cycles.',
      replies: [
        { author: 'priya', body: 'Compressed launch timelines have to come out of somewhere, and it is almost always hot-weather testing.' },
      ],
    },
  },
  {
    match: 'hugging face ceo calls for', hoursAgo: 29,
    root: {
      author: 'alex',
      body: 'Radical transparency is the right ask, but note that every lab treats incident detail as competitive information. The disclosure norms will have to be forced from outside.',
      replies: [
        {
          author: 'jordan',
          body: 'Aviation got there eventually — blameless incident reports, mandatory publication. It took decades and a lot of crashes.',
          replies: [
            { author: 'fatima', body: 'The difference being that a plane crash is unambiguous. Half these incidents are arguments about what counts as a breach.' },
          ],
        },
      ],
    },
  },
  {
    match: 'privacy-focused smart glasses', hoursAgo: 32,
    root: {
      author: 'fatima',
      body: 'Leading with privacy on a face computer is the only positioning left that is not already taken, and it happens to be the one Apple can actually execute.',
      replies: [
        { author: 'sam', body: 'It still does not solve the bystander problem. My privacy settings are not the ones being violated when someone points a camera at me.' },
      ],
    },
  },
  {
    match: 'blame ai for layoffs', hoursAgo: 35,
    root: {
      author: 'maya',
      body: 'Twenty companies in, and "AI efficiencies" is clearly doing double duty as a phrase that means "we overhired in 2023 and would rather not say so on an earnings call".',
      replies: [
        { author: 'alex', body: 'It also lands better with investors than "demand softened", which is the actual explanation most of the time.' },
        { author: 'ren', visibility: 'friends', body: 'Watching this from inside a company that just did the same thing. The tooling did not change anyone’s workload before the headcount plan did.' },
      ],
    },
  },
  {
    match: 'hacker who humiliated spyware makers', hoursAgo: 38,
    root: {
      author: 'sam',
      body: 'Never caught, never monetized, and the leaks were surgical rather than indiscriminate. Whatever else that is, it is a very unusual threat profile.',
      replies: [
        { author: 'priya', body: 'The restraint is what makes it credible. Someone in it for money would have sold the access ten times over.' },
      ],
    },
  },
  {
    match: 'boring company reportedly raising', hoursAgo: 41,
    root: {
      author: 'jordan',
      body: '$20B against what is, operationally, one loop in Vegas. The valuation is priced on the tunneling-cost thesis rather than anything currently in the ground.',
    },
  },
  {
    match: 'pixel 11 is getting a price hike', hoursAgo: 44,
    root: {
      author: 'ren',
      body: 'The Pixel’s entire pitch was flagship features at a discount. Give up the discount and it has to win on the features alone, which is a much harder fight.',
      replies: [
        { author: 'diego', body: 'Memory and modem costs are up across the board — everyone is about to make this same announcement, Google just went first.' },
      ],
    },
  },
  {
    match: 'fake bitcoin wallet in app store', hoursAgo: 47,
    root: {
      author: 'priya',
      body: '$1.8M through an app that cleared review is exactly the case that makes the walled-garden argument cut both ways. You cannot claim curation as a safety feature and then disclaim it in court.',
      replies: [
        { author: 'alex', body: 'The 30% is defended as the price of trust and safety. This is what that promise looks like when it is tested.' },
      ],
    },
  },
  {
    match: 'eu fines google $1 billion', hoursAgo: 50,
    root: {
      author: 'fatima',
      body: 'A billion is a rounding error at this point; the remedy language is the part worth reading. Fines get paid, behavioral orders get litigated for years.',
      replies: [
        {
          author: 'jordan',
          body: 'Which is why the DMA leans on structural obligations rather than penalties. Whether Brussels can enforce them is the open question.',
          replies: [
            { author: 'maya', body: 'Enforcement capacity is the whole ballgame and it is chronically underfunded relative to the legal teams on the other side.' },
          ],
        },
      ],
    },
  },
  {
    match: 'workshops for people who are fed up', hoursAgo: 53,
    root: {
      author: 'maya',
      body: 'Librarians quietly becoming the last neutral institution teaching people how their tools actually work. This is the most encouraging thing I have read this week.',
      replies: [
        { author: 'sam', body: 'They have been doing exactly this since the card catalog. The subject changes, the job does not.' },
      ],
    },
  },
  {
    match: 'growing ai data center problem', hoursAgo: 56,
    root: {
      author: 'alex',
      body: 'One line fault cascading that far means the interconnect queue is being treated as a paperwork problem rather than an engineering one. The grid was not built for loads that ramp like this.',
      replies: [
        { author: 'ren', body: 'Multi-hundred-megawatt loads that can drop to near zero in a second are genuinely new to operators. The frequency response math is not the same as a steel mill.' },
      ],
    },
  },
  {
    match: 'opus 5 is about token efficiency', hoursAgo: 59,
    root: {
      author: 'jordan',
      body: 'Efficiency gains are the least glamorous kind of progress and often the most consequential — they change what is affordable to build, not just what is possible.',
      replies: [
        { author: 'diego', body: 'Agreed, though "not a capability leap" is doing a lot of work in that headline when the benchmark deltas are non-trivial.' },
      ],
    },
  },
  {
    match: 'password during border search', hoursAgo: 62,
    root: {
      author: 'sam',
      body: 'Charging someone over a duress password effectively criminalizes a security feature that ships in mainstream software. That precedent reaches a lot further than one border stop.',
      replies: [
        { author: 'fatima', body: 'The intent question is going to be impossible to litigate cleanly. A wipe on a wrong PIN is indistinguishable from a wipe on purpose.' },
      ],
    },
  },
  {
    match: 'waymo reportedly mulling a breakup', hoursAgo: 66,
    root: {
      author: 'diego',
      body: 'Once you have the fleet and the demand model, the aggregator is just a tax. The partnership was always a bridge to owning the rider relationship.',
    },
  },
  {
    match: 'wildfire forces evacuation of nasa', hoursAgo: 70,
    root: {
      author: 'priya',
      body: 'Three DSN complexes, 120 degrees apart, and no spare capacity anywhere in the network. Every deep space mission depends on all three staying habitable.',
    },
  },
  {
    match: 'canadian legislator reads out', hoursAgo: 74,
    root: {
      author: 'ren',
      body: 'Reading the "here is a draft you might consider" preamble out loud in the chamber is the detail that makes this. Nobody even skimmed it.',
      replies: [
        { author: 'maya', body: 'The tell is always the leftover scaffolding. The actual argument underneath might have been fine.' },
      ],
    },
  },
];

const MIN = 60_000;
const HOUR = 60 * MIN;

async function ensurePersona(key: PersonaKey): Promise<string> {
  const p = PERSONAS[key];
  const existing = await prisma.user.findUnique({ where: { username: p.username }, select: { id: true } });
  if (existing) return existing.id;
  const passwordHash = await bcrypt.hash(`demo-${p.username}-${Math.random().toString(36).slice(2)}`, 10);
  const created = await prisma.user.create({
    data: { username: p.username, firstName: p.firstName, lastName: p.lastName, passwordHash },
    select: { id: true },
  });
  return created.id;
}

async function backdate(id: string, when: Date) {
  // createdAt + updatedAt together, so a freshly-created comment isn't flagged as edited.
  await prisma.$executeRaw`UPDATE "Comment" SET "createdAt" = ${when}, "updatedAt" = ${when} WHERE "id" = ${id}`;
}

function countNodes(n: Node): number {
  return 1 + (n.replies ?? []).reduce((sum, r) => sum + countNodes(r), 0);
}

async function main() {
  const targetUsername = process.argv.slice(2).find(a => !a.startsWith('--'));
  const target = targetUsername
    ? await prisma.user.findUnique({ where: { username: targetUsername }, select: { id: true, username: true } })
    : await prisma.user.findFirst({ where: { isAdmin: true }, orderBy: { createdAt: 'asc' }, select: { id: true, username: true } });
  if (!target) { console.error('No target user found (pass a username, or create an admin first).'); process.exit(1); }

  const planned = THREADS.reduce((sum, t) => sum + countNodes(t.root), 0);
  console.log(`Seeding ${planned} comments across ${THREADS.length} recent articles; friends target: @${target.username}\n`);

  const ids = {} as Record<PersonaKey, string>;
  for (const key of Object.keys(PERSONAS) as PersonaKey[]) ids[key] = await ensurePersona(key);
  const personaIds = Object.values(ids);

  // Only friendships that already exist — this script doesn't touch the graph.
  const friendships = await prisma.friendship.findMany({
    where: { status: 'accepted', OR: [{ requesterId: target.id }, { addresseeId: target.id }] },
    select: { requesterId: true, addresseeId: true },
  });
  const targetFriendIds = new Set(
    friendships.map(f => (f.requesterId === target.id ? f.addresseeId : f.requesterId))
  );

  const since = new Date(Date.now() - 7 * 24 * HOUR);
  const articles = await prisma.feedItem.findMany({
    where: { pubDate: { gte: since } },
    orderBy: { pubDate: 'desc' },
    select: { title: true, link: true, pubDate: true },
    take: 400,
  });
  const findArticle = (needle: string) =>
    articles.find(a => a.title.toLowerCase().includes(needle.toLowerCase()));

  // Resolve every thread first, so the wipe below can be scoped to exactly the
  // articles we're about to seed.
  const resolved = THREADS.map(t => ({ thread: t, article: findArticle(t.match) }));
  const keys = resolved.filter(r => r.article).map(r => canonicalArticleKey(r.article!.link));
  const removed = await prisma.comment.deleteMany({
    where: { userId: { in: personaIds }, articleKey: { in: keys } },
  });
  if (removed.count) console.log(`  (cleared ${removed.count} existing persona comments on these articles)\n`);

  const counters = { roots: 0, replies: 0, notifs: 0, skipped: 0 };

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
    if (ctx.parentId) counters.replies++; else counters.roots++;

    if (vis === 'friends' && targetFriendIds.has(ids[node.author])) {
      await prisma.notification.create({
        data: {
          userId: target!.id, type: 'friend_comment', actorId: ids[node.author],
          articleKey: ctx.key, articleUrl: ctx.url, articleTitle: ctx.title, commentId: created.id,
        },
      });
      counters.notifs++;
    }

    let childWhen = ctx.when;
    for (const child of node.replies ?? []) {
      childWhen = new Date(childWhen.getTime() + (25 + Math.floor(Math.random() * 90)) * MIN);
      await createNode(child, { ...ctx, parentId: created.id, when: childWhen });
    }
  }

  const now = Date.now();
  for (const { thread, article } of resolved) {
    if (!article) {
      console.log(`  · skipped (no recent article matching "${thread.match}")`);
      counters.skipped++;
      continue;
    }
    // Never land a comment before the article it's on was published.
    const earliest = (article.pubDate?.getTime() ?? 0) + 20 * MIN;
    const when = new Date(Math.min(now - 10 * MIN, Math.max(now - thread.hoursAgo * HOUR, earliest)));
    await createNode(thread.root, {
      key: canonicalArticleKey(article.link), url: article.link, title: article.title, parentId: null, when,
    });
    console.log(`  ✓ ${countNodes(thread.root)} on "${article.title.slice(0, 58)}"`);
  }

  console.log(
    `\nDone: ${counters.roots + counters.replies} comments ` +
    `(${counters.roots} roots, ${counters.replies} replies), ` +
    `${counters.notifs} notifications for @${target.username}` +
    (counters.skipped ? `, ${counters.skipped} threads skipped` : '') + '.'
  );
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
