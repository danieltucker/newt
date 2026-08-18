import { apiGet, apiPost, apiPatch, apiDelete } from './api';

/**
 * The admin-only persona API.
 *
 * Every call here is behind requireAdmin on the server. Nothing in this file is
 * reachable by an ordinary account, and the components that import it are all
 * gated on `isAdmin` — but that gate is cosmetic, as it must be: the server is
 * what refuses, and hiding a button is only about not offering what won't work.
 */

export interface PersonaOption {
  id: string;
  label: string;
  hint: string;
}

export interface PersonaOptions {
  voices: PersonaOption[];
  verbosities: PersonaOption[];
  formalities: PersonaOption[];
  maxGuidance: number;
  maxInterests: number;
  /**
   * Whether the instance can generate at all. When false, every generate button
   * is disabled and the panel explains what to add rather than offering an
   * action that 400s.
   *
   * `env` is the legacy OPERATOR_LLM_* endpoint if one is set — shown read-only,
   * because a row the UI cannot edit pretending to be editable is worse than one
   * that says where it came from. `privateHosts` is the allowlist, so the form
   * can explain a refused address at the moment it is typed.
   */
  operator: {
    configured: boolean;
    env: { baseUrl: string; model: string } | null;
    privateHosts: string[];
  };
}

export interface Persona {
  id: string;
  voice: string;
  verbosity: string;
  formality: string;
  interests: string[];
  guidance: string;
  active: boolean;
  /** Null means "follow the site default" — a real state, not a missing value. */
  siteModelId: string | null;
  siteModel: { label: string; model: string } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    avatar: string | null;
    isPersona: boolean;
  };
  counts: { comments: number; posts: number };
}

export interface PersonaDraft {
  voice: string;
  verbosity: string;
  formality: string;
  interests: string[];
  guidance: string;
  /** Both optional: blank means "let the model invent one". */
  displayName?: string;
  username?: string;
  /** Null puts the persona back on the site default. */
  siteModelId?: string | null;
}

const BASE = '/api/v1/admin/personas';

export function fetchPersonaOptions(): Promise<PersonaOptions> {
  return apiGet<PersonaOptions>(`${BASE}/options`);
}

export async function fetchPersonas(): Promise<Persona[]> {
  const { personas } = await apiGet<{ personas: Persona[] }>(BASE);
  return personas;
}

export function createPersona(draft: PersonaDraft): Promise<Persona> {
  return apiPost<Persona>(BASE, draft);
}

export function updatePersona(id: string, patch: Partial<PersonaDraft> & { active?: boolean }): Promise<Persona> {
  return apiPatch<Persona>(`${BASE}/${id}`, patch);
}

export function deletePersona(id: string): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`${BASE}/${id}`);
}

// ── Generation ───────────────────────────────────────────────────────────────

export interface GeneratedComment {
  id: string;
  body: string;
  parentId?: string;
}

/** A root comment on an article. Posted public, immediately. */
export function personaComment(id: string, url: string, articleTitle?: string): Promise<GeneratedComment> {
  return apiPost<GeneratedComment>(`${BASE}/${id}/comment`, { url, articleTitle });
}

/** A reply to one comment. Posted public, immediately. */
export function personaReply(id: string, commentId: string): Promise<GeneratedComment> {
  return apiPost<GeneratedComment>(`${BASE}/${id}/reply`, { commentId });
}

export interface GeneratedPost {
  id: string;
  title: string;
  slug: string;
  url: string;
  visibility: string;
}

/**
 * A post about an article, under the persona's name.
 *
 * Comes back as a **draft**, unlike the two comment calls — a post is a
 * standalone page with a URL and an RSS entry, so it waits for a human to read
 * it. The caller should say so rather than reporting "posted".
 */
export function personaPost(id: string, url: string): Promise<GeneratedPost> {
  return apiPost<GeneratedPost>(`${BASE}/${id}/post`, { url });
}

// ── Session-level cache ──────────────────────────────────────────────────────

export interface PersonaContext {
  /** Active personas this viewer may summon. Empty for everyone but an admin. */
  personas: Persona[];
  /** Whether the instance has a model configured. False disables generation. */
  ready: boolean;
}

const EMPTY: PersonaContext = { personas: [], ready: false };
let cached: Promise<PersonaContext> | null = null;

/**
 * The persona context for this session, fetched at most once.
 *
 * The comment thread needs this on every article a reader opens, and the answer
 * is the same all session — so it is memoised on the module rather than fetched
 * per mount. Without this, an ordinary account would collect a 403 every time it
 * opened a thread; with it, exactly one.
 *
 * A rejection resolves to `EMPTY` rather than propagating. Not being an admin is
 * the overwhelmingly common reason this fails, and it is not an error condition
 * — it is the answer. Callers get "no personas" and render nothing extra.
 *
 * The cache is *not* invalidated when personas are edited in the admin panel.
 * That is deliberate: the panel holds its own live list, and the only thing this
 * copy feeds is a menu of names in a comment thread. A persona created a moment
 * ago appearing after the next reload is a fair trade for not re-fetching this
 * on every thread. `resetPersonaContext` exists for sign-out, which genuinely
 * changes the answer.
 */
export function loadPersonaContext(): Promise<PersonaContext> {
  if (!cached) {
    cached = Promise.all([fetchPersonaOptions(), fetchPersonas()])
      .then(([opts, list]) => ({
        personas: list.filter(p => p.active),
        ready: opts.operator.configured,
      }))
      .catch(() => EMPTY);
  }
  return cached;
}

/** Drop the cache. Called on sign-out, where the answer changes. */
export function resetPersonaContext(): void {
  cached = null;
}
