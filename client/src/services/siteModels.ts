import { apiGet, apiPost, apiPatch, apiDelete } from './api';

/**
 * The admin API for the instance's own model endpoints, and their usage history.
 *
 * All admin-only on the server. Note what never crosses this boundary: a stored
 * API key. `keyLast4` is the whole of the disclosure, exactly as with a user's
 * own credentials — the server cannot serve a key without decrypting one, and no
 * route does.
 */

export interface SiteModel {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  keyLast4: string;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  createdBy: string | null;
  source: 'db';
}

export interface SiteModelList {
  models: SiteModel[];
  /** The legacy OPERATOR_LLM_* endpoint, shown read-only. Null when unset. */
  env: { baseUrl: string; model: string } | null;
  /**
   * Hosts the server will accept at a private address, from
   * OPERATOR_LLM_PRIVATE_HOSTS. The form uses this to explain a refusal before
   * the request is made, and to say what to add if the admin wants one.
   */
  privateHosts: string[];
  retentionDays: number;
}

export interface SiteModelDraft {
  label?: string;
  baseUrl?: string;
  model?: string;
  /** Omit to leave a stored key alone; '' to remove it. Never read back. */
  apiKey?: string;
  isDefault?: boolean;
  enabled?: boolean;
}

const BASE = '/api/v1/admin/site-models';

export function fetchSiteModels(): Promise<SiteModelList> {
  return apiGet<SiteModelList>(BASE);
}

export function createSiteModel(draft: SiteModelDraft): Promise<SiteModel> {
  return apiPost<SiteModel>(BASE, draft);
}

export function updateSiteModel(id: string, patch: SiteModelDraft): Promise<SiteModel> {
  return apiPatch<SiteModel>(`${BASE}/${id}`, patch);
}

export function deleteSiteModel(id: string): Promise<{ ok: true; personasAffected: number }> {
  return apiDelete<{ ok: true; personasAffected: number }>(`${BASE}/${id}`);
}

/**
 * Ask an endpoint what it serves. Takes a URL rather than an id so the picker
 * works for an endpoint still being typed.
 */
export function probeModels(baseUrl: string, apiKey?: string): Promise<{ models: string[] }> {
  return apiPost<{ models: string[] }>(`${BASE}/models`, { baseUrl, apiKey });
}

/** One tiny prompt, to see whether the box answers and how long a cold start takes. */
export function testSiteModel(id: string): Promise<{ ok: true; durationMs: number; reply: string }> {
  return apiPost<{ ok: true; durationMs: number; reply: string }>(`${BASE}/${id}/test`, {});
}

// ── Usage ────────────────────────────────────────────────────────────────────

export interface UsageStats {
  windowDays: number;
  totals: {
    calls: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    /** Null means no successful call reported one — never render this as 0. */
    medianMs: number | null;
    p95Ms: number | null;
    tokensPerSecond: number | null;
  };
  byModel: {
    siteModelId: string | null;
    label: string;
    model: string;
    calls: number;
    failed: number;
    medianMs: number | null;
    outputTokens: number;
  }[];
  byPersona: { personaId: string | null; name: string; calls: number; failed: number }[];
  byDay: { date: string; calls: number; failed: number }[];
  recent: {
    id: string; kind: string; outcome: string; label: string; model: string;
    personaName: string; durationMs: number; inputTokens: number; outputTokens: number;
    error: string; createdAt: string;
  }[];
}

export function fetchUsage(days: number): Promise<UsageStats> {
  return apiGet<UsageStats>(`${BASE}/usage?days=${days}`);
}
