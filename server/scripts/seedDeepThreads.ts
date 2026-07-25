// Seeds a few deliberately deep, branching comment trees onto recent articles so
// you can see what a complex thread looks like — long reply spines (12–16 deep)
// with side-branches forking off intermediate nodes. Uses eight persona voices
// so a busy thread reads like a real argument.
//
//   npm run seed-deep-threads                 # target the first admin (for authorship only)
//   npm run seed-deep-threads -- <username>
//
// Re-runnable: wipes only these personas' comments on the chosen articles first.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma';
import { canonicalArticleKey, sanitizeCommentHtml } from '../src/lib/comments';

type PersonaKey = 'alex' | 'jordan' | 'sam' | 'priya' | 'maya' | 'diego' | 'ren' | 'fatima';

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

interface Node { author: PersonaKey; body: string; replies?: Node[] }
interface Thread { match: string; root: Node }

// A linear reply chain from a flat list: each entry replies to the one before it.
function line(items: [PersonaKey, string][]): Node {
  let head: Node | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    head = { author: items[i][0], body: items[i][1], replies: head ? [head] : undefined };
  }
  return head!;
}

// A conversation "spine": each step replies to the previous, and `also` hangs
// extra reply subtrees (branches) off that step.
function spine(steps: { a: PersonaKey; b: string; also?: Node[] }[]): Node {
  const [h, ...rest] = steps;
  const replies: Node[] = [];
  if (rest.length) replies.push(spine(rest));
  if (h.also) replies.push(...h.also);
  return { author: h.a, body: h.b, replies: replies.length ? replies : undefined };
}

const THREADS: Thread[] = [
  // ── 1. A very deep two-sided debate with three branch points ──────────────
  {
    match: 'duress',
    root: spine([
      { a: 'maya', b: "A “duress password” that wipes the device is just deniable encryption with extra steps. The moment its existence is provable, the deniability is gone — which is exactly what's being charged here." },
      { a: 'diego', b: "The charge isn't “you had a duress password,” it's “you destroyed evidence.” The prosecution still has to prove intent to obstruct, and “I panicked at the border” is a real defense." },
      { a: 'maya', b: "Intent is trivial to infer if the wipe was triggered by a special password. You don't accidentally type your duress code." },
      { a: 'diego', b: "Unless the whole point is you use it under coercion. The feature exists so you can comply with a demand to unlock while protecting the data. Compliance-with-a-twist isn't obviously obstruction.",
        also: [
          line([
            ['ren',   "The wrinkle is that at the border the Fourth Amendment is basically suspended for “routine” searches — so this isn't about search legality, it's about whether wiping mid-search is a new affirmative act."],
            ['priya', "Worth noting Riley was about search incident to arrest, not the border. Courts have been very reluctant to extend it to CBP."],
            ['fatima',"Reluctant, but not uniformly — the Ninth Circuit's device reasoning is exactly the Riley logic applied to the border."],
            ['ren',   "And the Supreme Court has dodged every cert petition that would resolve it, which tells you they like the ambiguity."],
          ]),
        ] },
      { a: 'maya', b: "Either way there's a difference between refusing to unlock (arguably protected) and actively destroying data during a lawful process. The second one is a fresh act." },
      { a: 'fatima', b: "Is a border phone search even “routine,” though? Riley said phones are different, and there's a live circuit split on whether device searches at the border need reasonable suspicion." },
      { a: 'ren', b: "Circuit split, sure — but this person is charged in a circuit that leans government-friendly on the question. Venue matters more than principle here." },
      { a: 'fatima', b: "Which is the depressing part: your rights at the border are basically a function of which airport you land at." },
      { a: 'alex', b: "Practically, if you're carrying data you can't afford to have searched, the answer was never a duress password — it's don't carry it across the border at all. Travel clean, restore afterward.",
        also: [
          {
            author: 'maya',
            body: "“Travel clean” is fine advice for a journalist with a threat model. It's useless for a normal person who just has their whole life on their phone.",
            replies: [
              { author: 'sam',   body: "Normal people aren't the ones getting the duress-password treatment, though." },
              { author: 'diego', body: "That's survivorship bias — we only hear about the cases that get charged." },
            ],
          },
        ] },
      { a: 'jordan', b: "Cloud restore has the same problem one hop removed — they can compel the account, or just wait for you to log in on a monitored network." },
      { a: 'alex', b: "Compelling a cloud account across a border is a much higher legal bar than thumbing through a phone that's in your hand. The friction is the protection." },
      { a: 'jordan', b: "Until the friction is a 30-day device detention and you miss your connection, your meetings, and your job. “Just travel clean” assumes you can afford the operational cost." },
      { a: 'sam', b: "This is the whole opsec-vs-usability tension in one story. The technically correct answer and the humanly practical answer are miles apart, and the law is written for neither.",
        also: [
          line([
            ['ren',    "The uncomfortable truth is that the most secure move is also the most suspicious one. Encryption that actually works makes you look guilty."],
            ['alex',   "Normalization is the only fix. When everyone's phone wipes under duress, doing it stops being evidence of anything."],
            ['jordan', "Everyone's phone won't, because the platform vendors don't want to ship an obstruction-of-justice feature by default."],
          ]),
        ] },
      { a: 'maya', b: "And the duress password is the worst of both worlds: operationally clever enough to look premeditated, but not clever enough to protect you from a determined adversary." },
      { a: 'diego', b: "Premeditation is the trap. The feature meant to give you deniability is the exact thing that proves you had something to hide. Security theater cuts both ways." },
    ]),
  },

  // ── 2. A wide + deep thread: root with four developing branches ───────────
  {
    match: 'why cognition bought poke',
    root: {
      author: 'alex',
      body: "Buying a “personality” is an admission that the model layer is commoditized. When capability converges, vibes are the differentiator — a wild thing to build a moat on.",
      replies: [
        spine([
          { a: 'jordan', b: "Personality-as-moat isn't crazy — it's basically brand. People stayed with one search engine for 20 years out of habit and feel, not because it was measurably best." },
          { a: 'sam',    b: "Brand needs consistency, though. An AI personality drifts every model update — you're building a brand on quicksand." },
          { a: 'jordan', b: "Which is exactly why you'd acquire a team that's good at pinning personality across versions. That's the actual asset." },
          { a: 'maya',   b: "Is it a team asset or a data asset? Poke's value might be the conversation logs that define the persona, not the people." },
          { a: 'diego',  b: "Both — but the logs are the part you can't rebuild. That's what you're really paying for." },
        ]),
        spine([
          { a: 'priya',  b: "Counterpoint: personality is a liability at scale. The more character it has, the more ways it can offend, and the more brittle it is across cultures." },
          { a: 'ren',    b: "Localization of personality is unsolved. A persona that charms in California reads as fake or rude somewhere else." },
          { a: 'priya',  b: "And you can't A/B test your way out of it fast enough before it becomes a PR incident." },
          { a: 'fatima', b: "Which is why the safe personas all converge on the same bland helpful-assistant voice. Differentiation and safety pull in opposite directions." },
        ]),
        spine([
          { a: 'maya',  b: "The real tell is that a coding-agent company bought a consumer-personality app. That's not a feature buy, it's a distribution/audience buy." },
          { a: 'alex',  b: "Agreed — the acquihire framing undersells it. They bought a user base and a habit." },
          { a: 'diego', b: "Habits are the only durable moat left when the models are all rentable by the token." },
        ]),
        spine([
          { a: 'sam',    b: "Everyone says “personality is the moat” right up until a competitor ships the same personality for free. It's a moat made of prompts." },
          { a: 'jordan', b: "Prompts, plus the fine-tune, plus the eval harness that keeps it in character. That combination is harder to copy than a system prompt." },
          { a: 'sam',    b: "Harder, not hard. Six months, tops." },
        ]),
      ],
    },
  },

  // ── 3. A medium-deep policy debate with two branches ──────────────────────
  {
    match: 'open-weight',
    root: spine([
      { a: 'diego',  b: "Restricting open-weight releases to “contain” Chinese AI is closing the barn door after the horse trained itself. The weights that matter are already mirrored globally." },
      { a: 'fatima', b: "The goal isn't really containment, it's liability — giving the government a lever to pull later. Whether it works is almost beside the point." },
      { a: 'diego',  b: "A lever that only binds domestic labs, you mean. Export controls on math don't bind the people you're worried about." },
      { a: 'ren',    b: "They bind compute, not math, and compute is the actual chokepoint. Open weights are downstream of who can afford to train them.",
        also: [
          line([
            ['priya', "Compute chokepoint assumes the fabs stay where they are. A decade of onshoring policy is a bet against exactly that assumption."],
            ['ren',   "Fabs are the slowest thing in tech to move. That's a very long payoff horizon for that bet."],
          ]),
        ] },
      { a: 'diego',  b: "For now. Distillation keeps eating the capability gap — you don't need the frontier cluster to get 90% of the value anymore." },
      { a: 'maya',   b: "Which is the argument against restrictions, ironically. If small models keep catching up, you're regulating the thing that's becoming irrelevant." },
      { a: 'alex',   b: "The thing that isn't irrelevant being data and deployment, not weights. Everyone's fighting the last war over model access." },
      { a: 'jordan', b: "Regulators regulate what they can see. Weights are legible; data pipelines and deployment aren't. So we get the policy that's easy to write, not the one that helps.",
        also: [
          line([
            ['fatima', "“Legible to regulators” is the most underrated force in tech policy — it explains most of why rules land where they do."],
            ['diego',  "It's why privacy law targets cookies and not the actual data brokers. The visible thing gets the rule."],
          ]),
        ] },
      { a: 'sam',    b: "And the labs urging “don't restrict open weights” are the same ones who'll happily accept restrictions that raise the barrier for smaller competitors. Follow the incentives." },
    ]),
  },
];

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

function maxDepth(node: Node): number {
  if (!node.replies || node.replies.length === 0) return 1;
  return 1 + Math.max(...node.replies.map(maxDepth));
}
function countNodes(node: Node): number {
  return 1 + (node.replies ?? []).reduce((n, r) => n + countNodes(r), 0);
}

async function main() {
  const targetUsername = process.argv.slice(2).find(a => !a.startsWith('--'));
  console.log('Seeding deep comment threads…\n');

  const ids = {} as Record<PersonaKey, string>;
  for (const key of Object.keys(PERSONAS) as PersonaKey[]) ids[key] = await ensurePersona(key);
  const personaIds = Object.values(ids);

  const now = Date.now();
  let clock = now - THREADS.length * 8 * 60 * MIN; // start a couple of days back

  // Recursively create a node and its subtree, timestamps increasing in pre-order
  async function create(node: Node, ctx: { key: string; url: string; title: string; parentId: string | null }): Promise<void> {
    const when = new Date(clock);
    clock += 7 * MIN;
    const created = await prisma.comment.create({
      data: {
        userId: ids[node.author], articleKey: ctx.key, articleUrl: ctx.url, articleTitle: ctx.title,
        parentId: ctx.parentId, title: null, body: sanitizeCommentHtml(`<p>${node.body}</p>`), visibility: 'public',
      },
      select: { id: true },
    });
    await prisma.$executeRaw`UPDATE "Comment" SET "createdAt" = ${when}, "updatedAt" = ${when} WHERE "id" = ${created.id}`;
    for (const child of node.replies ?? []) {
      await create(child, { ...ctx, parentId: created.id });
    }
  }

  const articles = await prisma.feedItem.findMany({
    orderBy: { pubDate: 'desc' }, take: 60, select: { title: true, link: true },
  });
  const findArticle = (needle: string) =>
    articles.find(a => a.title.toLowerCase().includes(needle.toLowerCase()));

  for (const t of THREADS) {
    const article = findArticle(t.match);
    if (!article) { console.log(`  · skipped (no current article for "${t.match}")`); continue; }
    const key = canonicalArticleKey(article.link);
    // Wipe only these personas' comments on this article, so re-runs are clean
    await prisma.comment.deleteMany({ where: { articleKey: key, userId: { in: personaIds } } });
    await create(t.root, { key, url: article.link, title: article.title, parentId: null });
    console.log(`  ✓ "${article.title.slice(0, 50)}" — ${countNodes(t.root)} comments, ${maxDepth(t.root)} levels deep`);
  }

  console.log('\nDone.');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
