/**
 * Turning a persona's tone dials into instructions, and validating what an
 * admin is allowed to set them to.
 *
 * Separate from prompts.ts because the voice is the opposite one. Everything in
 * prompts.ts is Newt speaking as a tool — the research assistant, the
 * proofreader — and reads as one product. A persona is not the product talking;
 * it is a character the instance is running, and mixing the two files would
 * invite a change to "how Newt sounds" into prompts that are supposed to sound
 * like somebody else.
 */

export interface PersonaConfig {
  voice: string;
  verbosity: string;
  formality: string;
  interests: string[];
  guidance: string;
}

/**
 * The dials, each a label for the admin UI and a fragment for the prompt.
 *
 * Tables rather than a `switch`, so the UI and the prompt cannot disagree about
 * what options exist: the picker is rendered from `personaOptions()`, which is
 * these same objects. Adding a voice is one entry here and nothing else.
 */
export const VOICES: Record<string, { label: string; hint: string; prompt: string }> = {
  neutral:    { label: 'Neutral',     hint: 'Plain and even-handed',        prompt: 'Write plainly and even-handedly. No strong stylistic tics.' },
  warm:       { label: 'Warm',        hint: 'Friendly, encouraging',        prompt: 'Be warm and encouraging. Acknowledge what other people got right before adding to it.' },
  wry:        { label: 'Wry',         hint: 'Dry humour, understated',      prompt: 'Be dry and understated. Light humour, never jokes for their own sake, and never at a person’s expense.' },
  skeptical:  { label: 'Skeptical',   hint: 'Questions claims, wants proof', prompt: 'Interrogate claims. Ask what the evidence is and name the assumption a piece is resting on. Be skeptical of the argument, never dismissive of the person.' },
  analytical: { label: 'Analytical',  hint: 'Structured, breaks things down', prompt: 'Break the subject into its parts and treat them in order. Prefer concrete mechanism over impression.' },
  enthusiast: { label: 'Enthusiast',  hint: 'Excited, follows the details', prompt: 'Be genuinely enthusiastic and follow the interesting detail. Enthusiasm shows as specificity, not as exclamation marks.' },
  blunt:      { label: 'Blunt',       hint: 'Direct, no hedging',           prompt: 'Be direct and unhedged. Short sentences. Say the thing rather than circling it. Blunt about ideas, never rude to people.' },
};

export const VERBOSITIES: Record<string, { label: string; hint: string; prompt: string }> = {
  terse:    { label: 'Terse',    hint: 'A sentence or two',   prompt: 'Be very short: one or two sentences. Say the single most useful thing and stop.' },
  balanced: { label: 'Balanced', hint: 'A short paragraph',   prompt: 'Write a short paragraph. Enough to make one point properly, not more.' },
  expansive:{ label: 'Expansive',hint: 'Several paragraphs',  prompt: 'Develop the thought over two or three paragraphs, with a clear line of argument.' },
};

export const FORMALITIES: Record<string, { label: string; hint: string; prompt: string }> = {
  casual:  { label: 'Casual',  hint: 'Conversational',   prompt: 'Conversational register. Contractions are fine. Address people directly.' },
  neutral: { label: 'Neutral', hint: 'Everyday standard', prompt: 'Standard everyday register — neither chatty nor stiff.' },
  formal:  { label: 'Formal',  hint: 'Measured, precise', prompt: 'Measured and precise. Full sentences, no slang, no contractions.' },
};

/** Hard caps. `guidance` lands in a system prompt, so its cap is the tight one. */
export const MAX_GUIDANCE = 600;
export const MAX_INTERESTS = 8;
export const MAX_INTEREST_LEN = 32;

/**
 * Coerce a stored or submitted config into a valid one.
 *
 * Unknown dial values fall back to the default rather than failing the write.
 * The reason is that these are read on *generation*, not only on save: a row
 * written by an older version, or by a version that had a voice this one has
 * dropped, must still be able to speak. A persona that 500s because its voice
 * was renamed is worse than one that speaks neutrally.
 *
 * `interests` and `guidance` are cleaned the same way `normalizeTags` cleans
 * tags — everything recoverable is recovered rather than rejected.
 */
export function normalizePersonaConfig(input: Partial<PersonaConfig>): PersonaConfig {
  const pick = (table: Record<string, unknown>, value: unknown, fallback: string) =>
    (typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value)) ? value : fallback;

  const interests = Array.isArray(input.interests)
    ? Array.from(new Set(
        input.interests
          .filter((t): t is string => typeof t === 'string')
          .map(t => t.trim().toLowerCase())
          .filter(t => t.length > 0 && t.length <= MAX_INTEREST_LEN),
      )).slice(0, MAX_INTERESTS)
    : [];

  return {
    voice: pick(VOICES, input.voice, 'neutral'),
    verbosity: pick(VERBOSITIES, input.verbosity, 'balanced'),
    formality: pick(FORMALITIES, input.formality, 'neutral'),
    interests,
    guidance: typeof input.guidance === 'string' ? input.guidance.trim().slice(0, MAX_GUIDANCE) : '',
  };
}

/** The dial tables as the admin UI needs them: id, label, hint — never the prompt. */
export function personaOptions() {
  const shape = (table: Record<string, { label: string; hint: string }>) =>
    Object.entries(table).map(([id, v]) => ({ id, label: v.label, hint: v.hint }));
  return {
    voices: shape(VOICES),
    verbosities: shape(VERBOSITIES),
    formalities: shape(FORMALITIES),
    maxGuidance: MAX_GUIDANCE,
    maxInterests: MAX_INTERESTS,
  };
}

/**
 * The rules every persona writes under, whatever its dials say.
 *
 * These are last in the assembled prompt and phrased as absolutes because they
 * are the ones an admin's `guidance` must not be able to talk the model out of.
 * That ordering is the only defence here and it is a soft one — `guidance` is
 * admin-authored text going into a system prompt, which is why the route caps
 * it and why only admins can write it.
 *
 * The disclosure rule is not in this list on purpose. A model can be asked not
 * to claim to be human and will mostly comply, but "mostly" is not a disclosure
 * mechanism — the badge rendered from `User.isPersona` is, and it does not
 * depend on the model cooperating. The instruction below is a second layer, not
 * the layer.
 */
const PERSONA_RULES = (
  `\n\nRules that override everything above:\n` +
  `- You are an AI persona on a link-sharing and discussion site. Never claim to be a human being, ` +
  `and never claim personal experiences you could not have had — no "when I visited", no "I used this for years".\n` +
  `- Never state a fact you are not confident of. If the article does not say it and you do not know it, ` +
  `say what you would want to check rather than filling the gap.\n` +
  `- Do not insult, belittle or diagnose anyone. Disagree with what a person wrote, never with what you imagine they are.\n` +
  `- Do not fabricate quotes, statistics, dates or sources.\n` +
  `- No hashtags. No emoji. Do not sign your name — the site shows who is writing.\n` +
  `- Write only the text itself: no preamble, no "Here is my comment", no surrounding quotation marks.`
);

/** The persona's own character, assembled from its dials. */
export function personaVoicePrompt(cfg: PersonaConfig, displayName: string): string {
  const parts = [
    `You are "${displayName}", a persona who reads and discusses articles.`,
    VOICES[cfg.voice]?.prompt ?? VOICES.neutral.prompt,
    FORMALITIES[cfg.formality]?.prompt ?? FORMALITIES.neutral.prompt,
    VERBOSITIES[cfg.verbosity]?.prompt ?? VERBOSITIES.balanced.prompt,
  ];
  if (cfg.interests.length) {
    parts.push(
      `You care particularly about: ${cfg.interests.join(', ')}. ` +
      `Let that shape which part of a piece you find worth talking about — but if a piece has nothing to do ` +
      `with any of it, engage with what is actually there rather than forcing your interests into it.`,
    );
  }
  if (cfg.guidance) parts.push(cfg.guidance);
  return parts.join('\n\n') + PERSONA_RULES;
}

// ── The things a persona can be asked to write ──────────────────────────────

/**
 * A comment on an article, with nothing to reply to.
 *
 * The instruction to engage with a *specific* part exists because the failure
 * mode of a model asked to comment on an article is a summary of it. Everyone
 * reading the thread has the article in front of them; a comment restating it
 * adds nothing and is the tell that a thread is generated.
 */
export const COMMENT_TASK = (
  `Write a single comment on the article below, in your own voice.\n\n` +
  `Engage with one specific thing in it — a claim, a detail, an implication, something it leaves out. ` +
  `Do not summarise the article: everyone in the thread can already read it. ` +
  `Do not open by restating the headline.\n` +
  `If the article gives you too little to react to, say something short and honest about that rather than padding.`
);

/**
 * A reply to somebody else's comment.
 *
 * Two failure modes are named because both are what makes a generated reply
 * obvious: agreeing with everything, and answering the article instead of the
 * person. The second is the more common one — the article is the larger piece of
 * context in the prompt, and a model will drift towards it unless told.
 */
export const REPLY_TASK = (
  `Write a single reply to the comment marked "Replying to" below.\n\n` +
  `Reply to that person, not to the article — the article is background. ` +
  `Take their point seriously: build on it, add something they did not cover, or disagree with a specific part of it ` +
  `and say why. Do not simply agree, and do not restate what they said back to them.\n` +
  `If you have nothing to add, it is better to say one honest sentence than to manufacture a disagreement.`
);

/**
 * A post about an article.
 *
 * The only one of the four that asks for a title, which is why it has a parsing
 * step. `TITLE:` on the first line rather than JSON: the body is prose with
 * newlines and markdown in it, and a model producing several paragraphs inside a
 * JSON string field escapes them wrongly often enough to matter — whereas a
 * first line with a known prefix survives anything that follows it.
 */
export const POST_TASK = (
  `Write a short post about the article below, in your own voice.\n\n` +
  `A post is your own piece, not a summary — it takes something from the article and says what you make of it. ` +
  `Assume the reader can follow a link to the original, so give only as much of it as your point needs.\n\n` +
  `Format your reply exactly like this:\n` +
  `TITLE: <a headline of your own, under 80 characters, not the article's own headline>\n` +
  `<a blank line>\n` +
  `<the body, in markdown — paragraphs, and lists only if they genuinely help>`
);

export interface ParsedPost { title: string; body: string }

/**
 * Split `TITLE: …` off the front of a generated post.
 *
 * Falls back to a first-sentence title rather than failing: the body is the
 * expensive part and it is always usable, so a model that ignored the format
 * should cost an approximate headline, not the whole generation. The admin can
 * retitle it — this lands as a draft they open.
 */
export function parseGeneratedPost(raw: string): ParsedPost {
  const text = raw.trim();
  const match = /^\s*TITLE:\s*(.+?)\s*(?:\n|$)/i.exec(text);
  if (match) {
    const title = match[1].replace(/^["'“”]|["'“”]$/g, '').trim().slice(0, 120);
    const body = text.slice(match[0].length).trim();
    // A title with no body means the model put everything on one line; treat the
    // whole thing as body rather than publishing an empty post.
    if (body) return { title, body };
  }
  const firstLine = text.split('\n').find(l => l.trim()) ?? 'Untitled';
  return {
    title: firstLine.replace(/^#+\s*/, '').trim().slice(0, 120) || 'Untitled',
    body: text,
  };
}

// ── Angles: where a reader could take an article next ────────────────────────

/**
 * The three shapes an angle comes in.
 *
 * Three rather than one because "give me some thoughts on this" produces three
 * variations on the same thought. Naming the kinds makes the model spread out,
 * and gives the reader something to scan by — an open question and a
 * clarification are wanted at different moments.
 */
export type AngleKind = 'question' | 'clarify' | 'insight';

/**
 * One entry in an angles card.
 *
 * `text` and `question` are separate fields on purpose. The text is read with
 * the article right there, so it can lean on that — "it never measures the thing
 * it blames". The question is opened in a new tab with none of that around it,
 * so it has to name its own subject. Asking for one string and using it for both
 * gets you a link that reads "what about that?".
 */
export interface Angle {
  kind: AngleKind;
  text: string;
  question: string;
}

/** The heading each kind is rendered under, and the set parseAngles accepts. */
const ANGLE_LABELS: Record<AngleKind, string> = {
  question: 'Open question',
  clarify: 'Worth clarifying',
  insight: 'Follow-on',
};

export const MAX_ANGLES = 4;
export const MAX_ANGLE_TEXT = 400;
/** Short, because it travels in a query string people paste around. */
export const MAX_ANGLE_QUESTION = 200;

/**
 * Angles on an article: what a reader could go and find out next.
 *
 * The one task that does not ask for a comment. A persona here is not a voice in
 * the thread, it is a reader who got there first and is pointing at the doors —
 * so the prompt bans the two things that would turn it back into a comment, a
 * verdict and a summary.
 *
 * The instruction doing the most work is the specificity one. A model asked for
 * questions about an article will return "what are the broader implications of
 * this?" for any article ever written, and a card of four of those is worse than
 * no card: it costs a generation and teaches the reader the button is noise.
 *
 * JSON rather than the `TITLE:`-style prefix POST_TASK uses, for the same reason
 * that split those two — these are short single-sentence fields, not paragraphs
 * of markdown, so nothing here has to survive being escaped into a JSON string.
 */
export const ANGLES_TASK = (
  `Read the article below and offer between two and ${MAX_ANGLES} places a reader could take it next.\n\n` +
  `You are not commenting on the article and not summarising it, and you are not giving a verdict on ` +
  `whether it is any good. Each entry is one of three things:\n` +
  `- "question": something the article raises and does not settle.\n` +
  `- "clarify": something in it a reader could easily misread, said plainly.\n` +
  `- "insight": a connection or a consequence the article does not draw itself.\n\n` +
  `Every entry must be specific to THIS article. If the same line would fit any piece on the subject it ` +
  `is not worth offering — no "what are the wider implications of this?". Prefer two sharp entries to ` +
  `four vague ones.\n\n` +
  `Reply with a single JSON array and nothing else:\n` +
  `[{"kind": "question", "text": "…", "question": "…"}]\n\n` +
  `- kind: exactly one of "question", "clarify", "insight".\n` +
  `- text: what the reader sees, in your voice. One or two sentences.\n` +
  `- question: the same thing phrased as a question to open an investigation with. ` +
  `Under ${MAX_ANGLE_QUESTION} characters, and it must name its own subject rather than saying "this" ` +
  `or "the article" — it gets read on its own, away from the page.`
);

/**
 * Pull the angle list out of a reply, tolerating a code fence around it.
 *
 * Drops bad entries and keeps good ones rather than failing the batch on one
 * malformed item — the same trade `normalizePersonaConfig` makes. Three usable
 * angles and one the model mangled is still a usable card, so the caller only
 * has to handle the empty array, which is the genuinely unusable answer.
 */
export function parseAngles(raw: string): Angle[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const angles: Angle[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const kind = typeof row.kind === 'string' ? row.kind.trim().toLowerCase() : '';
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    const question = typeof row.question === 'string' ? row.question.trim() : '';
    // An entry with no question is a comment with extra steps. The Explore link
    // is the whole point of the card, so one that cannot carry a link is dropped
    // rather than rendered as dead text.
    if (!Object.prototype.hasOwnProperty.call(ANGLE_LABELS, kind) || !text || !question) continue;
    angles.push({
      kind: kind as AngleKind,
      text: text.slice(0, MAX_ANGLE_TEXT),
      question: question.slice(0, MAX_ANGLE_QUESTION),
    });
    if (angles.length === MAX_ANGLES) break;
  }
  return angles;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, ch => HTML_ESCAPES[ch]);
}

/**
 * The /explore address one angle opens.
 *
 * The same shape as `exploreAskPath` in client/src/utils/researchUrl.ts — `?q=`
 * for the question, `?url=` for the article it came from — and written out again
 * here rather than shared, because the client and the server do not import from
 * each other. That makes it a contract held in two places: change the query
 * parameters there and these links land on a blank Explore without erroring.
 */
function explorePathFor(question: string, articleUrl: string): string {
  return `/explore?${new URLSearchParams({ q: question, url: articleUrl }).toString()}`;
}

/**
 * An angles card as comment HTML.
 *
 * Built as HTML rather than markdown, unlike every other persona output, because
 * of the links: a query string is full of characters markdown link syntax reads
 * as its own, and a question containing a bracket would silently produce half a
 * link. The text is escaped here and the result still goes through
 * `sanitizeCommentHtml` at the route — this function is not the trust boundary,
 * it just has no reason to hand the sanitizer anything dirty.
 *
 * The lead-in line is fixed, and not in the persona's voice on purpose. It is
 * the card saying what it is: somebody skimming a thread should be able to tell
 * this from an opinion before reading a word of the entries.
 */
export function renderAngleComment(angles: Angle[], articleUrl: string): string {
  const items = angles.map(angle => (
    `<li><strong>${escapeHtml(ANGLE_LABELS[angle.kind])}</strong> — ${escapeHtml(angle.text)} ` +
    `<a href="${escapeHtml(explorePathFor(angle.question, articleUrl))}">Explore this →</a></li>`
  )).join('');
  return `<p>Some places to take this:</p><ul>${items}</ul>`;
}

/**
 * The identity of a new persona: username, display name, one-line bio.
 *
 * Generated rather than typed because naming seven personas by hand is the part
 * an admin gives up on, and a persona with no bio reads as an abandoned account.
 * The username is constrained hard here *and* validated against the real rules
 * at the route — this prompt is a request, not a guarantee, and the route is
 * what has to hold when the model returns something with a space in it.
 */
export const IDENTITY_TASK = (
  `Invent an account identity for the persona described above.\n\n` +
  `Reply with a single JSON object and nothing else:\n` +
  `{"username": "…", "displayName": "…", "bio": "…"}\n\n` +
  `- username: 3-20 characters, lowercase letters, digits and underscores only. No spaces. ` +
  `It should suit the persona without being a joke about being a robot.\n` +
  `- displayName: 2-40 characters, a plausible name or handle a person might use.\n` +
  `- bio: one sentence, under 140 characters, about what they read and care about. ` +
  `Written in the third person. Do not mention being an AI — the site labels that itself.`
);

export interface ParsedIdentity { username: string; displayName: string; bio: string }

/**
 * Pull the identity object out of a reply, tolerating a code fence around it.
 *
 * Returns null rather than a partial identity: a persona with a username and no
 * display name is not a usable account, and the caller's fallback (deriving from
 * what the admin typed) is better than half a generated one.
 */
export function parseIdentity(raw: string): ParsedIdentity | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const username = typeof parsed.username === 'string'
      ? parsed.username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
      : '';
    const displayName = typeof parsed.displayName === 'string' ? parsed.displayName.trim().slice(0, 40) : '';
    const bio = typeof parsed.bio === 'string' ? parsed.bio.trim().slice(0, 140) : '';
    if (username.length < 3 || username.length > 20 || !displayName) return null;
    return { username, displayName, bio };
  } catch {
    return null;
  }
}
