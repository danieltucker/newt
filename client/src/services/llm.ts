import { apiFetch, apiGet, apiPost, apiPatch, apiDelete, apiErrorText } from './api';
import { CommentVisibility } from '../types';

/**
 * The client half of the AI features: types, plain calls, and the one thing
 * api.ts can't express — a streamed answer.
 */

export type ProviderId = 'anthropic' | 'openai' | 'compatible';

export type Tier = 'economy' | 'balanced' | 'premium';

export interface ModelOption {
  id: string;
  label: string;
  tier: Tier;
  /** Indicative US dollars per million tokens. See the server's providers.ts. */
  inputPer1M: number;
  outputPer1M: number;
  blurb: string;
  utility?: boolean;
}

export interface Provider {
  id: ProviderId;
  label: string;
  needsBaseUrl: boolean;
  needsKey: boolean;
  models: ModelOption[];
  defaultModel: string;
  docsUrl: string;
  /** The vendor's own price list, which is authoritative over the numbers above. */
  pricingUrl: string;
  blurb: string;
  /** Whether Newt can ask the endpoint what it serves. True for self-hosted only. */
  canListModels: boolean;
}

export type Depth = 'brief' | 'balanced' | 'thorough';

/** An article from the reader's own feed that was consulted for an answer. */
export interface ResearchSource {
  title: string;
  url: string;
  source: string;
  pubDate: string | null;
}

export interface Credential {
  id: string;
  provider: ProviderId;
  label: string;
  /** The only part of the key the server will ever send. Often ''. */
  keyLast4: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  createdAt: string;
}

export interface ResearchThread {
  id: string;
  title: string;
  sourceUrl: string;
  sourceTitle: string;
  /**
   * 'private' | 'friends' | 'public' - the same three tiers as comments and
   * posts. Private is the default and where every thread starts; a thread only
   * leaves it when its author deliberately shares it, having been shown what
   * the transcript contains.
   */
  visibility: CommentVisibility;
  /** When it first left private, or null. */
  sharedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchMessage {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  suggestions: string[];
  /**
   * The feed articles this answer was given, kept with it. Always empty on a
   * user turn, and on any assistant turn written before v1.17.0.
   */
  sources: ResearchSource[];
  createdAt: string;
}

export type ProofreadKind = 'spelling' | 'grammar' | 'clarity' | 'consistency' | 'style';

export interface ProofreadIssue {
  kind: ProofreadKind;
  quote: string;
  suggestion: string;
}

export interface ProofreadReport {
  summary: string;
  readability: string;
  issues: ProofreadIssue[];
}

// ── Credentials ─────────────────────────────────────────────────────────────

export const listProviders = () => apiGet<{ providers: Provider[] }>('/api/v1/llm/providers');
export const listCredentials = () => apiGet<{ credentials: Credential[] }>('/api/v1/llm/credentials');

export interface CredentialInput {
  provider: ProviderId;
  label?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  isDefault?: boolean;
}

export const createCredential = (body: CredentialInput) =>
  apiPost<Credential>('/api/v1/llm/credentials', body);

export const updateCredential = (id: string, body: Partial<CredentialInput>) =>
  apiPatch<Credential>(`/api/v1/llm/credentials/${id}`, body);

export const deleteCredential = (id: string) =>
  apiDelete<{ ok: true }>(`/api/v1/llm/credentials/${id}`);

export const testCredential = (id: string) =>
  apiPost<{ ok: true; reply: string }>(`/api/v1/llm/credentials/${id}/test`, {});

// ── Research ────────────────────────────────────────────────────────────────

export const listThreads = () => apiGet<{ threads: ResearchThread[] }>('/api/v1/research/threads');

export const getThread = (id: string) =>
  apiGet<{ thread: ResearchThread; messages: ResearchMessage[] }>(`/api/v1/research/threads/${id}`);

export const startThread = (question: string, url?: string, refs: string[] = []) =>
  apiPost<{ thread: ResearchThread; messages: ResearchMessage[] }>(
    '/api/v1/research/threads', { question, url, refs },
  );

export const renameThread = (id: string, title: string) =>
  apiPatch<ResearchThread>(`/api/v1/research/threads/${id}`, { title });

/**
 * Move a thread between the three tiers. Widening one publishes the whole
 * transcript, which can quote the reader's own private notes back at them - so
 * the caller is expected to have shown them what is in it first.
 */
export const setThreadVisibility = (id: string, visibility: CommentVisibility) =>
  apiPatch<ResearchThread>(`/api/v1/research/threads/${id}`, { visibility });

/** One shared thread, read through the public endpoint. */
export const getSharedExplore = (id: string) =>
  apiGet<{ thread: SharedExplore; messages: SharedExploreMessage[] }>(`/api/v1/explores/${id}`);

export interface SharedExplore {
  id: string;
  title: string;
  sourceUrl: string;
  sourceTitle: string;
  visibility: CommentVisibility;
  sharedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: { id: string; username: string; displayName: string; avatar: string | null } | null;
  own: boolean;
}

export interface SharedExploreMessage {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  createdAt: string;
}

/**
 * What has been shared about an article: explores whose authors published them,
 * and posts written about it. One list, because to a reader they are the same
 * thing - somebody took this further and left a record of it.
 */
export interface ExploredPath {
  kind: 'explore' | 'post';
  id: string;
  title: string;
  href: string;
  snippet: string;
  visibility: CommentVisibility;
  author: { id: string; username: string; displayName: string; avatar: string | null } | null;
  own: boolean;
  /** Exchanges in the conversation. Explores only; null for a post. */
  turns: number | null;
  at: string | null;
}

export const getExploredPaths = (url: string) =>
  apiGet<{ paths: ExploredPath[] }>(`/api/v1/articles/paths?url=${encodeURIComponent(url)}`);

export const deleteThread = (id: string) =>
  apiDelete<{ ok: true }>(`/api/v1/research/threads/${id}`);

export const condenseThread = (id: string) =>
  apiPost<{ post: { id: string; title: string; slug: string } }>(
    `/api/v1/research/threads/${id}/condense`, {},
  );

/**
 * What models an endpoint serves.
 *
 * Answers from the catalogue for the hosted providers, and asks the box itself
 * for a self-hosted one. Takes a `credentialId` for the edit case, where the
 * key is on the server and the browser has no copy of it to send.
 */
export const listModels = (body: {
  provider?: ProviderId; baseUrl?: string; apiKey?: string; credentialId?: string;
}) => apiPost<{ models: string[] }>('/api/v1/llm/models', body);

export const proofread = (title: string, body: string) =>
  apiPost<ProofreadReport>('/api/v1/llm/proofread', { title, body });

// ── Streaming ───────────────────────────────────────────────────────────────

export interface StreamHandlers {
  /** Called with each fragment of text as it arrives. */
  onDelta: (text: string) => void;
  /**
   * The articles the question itself attached with /reference, as the server
   * actually resolved them — a URL this account has no record of is dropped, so
   * this is the list to draw chips from rather than the one that was sent.
   */
  onReferences?: (references: ResearchSource[]) => void;
  /** Articles from the reader's own feed that were pulled in for this answer. */
  onSources?: (sources: ResearchSource[]) => void;
  /** The stream finished cleanly. `costUsd` is null when the model has no known price. */
  onDone?: (payload: { message?: ResearchMessage; costUsd?: number | null }) => void;
  /** The server reported a problem. The stream is over either way. */
  onError: (message: string) => void;
}

/**
 * Read a server-sent event stream from a POST.
 *
 * EventSource can't be used here for two reasons that are each sufficient: it
 * only issues GETs, and it cannot carry an Authorization header — the access
 * token lives in memory, not a cookie, so a request without that header is
 * anonymous. So the stream is a normal fetch whose body is read as it arrives.
 *
 * Returns an abort function. Calling it stops the read *and* the upstream call
 * to the model: the server watches for the client hanging up and aborts its own
 * request, so navigating away mid-answer stops spending money.
 */
export function streamPost(path: string, body: unknown, handlers: StreamHandlers): () => void {
  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (!controller.signal.aborted) handlers.onError('Could not reach Newt’s server.');
      return;
    }

    // Failures before the stream opens are ordinary JSON — a missing key, a
    // rate limit — and carry the message worth showing.
    if (!res.ok || !res.body) {
      let message = 'Something went wrong.';
      try { message = (JSON.parse(await res.text()) as { error?: string }).error || message; } catch { /* not JSON */ }
      handlers.onError(message);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line. Anything after the last one is
        // a partial frame and stays in the buffer.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
            // A line starting with ':' is a comment — the heartbeat. Ignored.
          }
          if (!data) continue;

          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data) as Record<string, unknown>; } catch { continue; }

          if (event === 'delta' && typeof payload.text === 'string') handlers.onDelta(payload.text);
          else if (event === 'meta' && Array.isArray(payload.references)) handlers.onReferences?.(payload.references as ResearchSource[]);
          else if (event === 'sources' && Array.isArray(payload.sources)) handlers.onSources?.(payload.sources as ResearchSource[]);
          else if (event === 'error') handlers.onError(typeof payload.error === 'string' ? payload.error : 'Something went wrong.');
          else if (event === 'done') handlers.onDone?.(payload as { message?: ResearchMessage; costUsd?: number | null });
        }
      }
    } catch {
      // An abort lands here too, and is not an error worth showing — the reader
      // asked for it.
      if (!controller.signal.aborted) handlers.onError('The connection dropped before the answer finished.');
    }
  })();

  return () => controller.abort();
}

export const streamResearchReply = (
  threadId: string,
  question: string | undefined,
  refs: string[],
  handlers: StreamHandlers,
) => streamPost(`/api/v1/research/threads/${threadId}/messages`, { question, refs }, handlers);

export { apiErrorText };
