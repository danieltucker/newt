/**
 * Driving an Ollama box's management API — what it has, what is loaded, and
 * pulling more.
 *
 * ── Why this is allowed to reach a private address ──
 *
 * It goes through exactly the door `POST /admin/site-models/models` already
 * uses: `resolveSafeAgent(url, privateHostPredicate())`. Nothing new is opened.
 * The operator named the host in OPERATOR_LLM_PRIVATE_HOSTS on the machine
 * itself, and that is still the only way any of this reaches a LAN address.
 *
 * ── What is genuinely new, and worth saying out loud ──
 *
 * Everything before this let an admin make the server *talk to* a private host.
 * A pull makes that host *download arbitrary content from the internet onto the
 * operator's disk*, and Ollama accepts `hf.co/...` names, so "it only pulls from
 * the registry" is not a boundary. Two things bound it: the route is admin-only
 * and audited as destructive-adjacent, and only one pull may run at a time.
 *
 * **Newt cannot check free disk before pulling, and should not pretend to.**
 * The weights land on the Ollama container's volume, on whatever host that
 * container runs on; this process has no filesystem access to it, and the
 * /api/tags size figures describe what is already there rather than what is
 * free. A 40GB pull onto a full dataset is therefore a real way to take the box
 * down, and the only defences are that a human chose the model name and that
 * the sizes are shown next to it. If this ever needs a real guard, it has to
 * come from the operator's side — a quota on the volume — not from here.
 *
 * ── Why the base URL needs adjusting ──
 *
 * SiteModel.baseUrl is an OpenAI-shaped URL, typically `http://ollama:11434/v1`.
 * None of this lives under /v1 — Ollama's own API is at the root — so the /v1
 * is stripped. That is also why `probe` exists rather than a stored "this is an
 * Ollama box" flag: SiteModel is deliberately provider-agnostic (vLLM, LM
 * Studio, Groq and OpenRouter all speak the OpenAI shape), so whether these
 * calls will work is a property of the box right now, not of the row. Computed,
 * never stored — the same reasoning `toPublicSiteModel.source` follows.
 */

import nodeFetch from 'node-fetch';
import { resolveSafeAgent } from '../isSafeUrl';
import { privateHostPredicate } from '../llm/operatorEnv';
import logger from '../logger';

const PROBE_TIMEOUT_MS = 8_000;
/** A pull is minutes. The read timeout has to survive the quiet between chunks. */
const PULL_IDLE_TIMEOUT_MS = 120_000;

/** The Ollama API root for an OpenAI-shaped base URL. */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v\d+$/, '');
}

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  /** True when this model is currently resident in VRAM (from /api/ps). */
  loaded: boolean;
}

async function agentFor(url: string) {
  const { agent } = await resolveSafeAgent(url, privateHostPredicate());
  return agent;
}

/**
 * What the box has, and what is loaded right now.
 *
 * `/api/ps` is the half worth having. The usage panel infers model swapping
 * from latency — p95 more than 4x the median — which is a *symptom*. This is
 * the cause, observed directly: if two tasks are configured on different models
 * and only one is ever resident, every alternation is an unload and a reload.
 *
 * Returns null when the endpoint is not an Ollama box, which is not an error —
 * it is the answer for a vLLM or a Groq endpoint, and the UI hides the whole
 * panel on it.
 */
export async function listModels(baseUrl: string): Promise<OllamaModel[] | null> {
  const root = ollamaRoot(baseUrl);
  try {
    const tagsUrl = `${root}/api/tags`;
    const agent = await agentFor(tagsUrl);
    if (!agent) return null;

    const res = await nodeFetch(tagsUrl, { agent, timeout: PROBE_TIMEOUT_MS } as Parameters<typeof nodeFetch>[1]);
    if (!res.ok) return null;
    const body = await res.json() as { models?: unknown };
    if (!Array.isArray(body.models)) return null;

    // Loaded set is best-effort: an older Ollama has no /api/ps, and "we could
    // not tell you what is resident" must not fail the listing that did work.
    const loaded = await loadedNames(root).catch(() => new Set<string>());

    return body.models.map(raw => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const details = (m.details ?? {}) as Record<string, unknown>;
      const name = typeof m.name === 'string' ? m.name : '';
      return {
        name,
        sizeBytes: typeof m.size === 'number' ? m.size : 0,
        parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : '',
        quantization: typeof details.quantization_level === 'string' ? details.quantization_level : '',
        loaded: loaded.has(name),
      };
    }).filter(m => m.name);
  } catch (err) {
    logger.debug({ err }, 'Ollama tags probe failed');
    return null;
  }
}

async function loadedNames(root: string): Promise<Set<string>> {
  const url = `${root}/api/ps`;
  const agent = await agentFor(url);
  if (!agent) return new Set();
  const res = await nodeFetch(url, { agent, timeout: PROBE_TIMEOUT_MS } as Parameters<typeof nodeFetch>[1]);
  if (!res.ok) return new Set();
  const body = await res.json() as { models?: { name?: unknown }[] };
  return new Set((body.models ?? []).map(m => (typeof m.name === 'string' ? m.name : '')).filter(Boolean));
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
}

/**
 * Only one pull at a time, process-wide.
 *
 * Not politeness: two concurrent multi-gigabyte downloads onto the same dataset
 * is how the disk check below gets defeated, since each one passed the check
 * before the other started writing.
 */
let activePull: { model: string; progress: PullProgress } | null = null;

export function currentPull(): { model: string; progress: PullProgress } | null {
  return activePull;
}

/**
 * Pull a model, reporting progress as it goes.
 *
 * Ollama answers with NDJSON — one JSON object per line, not SSE — so this
 * parses lines rather than reusing the `data:` framing in chat.ts. The stream
 * is long and mostly quiet, which is why the timeout is an idle one.
 */
export async function pullModel(
  baseUrl: string,
  model: string,
  onProgress: (p: PullProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (activePull) {
    return { ok: false, error: `A pull of ${activePull.model} is already running.` };
  }

  const url = `${ollamaRoot(baseUrl)}/api/pull`;
  const agent = await agentFor(url);
  if (!agent) return { ok: false, error: 'That endpoint could not be reached.' };

  activePull = { model, progress: { status: 'starting', completed: 0, total: 0 } };
  try {
    const res = await nodeFetch(url, {
      method: 'POST',
      agent,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      timeout: PULL_IDLE_TIMEOUT_MS,
    } as Parameters<typeof nodeFetch>[1]);

    if (!res.ok) {
      return { ok: false, error: `The endpoint answered ${res.status} to the pull request.` };
    }

    let pending = '';
    let lastError = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
      pending += chunk.toString('utf8');
      const cut = pending.lastIndexOf('\n');
      if (cut === -1) continue;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut + 1);

      for (const line of ready.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const frame = JSON.parse(trimmed) as Record<string, unknown>;
          // A 200 that streams an error frame: a name that does not exist comes
          // back this way rather than as an HTTP status.
          if (typeof frame.error === 'string') { lastError = frame.error; continue; }
          const progress: PullProgress = {
            status: typeof frame.status === 'string' ? frame.status : '',
            completed: typeof frame.completed === 'number' ? frame.completed : 0,
            total: typeof frame.total === 'number' ? frame.total : 0,
          };
          if (activePull) activePull.progress = progress;
          onProgress(progress);
        } catch {
          // A partial line at the end of a chunk. The buffer keeps it.
        }
      }
    }

    if (lastError) return { ok: false, error: lastError.slice(0, 300) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'The pull failed.' };
  } finally {
    activePull = null;
  }
}

/** Remove a downloaded model. Audited as destructive — only another pull undoes it. */
export async function deleteModel(baseUrl: string, model: string): Promise<{ ok: boolean; error?: string }> {
  const url = `${ollamaRoot(baseUrl)}/api/delete`;
  const agent = await agentFor(url);
  if (!agent) return { ok: false, error: 'That endpoint could not be reached.' };

  try {
    const res = await nodeFetch(url, {
      method: 'DELETE',
      agent,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      timeout: PROBE_TIMEOUT_MS,
    } as Parameters<typeof nodeFetch>[1]);
    if (!res.ok) return { ok: false, error: `The endpoint answered ${res.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'The delete failed.' };
  }
}
