import { apiGet, apiPost, apiPatch, apiDelete } from './api';

/**
 * The admin-only AI task API.
 *
 * Every call here is behind requireAdmin on the server. Nothing in this file is
 * reachable by an ordinary account, and the components that import it are gated
 * on `isAdmin` — but that gate is cosmetic, as it must be: the server is what
 * refuses, and hiding a button is only about not offering what will not work.
 */

export type TaskKind = 'explore' | 'moderate' | 'relate';

export type AutoPublish = 'never' | 'admin' | 'always';

export interface TriggerConfig {
  onAdminRequest: boolean;
  onCommentCount: number;
  onSaveCount: number;
  scheduledTopN: number;
  enforce: boolean;
  relateWindowHours: number;
  relateTopSites: number;
  relateTopSaved: number;
  relateCrossSiteOnly: boolean;
  /** Which generated threads skip review. See the server's TriggerConfig. */
  autoPublish: AutoPublish;
}

export interface AiTask {
  id: string;
  kind: TaskKind;
  label: string;
  prompt: string;
  /** Null means "follow the site default" — a real state, not a missing value. */
  siteModelId: string | null;
  siteModel: { label: string; model: string } | null;
  trigger: TriggerConfig;
  enabled: boolean;
  createdAt: string;
}

export interface AiOptions {
  kinds: TaskKind[];
  defaultPrompts: Record<string, string>;
  defaultTrigger: TriggerConfig;
  autoPublishOptions: AutoPublish[];
  /** False when no site model exists: every run button is disabled and says why. */
  configured: boolean;
  limits: { prompt: number; label: number };
}

export interface AiJob {
  id: string;
  status: string;
  trigger: string;
  articleUrl: string;
  subjectId: string;
  threadId: string | null;
  note: string;
  verdict: string;
  category: string;
  confidence: number;
  attempts: number;
  createdAt: string;
  finishedAt: string | null;
  task: { id: string; kind: string; label: string } | null;
}

export interface RunningJob {
  id: string;
  taskLabel: string;
  kind: string;
  trigger: string;
  subject: string;
  elapsedMs: number;
  attempt: number;
}

export interface QueueStats {
  queued: number;
  running: number;
  /** Age of the oldest waiting job. Null when nothing is waiting. */
  oldestMs: number | null;
  /** What is in flight right now, not just how many. */
  active: RunningJob[];
  /** When the queue itself gives up on a running job and reclaims it. */
  staleAfterMs: number;
}

export interface PassResult {
  queued: number;
  relateQueued: number;
  considered: number;
  skipped: { reason: string; count: number }[];
  noTasks: boolean;
}

export interface LocalModel {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  /** Resident in VRAM right now, from Ollama's /api/ps. */
  loaded: boolean;
}

export interface PullState {
  model: string;
  progress: { status: string; completed: number; total: number };
}

const BASE = '/api/v1/admin/ai';

export const aiOptions = () => apiGet<AiOptions>(`${BASE}/options`);
export const listTasks = () => apiGet<{ tasks: AiTask[] }>(`${BASE}/tasks`);
export const createTask = (body: Partial<AiTask>) => apiPost<AiTask>(`${BASE}/tasks`, body);
export const updateTask = (id: string, body: Partial<AiTask>) => apiPatch<AiTask>(`${BASE}/tasks/${id}`, body);
export const deleteTask = (id: string) => apiDelete<{ ok: true }>(`${BASE}/tasks/${id}`);

export const listJobs = (params: { status?: string; kind?: string } = {}) => {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.kind) q.set('kind', params.kind);
  const qs = q.toString();
  return apiGet<{ jobs: AiJob[]; stats: QueueStats }>(`${BASE}/jobs${qs ? `?${qs}` : ''}`);
};

export const runScheduledPass = () => apiPost<PassResult>(`${BASE}/scheduled-pass`, {});
export const publishThread = (id: string) => apiPost<{ ok: true }>(`${BASE}/threads/${id}/publish`, {});
export const discardThread = (id: string) => apiDelete<{ ok: true }>(`${BASE}/threads/${id}`);

export const localModels = (siteModelId: string) =>
  apiGet<{ models: LocalModel[] | null; pulling: PullState | null }>(`${BASE}/models/${siteModelId}`);
export const pullStatus = () => apiGet<{ pulling: PullState | null }>(`${BASE}/models/pull/status`);
export const startPull = (siteModelId: string, model: string) =>
  apiPost<{ started: true; model: string }>(`${BASE}/models/${siteModelId}/pull`, { model });
export const removeModel = (siteModelId: string, model: string) =>
  apiDelete<{ ok: true }>(`${BASE}/models/${siteModelId}/${encodeURIComponent(model)}`);

// ── The article button ──────────────────────────────────────────────────────

export interface ExploreTaskSummary {
  id: string;
  label: string;
  model: string;
}

/**
 * Memoised for the session, like the persona context it replaces.
 *
 * The button renders on every article a reader opens, and the answer for a
 * non-admin never changes within a session — an empty list, because the route
 * is admin-only. Twenty articles should cost one request, not twenty.
 *
 * A failure resolves to "nothing available" rather than rejecting: for the
 * overwhelmingly common caller — an ordinary reader whose request is refused —
 * the 403 *is* the answer, and turning it into an error would put a console
 * warning on every article view.
 */
let cached: Promise<{ tasks: ExploreTaskSummary[]; configured: boolean }> | null = null;

export function loadExploreTasks(): Promise<{ tasks: ExploreTaskSummary[]; configured: boolean }> {
  if (!cached) {
    cached = (async () => {
      try {
        const [{ tasks }, options] = await Promise.all([listTasks(), aiOptions()]);
        return {
          tasks: tasks
            .filter(t => t.kind === 'explore' && t.enabled && t.trigger.onAdminRequest)
            .map(t => ({ id: t.id, label: t.label, model: t.siteModel?.model ?? '' })),
          configured: options.configured,
        };
      } catch {
        return { tasks: [], configured: false };
      }
    })();
  }
  return cached;
}

/** Cleared on sign-out, so the next account does not inherit this one's answer. */
export function resetExploreTasks(): void {
  cached = null;
}

export const runExploreTask = (id: string, url: string) =>
  apiPost<{ queued: boolean; reason: string; willPublish: boolean }>(`${BASE}/tasks/${id}/run`, { url });
