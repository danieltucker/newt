import nodeFetch from 'node-fetch';
import type { Readable } from 'stream';
import { Provider, supportsEffort } from './providers';
import { makeSafeAgent, resolveSafeAgent } from '../isSafeUrl';
import { privateHostPredicate } from './operatorEnv';

type FetchOptions = Parameters<typeof nodeFetch>[1] & { timeout?: number };

/**
 * One way to ask any of the three providers a question.
 *
 * Everything above this file — research, proofreading, condensing a thread into
 * a post — builds a system prompt and a list of turns and calls `streamChat`.
 * Which vendor answers is a detail settled here, so adding a fourth provider is
 * an adapter and a registry entry rather than a change to every feature.
 *
 * ── Why everything streams ──
 * Even the calls whose result is used whole (proofread, condense) go through
 * the streaming transport. Not for the UI — for the proxy. nginx sits in front
 * of the server with `proxy_read_timeout 60s`, and a reasoning model asked a
 * real research question routinely takes longer than that to produce its first
 * byte of a non-streamed response. Streaming makes the first token arrive in a
 * second or two and resets that timer continuously, which turns a hard 504 into
 * a slow answer. See client/nginx.conf, which also has to turn buffering off
 * for the same reason.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * What one call actually consumed.
 *
 * Reported so a reader can see the price of a question at the moment they ask
 * it, rather than finding out at the end of the month. `cacheRead` is broken
 * out from `input` because it is billed at roughly a tenth of the rate, and on
 * a long thread it is most of the input — a total that lumped them together
 * would overstate the cost several times over.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface ChatRequest {
  provider: Provider;
  /** Decrypted. Never logged, never returned, never stored by this module. */
  apiKey: string;
  /** Only used when provider.needsBaseUrl. */
  baseUrl: string;
  model: string;
  system: string;
  turns: ChatTurn[];
  maxTokens: number;
  /**
   * How hard to think. Sent only on the Anthropic wire, which is the only one
   * of the two that has the knob; the OpenAI-shaped endpoints get the same
   * intent through `maxTokens` and the prompt instead. See depth.ts.
   */
  effort?: 'low' | 'medium' | 'high';
  /**
   * Ask for the system prompt and the opening turn to be cached.
   *
   * Set on multi-turn conversations, which is where it pays: a research thread
   * re-sends its system prompt, the article and the feed context on *every*
   * follow-up, and without this the reader pays full input price for the same
   * tokens each time. Cache reads are about a tenth of that. Left off for
   * one-shot calls, where there is never a second request to read the cache.
   */
  cache?: boolean;
  /** Called once with the token counts the provider reported, if it reported any. */
  onUsage?: (usage: Usage) => void;
  /** Aborts the upstream request when the client hangs up. */
  signal?: AbortSignal;
  /**
   * Ask for the operator's private-host allowlist to be consulted.
   *
   * Setting this is a *request*, not a grant, and it grants far less than its
   * name suggests. It does not skip the address check — it only allows a private
   * address to pass **if the operator named that host in
   * OPERATOR_LLM_PRIVATE_HOSTS**, which requires shell access to the machine.
   * With an empty allowlist this flag changes nothing whatsoever, so a route
   * that set it by mistake while carrying a user's URL gains nothing.
   *
   * A host that is approved is still connected to over a **pinned** agent, at
   * the exact address that was validated. See resolveSafeAgent.
   *
   * Set in exactly one place: resolveSiteModel in lib/llm/siteModels.ts.
   * Nothing may ever set this from a request body.
   */
  trusted?: boolean;
}

export class LlmError extends Error {
  /** What to put on the wire. Deliberately not the upstream body — see below. */
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** How long we wait for the *first* byte. After that the stream is its own clock. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Hard ceiling on a single answer, whatever the model is doing. */
const TOTAL_TIMEOUT_MS = 10 * 60_000;

/**
 * Resolve the endpoint, refusing anything that isn't a public host.
 *
 * The self-hosted case is the one this constrains: an Ollama box on
 * 192.168.1.50 is exactly the shape of a request that turns a server into a
 * probe for its own network, and Newt accepts sign-ups. So `compatible`
 * endpoints must be publicly resolvable — expose the box through a tunnel or a
 * reverse proxy with TLS. makeSafeAgent also pins the connection to the address
 * it validated, so a hostname that answers publicly on one lookup and privately
 * on the next cannot slip through.
 *
 * The two first-party providers go through the same check. It costs one cached
 * DNS lookup and means there is no second, unchecked path out of this module.
 */
type ResolvedTarget = {
  url: string;
  /** Always pinned to the address that was validated — allowlisted or not. */
  agent: NonNullable<Awaited<ReturnType<typeof makeSafeAgent>>>;
};

// Exported for its test, on the same reasoning as buildBody below: this function
// decides whether a request may reach a private address, and there is no way to
// assert on that decision from outside without standing up a fake network.
export async function resolveTarget(req: ChatRequest): Promise<ResolvedTarget> {
  const base = (req.provider.needsBaseUrl ? req.baseUrl : req.provider.baseUrl).trim().replace(/\/+$/, '');
  if (!base) throw new LlmError('This provider needs a base URL', 400);

  const path = req.provider.wire === 'anthropic'
    ? '/v1/messages'
    // A user pasting an OpenAI-compatible base URL may or may not include the
    // /v1 — Ollama's docs say http://host:11434/v1, OpenWebUI's say /api. Accept
    // either rather than making them guess which half we want.
    : (/\/v\d+$/.test(base) ? '/chat/completions' : '/v1/chat/completions');

  const url = `${base}${path}`;

  // The site model is the one call allowed to reach a private address, and only
  // to a host the operator named in the environment. Everything else — every
  // credential a user added — passes `undefined` here and takes the same path it
  // always did. An empty allowlist yields `undefined` too, so an instance that
  // has configured nothing behaves exactly as it did before this existed.
  const allowPrivate = req.trusted ? privateHostPredicate() : undefined;

  const { agent, reason } = await resolveSafeAgent(url, allowPrivate);
  if (!agent) {
    throw new LlmError(
      req.trusted
        // An admin sees this one, and the fix is on the host, so name the
        // variable rather than repeating the generic advice below.
        ? `That endpoint could not be reached: ${reason}. ` +
          'A private address must have its host listed in OPERATOR_LLM_PRIVATE_HOSTS on the server.'
        : 'That endpoint could not be reached, or resolves to a private address. ' +
          'Self-hosted models must be published at a public HTTPS address.',
      400,
    );
  }
  return { url, agent };
}

/**
 * The headers and JSON body for one call, in whichever dialect the provider
 * speaks. Exported for its test: what goes on the wire is exactly the thing
 * that has been wrong here, and there is no way to assert on it from outside
 * without standing up a fake provider.
 */
export function buildBody(req: ChatRequest): { headers: Record<string, string>; body: string } {
  if (req.provider.wire === 'anthropic') {
    // Caching is a *prefix* match, so the two breakpoints go at the two places
    // the prefix stops being stable: the end of the system prompt, and the end
    // of the opening turn (which carries the article and the feed context).
    // Everything after them — the follow-up questions — differs every time and
    // is not worth a breakpoint.
    const system = req.cache
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;

    const messages = req.turns.map((t, i) => (
      req.cache && i === 0
        ? { role: t.role, content: [{ type: 'text', text: t.content, cache_control: { type: 'ephemeral' } }] }
        : { role: t.role, content: t.content }
    ));

    return {
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        // `system` is a top-level field on the Messages API, not a turn.
        system,
        messages,
        stream: true,
        // Effort is the cost dial. Nested inside output_config, not top-level.
        //
        // Sent only for a model that is known to take it. Catalogue membership
        // used to be the test, on the theory that the only models which would
        // choke were ones Newt had never heard of — but that was wrong in the
        // one case that mattered most: Haiku 4.5 is in the catalogue, predates
        // the effort parameter, and 400s on it. It is also the utility model, so
        // *every* Claude user's proofread ran into it however they had the rest
        // of their account set up. See supportsEffort.
        ...(req.effort && supportsEffort(req.provider, req.model)
          ? { output_config: { effort: req.effort } }
          : {}),
        // No `temperature` here on purpose: the current Claude models reject
        // sampling parameters outright, and older ones do not need one for this.
        // `thinking` is likewise left alone rather than disabled — the current
        // models reason by default, effort above is the supported way to spend
        // less on it, and max_tokens covers thinking and answer together.
      }),
    };
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // A local Ollama has no auth at all, so an empty key means send no header
  // rather than send `Bearer ` and get a 401 that reads like a bad key.
  if (req.apiKey) headers['authorization'] = `Bearer ${req.apiKey}`;

  return {
    headers,
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      messages: [{ role: 'system', content: req.system }, ...req.turns],
      stream: true,
      // Ask for the token counts on the final chunk. OpenAI honours this;
      // endpoints that don't simply ignore an unknown field, and the caller
      // treats missing usage as unknown rather than as zero.
      stream_options: { include_usage: true },
    }),
  };
}

/**
 * Pull token counts out of a frame, in either dialect.
 *
 * Both providers report usage more than once per stream — Anthropic splits it
 * across `message_start` (input, cache) and `message_delta` (output), OpenAI
 * sends one object at the end — so this merges rather than replaces, and only
 * over fields that are actually present.
 */
function readUsage(frame: Record<string, unknown>, wire: 'anthropic' | 'openai', into: Usage): boolean {
  const raw = wire === 'anthropic'
    ? ((frame.message as Record<string, unknown> | undefined)?.usage ?? frame.usage) as Record<string, unknown> | undefined
    : frame.usage as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return false;

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  if (wire === 'anthropic') {
    if (raw.input_tokens !== undefined) into.input = num(raw.input_tokens);
    if (raw.output_tokens !== undefined) into.output = num(raw.output_tokens);
    if (raw.cache_read_input_tokens !== undefined) into.cacheRead = num(raw.cache_read_input_tokens);
    if (raw.cache_creation_input_tokens !== undefined) into.cacheWrite = num(raw.cache_creation_input_tokens);
  } else {
    if (raw.prompt_tokens !== undefined) into.input = num(raw.prompt_tokens);
    if (raw.completion_tokens !== undefined) into.output = num(raw.completion_tokens);
    // OpenAI reports its own cached-prefix count in a nested object.
    const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
    if (details?.cached_tokens !== undefined) {
      into.cacheRead = num(details.cached_tokens);
      // Cached tokens are counted inside prompt_tokens, unlike Anthropic where
      // the two are disjoint. Subtract so the totals mean the same thing in
      // both dialects and the cost sum below doesn't double-count.
      into.input = Math.max(0, into.input - into.cacheRead);
    }
  }
  return true;
}

/**
 * Pull `data:` payloads out of an SSE byte stream.
 *
 * Hand-rolled rather than pulled in as a dependency because the subset in play
 * is small and fixed: both providers send `data: <json>` lines separated by
 * blank lines, and OpenAI terminates with the literal `data: [DONE]`. Event
 * names are ignored — the JSON says what each frame is.
 */
function* framesOf(buffer: string): Generator<string> {
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    yield payload;
  }
}

/** The text delta in one frame, for whichever wire format produced it. */
function deltaOf(frame: Record<string, unknown>, wire: 'anthropic' | 'openai'): string {
  if (wire === 'anthropic') {
    // content_block_delta carries the text. Thinking deltas are a different
    // delta type and are deliberately dropped: Newt shows answers, not reasoning.
    if (frame.type !== 'content_block_delta') return '';
    const delta = frame.delta as Record<string, unknown> | undefined;
    return delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : '';
  }
  const choices = frame.choices as Array<Record<string, unknown>> | undefined;
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
  return typeof delta?.content === 'string' ? delta.content : '';
}

/**
 * The error a *frame* can carry. Both formats can start a 200 response and then
 * fail partway — an overloaded model, a mid-stream policy stop — so a clean
 * HTTP status is not on its own proof the answer arrived.
 */
function frameError(frame: Record<string, unknown>): string | null {
  const err = frame.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === 'string') return err.message;
  return null;
}

/**
 * Map an upstream failure onto something safe to show a user.
 *
 * The upstream body is *not* passed through. A provider's 401 body can echo the
 * request, and this request contains the user's key — relaying it verbatim
 * would put the key in a browser devtools pane, in any error reporting the
 * client does, and in the user's clipboard when they paste "the error". The
 * status is enough to say the useful thing.
 */
function messageForStatus(status: number, providerLabel: string): string {
  if (status === 401 || status === 403) return `${providerLabel} rejected that API key. Check it in Settings → AI.`;
  if (status === 404) return `${providerLabel} doesn’t recognise that model id.`;
  if (status === 429) return `${providerLabel} is rate-limiting this key. Try again shortly.`;
  // Not "unknown model id" — that is the 404 above, and saying it here sends the
  // reader off checking a setting that was never wrong. A 400 means the model
  // would not take the request as sent: a parameter it doesn't support, or more
  // text than its context holds.
  if (status === 400) return `${providerLabel} refused the request. The model may not support something Newt sent, or the text may be longer than it can read.`;
  if (status >= 500) return `${providerLabel} is having trouble right now. Try again shortly.`;
  return `${providerLabel} returned an unexpected error (${status}).`;
}

/**
 * Ask the model, handing back text as it arrives.
 *
 * `onDelta` is called with each chunk; the whole answer is also returned, so a
 * caller that only wants the final text can pass a no-op and ignore streaming
 * entirely (see `completeChat`).
 */
export async function streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string> {
  const { url, agent } = await resolveTarget(req);
  const { headers, body } = buildBody(req);

  let res;
  try {
    res = await nodeFetch(url, {
      method: 'POST',
      agent,
      headers,
      body,
      timeout: CONNECT_TIMEOUT_MS,
      signal: req.signal,
    } as FetchOptions);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return '';
    throw new LlmError(`Could not reach ${req.provider.label}.`, 502);
  }

  if (!res.ok) {
    // Drain rather than leak the socket, but never read the body into the error.
    try { (res.body as unknown as Readable)?.destroy(); } catch { /* already gone */ }
    throw new LlmError(messageForStatus(res.status, req.provider.label), res.status === 401 || res.status === 403 ? 400 : 502);
  }

  return await new Promise<string>((resolve, reject) => {
    const stream = res.body as unknown as Readable;
    let pending = '';
    let full = '';
    let settled = false;
    const usage: Usage = { ...EMPTY_USAGE };
    let sawUsage = false;

    const total = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      // Not an error: a very long answer that hits the ceiling is still an
      // answer, and throwing away what arrived would be the worse outcome.
      resolve(full);
    }, TOTAL_TIMEOUT_MS);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      stream.destroy();
      // Reported even on a truncated or aborted stream: those tokens were
      // still generated and are still billed, and a cost readout that only
      // appears on the happy path is the one that misleads.
      if (sawUsage) req.onUsage?.(usage);
      fn();
    };

    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      pending += chunk.toString('utf8');
      // Keep the trailing partial line in the buffer — a chunk boundary lands
      // mid-JSON often enough that parsing what's there would drop tokens.
      const cut = pending.lastIndexOf('\n');
      if (cut === -1) return;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut + 1);

      for (const payload of framesOf(ready)) {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(payload); } catch { continue; }

        const err = frameError(frame);
        if (err) {
          done(() => reject(new LlmError(`${req.provider.label} stopped partway: ${err}`, 502)));
          return;
        }

        if (readUsage(frame, req.provider.wire, usage)) sawUsage = true;

        const text = deltaOf(frame, req.provider.wire);
        if (text) { full += text; onDelta(text); }
      }
    });

    stream.on('end', () => done(() => resolve(full)));
    stream.on('error', (err) => done(() => {
      if ((err as Error).name === 'AbortError') { resolve(full); return; }
      reject(new LlmError(`The connection to ${req.provider.label} dropped.`, 502));
    }));

    req.signal?.addEventListener('abort', () => done(() => resolve(full)), { once: true });
  });
}

/** For the callers that want the answer whole. Same transport — see the note above. */
export async function completeChat(req: ChatRequest): Promise<string> {
  return streamChat(req, () => {});
}

/**
 * What an OpenAI-compatible endpoint says it serves, via GET /v1/models.
 *
 * Goes through the same makeSafeAgent check as everything else in this module,
 * so the "public hosts only" rule holds for discovery too — otherwise this
 * would be a hole straight through it, and a more convenient one to abuse than
 * the chat route since it needs no key.
 */
export async function listRemoteModels(provider: Provider, baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;

  const agent = await makeSafeAgent(url);
  if (!agent) {
    throw new LlmError(
      'That endpoint could not be reached, or resolves to a private address. ' +
      'Self-hosted models must be published at a public HTTPS address.',
      400,
    );
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  let res;
  try {
    res = await nodeFetch(url, { agent, headers, timeout: 10_000 } as FetchOptions);
  } catch {
    throw new LlmError(`Could not reach ${baseUrl}.`, 502);
  }
  if (!res.ok) {
    throw new LlmError(messageForStatus(res.status, provider.label), res.status === 401 ? 400 : 502);
  }

  let payload: unknown;
  try { payload = await res.json(); } catch {
    throw new LlmError('That endpoint answered, but not with a model list.', 502);
  }

  // The OpenAI shape is {data: [{id}]}. Some servers return a bare array, which
  // is close enough to be worth accepting rather than rejecting on a technicality.
  const list = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown }).data;
  if (!Array.isArray(list)) throw new LlmError('That endpoint answered, but not with a model list.', 502);

  return list
    .map(item => (typeof item === 'string' ? item : (item as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 120)
    .slice(0, 200)
    .sort();
}
