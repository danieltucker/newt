/**
 * Digging a JSON value out of a reply that was asked for JSON and nothing else.
 *
 * "Reply with a single JSON object and nothing else" is a request, not a
 * guarantee, and the ways it gets ignored are consistent enough to handle:
 * a code fence, a line of preamble, a sign-off afterwards, or — on the local
 * models personas run against — a whole block of reasoning before the answer.
 *
 * Neither prompts.ts nor personaPrompts.ts is the right home for this. Those
 * two are kept apart on purpose because they are different voices, and this is
 * not a voice at all: it is a scanner. Living here is what lets both use it
 * without either importing the other's prompts.
 *
 * The scan is string- and escape-aware, which is the whole reason it exists.
 * Reaching for the last `]` in the text finds the one in "hope that helps
 * [enjoy]" and takes the reply with it; reaching for the first finds the one in
 * "here are the angles [as requested]". Balanced scanning from each candidate
 * opener finds the value however much prose surrounds it.
 */

/**
 * Reasoning blocks, removed before anything else looks at the text.
 *
 * A reasoning model on Ollama's OpenAI-compatible endpoint puts its thinking in
 * the same content stream as its answer, wrapped in <think>. The Anthropic wire
 * has a separate delta type for this and chat.ts drops it (see deltaOf); the
 * OpenAI wire does not, so it arrives here.
 *
 * The unclosed case is deliberate and not defensive padding: a model that hits
 * its token ceiling mid-thought emits an opening tag and no closing one, and
 * everything after it is thinking rather than answer. Cutting to the end is
 * right — there is no answer in a reply like that, and finding "JSON" inside
 * the reasoning would be worse than finding none.
 */
export function stripReasoning(raw: string): string {
  return raw
    .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*$/i, ' ');
}

/**
 * Every balanced, parseable JSON value in the text, in the order they start.
 *
 * A generator rather than a single answer because "the first thing that parses"
 * is not always the answer. `[1]` inside a sentence is valid JSON and would win
 * against the real array behind it, so the caller — which is the only thing that
 * knows what a usable value looks like — gets to keep reading. Callers that
 * genuinely want the first parseable value just take one.
 *
 * `opener` is '{' or '['. Both are scanned with the same walk since the only
 * difference is which bracket pairs.
 */
export function* jsonValues(raw: string, opener: '{' | '['): Generator<unknown> {
  const text = stripReasoning(raw);
  const closer = opener === '{' ? '}' : ']';

  for (let start = text.indexOf(opener); start !== -1; start = text.indexOf(opener, start + 1)) {
    const end = balancedEnd(text, start, opener, closer);
    if (end === -1) continue;
    try {
      yield JSON.parse(text.slice(start, end + 1));
    } catch {
      // Balanced but not JSON — "[as requested]" and friends. Keep looking.
    }
  }
}

/**
 * Where the value opened at `start` closes, or -1 if it never does.
 *
 * Quotes and backslash escapes are tracked so a bracket inside a string cannot
 * move the depth. Nesting counts only the outer pair's bracket type, which is
 * enough: a `[` inside an object being scanned for `}` is inside a string or
 * inside a nested value that closes before the object does either way.
 */
function balancedEnd(text: string, start: number, opener: string, closer: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
