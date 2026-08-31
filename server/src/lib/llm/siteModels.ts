import prisma from '../prisma';
import { PROVIDERS, Provider } from './providers';
import { LlmError, Usage } from './chat';
import { openSecret } from './secretBox';
import { normalizeBase, operatorBaseUrl, privateHostAllowlist } from './operatorEnv';
import logger from '../logger';

/**
 * Which model the instance uses, and what every call to it cost.
 *
 * This is the site-wide counterpart to lib/llm/credentials.ts. The two are
 * deliberately separate modules with no shared helper: that one resolves a key
 * belonging to a *person*, spent by them and reaching only public endpoints;
 * this one resolves the *operator's* endpoint, which is the only call in Newt
 * permitted to reach a private address. Folding them together would put one
 * function one bug away from letting a user's URL through that door.
 *
 * As with credentials.ts, this is the only module that calls openSecret for
 * these rows: a decrypted key lives as a local for one request and is never
 * attached to a response, a log line, or a model something else may serialize.
 */

export interface ResolvedSiteModel {
  /** Null for the environment fallback, which has no row to attribute usage to. */
  id: string | null;
  label: string;
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Permission to consult the operator's private-host allowlist. Set here and
   * nowhere else in the codebase — grep for `trusted:` and there should be this
   * one assignment plus the guard in chat.ts that acts on it.
   */
  trusted: true;
}

/** What the admin panel may see about a stored endpoint. Note the missing key. */
export function toPublicSiteModel(row: {
  id: string; label: string; baseUrl: string; model: string; keyLast4: string;
  isDefault: boolean; enabled: boolean; createdAt: Date;
  createdBy?: { username: string } | null;
}) {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    keyLast4: row.keyLast4,
    isDefault: row.isDefault,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy?.username ?? null,
    // Whether this endpoint needs an allowlist entry to work. Computed rather
    // than stored: the environment can change under a stored row, and a stale
    // "this is fine" is worse than no answer.
    source: 'db' as const,
  };
}

/**
 * The environment fallback, kept so that upgrading from v1.22.0 does not switch
 * AI tasks off the moment site models exist.
 *
 * Used only when the table has no usable row. Surfaced to the panel as a
 * read-only entry: a row the UI cannot edit, pretending to be editable, is worse
 * than one that says where it came from.
 */
function envSiteModel(): ResolvedSiteModel | null {
  const baseUrl = operatorBaseUrl();
  const model = (process.env.OPERATOR_LLM_MODEL ?? '').trim();
  if (!baseUrl || !model) return null;
  return {
    id: null,
    label: 'From environment',
    provider: PROVIDERS.compatible,
    apiKey: (process.env.OPERATOR_LLM_KEY ?? '').trim(),
    baseUrl,
    model,
    trusted: true,
  };
}

export function envSiteModelSummary(): { baseUrl: string; model: string } | null {
  const m = envSiteModel();
  return m ? { baseUrl: m.baseUrl, model: m.model } : null;
}

/** The allowlist, for the panel to explain why an address was refused. */
export function allowlistedPrivateHosts(): string[] {
  return privateHostAllowlist();
}

function decryptKey(row: { keyCipher: string; keyIv: string; keyTag: string }): string {
  if (!row.keyCipher) return '';
  const opened = openSecret({ cipher: row.keyCipher, iv: row.keyIv, tag: row.keyTag });
  if (opened === null) {
    // The realistic cause is LLM_KEY_SECRET changing between deploys. Say so —
    // "invalid key" would send an admin to re-paste one that was always fine.
    throw new LlmError(
      'That endpoint’s stored key could not be decrypted. If LLM_KEY_SECRET changed, re-enter it.',
      400,
    );
  }
  return opened;
}

/**
 * The endpoint an AI task should be run on.
 *
 * Order: the task's own choice, then the instance default, then the single
 * oldest enabled row, then the environment. The third step matters more than it
 * looks — an admin who adds exactly one endpoint and never thinks about the word
 * "default" should not find its tasks broken, which is the same accommodation
 * resolveCredential makes for a user with one key.
 *
 * A task pointing at a *disabled* endpoint falls back rather than failing.
 * Disabling is the operator saying "stop dialling this box", and the useful
 * response to that is for the tasks on it to keep working via the default,
 * not for them to go silent until somebody notices.
 */
export async function resolveSiteModel(taskSiteModelId?: string | null): Promise<ResolvedSiteModel> {
  const rows = await prisma.siteModel.findMany({
    where: { enabled: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  const chosen =
    (taskSiteModelId ? rows.find(r => r.id === taskSiteModelId) : undefined)
    ?? rows[0];

  if (!chosen) {
    const env = envSiteModel();
    if (env) return env;
    throw new LlmError(
      'No site model is configured. Add one in Admin → AI to run AI tasks.',
      400,
    );
  }

  if (!chosen.model) {
    throw new LlmError(`“${chosen.label || chosen.baseUrl}” has no model set.`, 400);
  }

  return {
    id: chosen.id,
    label: chosen.label || chosen.baseUrl,
    provider: PROVIDERS.compatible,
    apiKey: decryptKey(chosen),
    baseUrl: normalizeBase(chosen.baseUrl),
    model: chosen.model,
    trusted: true,
  };
}

/** Whether any AI task can run at all right now. */
export async function siteModelConfigured(): Promise<boolean> {
  const count = await prisma.siteModel.count({ where: { enabled: true } });
  return count > 0 || envSiteModel() !== null;
}

// ── Usage ────────────────────────────────────────────────────────────────────

/**
 * How long usage rows are kept.
 *
 * 30 days rather than FeedFetchLog's 7. This table is written on admin-triggered
 * generations — tens per day at most, not one row per feed per poll — so the
 * volume argument that made feed logs short does not apply, and a month is what
 * it takes to see whether a model change actually helped.
 */
export const USAGE_RETENTION_DAYS = 30;

export type UsageKind = 'explore' | 'moderate' | 'relate' | 'test';

export interface UsageRecord {
  siteModel: ResolvedSiteModel;
  taskId?: string | null;
  taskLabel?: string;
  kind: UsageKind;
  outcome: 'success' | 'failed';
  usage?: Usage;
  durationMs: number;
  error?: string;
}

/**
 * Write one usage row, and occasionally prune old ones.
 *
 * **Never throws.** This is bookkeeping about a generation that has already
 * happened; a logging failure must not turn a comment that was successfully
 * posted into a 500 the admin sees. Same contract as noteSuccess/noteFailure in
 * the feed code.
 *
 * Pruning rides on writes rather than a scheduler tick, and only sometimes:
 * a DELETE on every row would double the write cost of a table whose whole
 * purpose is to be cheap to append to.
 */
export async function recordUsage(rec: UsageRecord): Promise<void> {
  try {
    await prisma.siteModelUsage.create({
      data: {
        siteModelId: rec.siteModel.id,
        modelLabel: rec.siteModel.label.slice(0, 200),
        modelName: rec.siteModel.model.slice(0, 200),
        taskId: rec.taskId ?? null,
        taskLabel: (rec.taskLabel ?? '').slice(0, 200),
        kind: rec.kind,
        outcome: rec.outcome,
        inputTokens: rec.usage?.input ?? 0,
        outputTokens: rec.usage?.output ?? 0,
        durationMs: Math.max(0, Math.round(rec.durationMs)),
        // Truncated hard: an upstream error body can be a whole HTML page, and
        // this column is read in a table.
        error: (rec.error ?? '').slice(0, 500),
      },
    });

    if (Math.random() < 0.05) {
      const cutoff = new Date(Date.now() - USAGE_RETENTION_DAYS * 24 * 60 * 60_000);
      await prisma.siteModelUsage.deleteMany({ where: { createdAt: { lt: cutoff } } });
    }
  } catch (err) {
    logger.warn(err, 'Site model usage logging failed');
  }
}

// ── Statistics ───────────────────────────────────────────────────────────────

export interface UsageStats {
  windowDays: number;
  totals: {
    calls: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    /** Null when nothing succeeded — an average over no samples is not zero. */
    medianMs: number | null;
    p95Ms: number | null;
    /** Output tokens per second across successful calls that reported any. */
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
  byTask: { taskId: string | null; name: string; calls: number; failed: number }[];
  byDay: { date: string; calls: number; failed: number }[];
  recent: {
    id: string; kind: string; outcome: string; label: string; model: string;
    taskLabel: string; durationMs: number; inputTokens: number; outputTokens: number;
    error: string; createdAt: string;
  }[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * The numbers the Usage panel draws.
 *
 * Computed in the process rather than in SQL. The row count this reads is
 * bounded by generations in the window — tens to low thousands — and expressing
 * a median and a p95 per group in Postgres would be far more machinery than a
 * sort over a few hundred numbers deserves. If this table ever grows by orders
 * of magnitude, that trade flips and this becomes the thing to rewrite.
 *
 * **Latency percentiles cover successful calls only.** A failure's duration is
 * whatever the timeout was, or a few milliseconds for a refused connection, and
 * mixing those in makes p95 describe the error path rather than the model.
 */
export async function usageStats(windowDays = 7): Promise<UsageStats> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000);
  const rows = await prisma.siteModelUsage.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });

  const ok = rows.filter(r => r.outcome === 'success');
  const durations = ok.map(r => r.durationMs).filter(d => d > 0).sort((a, b) => a - b);

  // Only calls that actually reported tokens *and* took measurable time can
  // contribute a rate; Ollama omits usage on older builds, and counting those
  // as zero-token would drag the figure toward nothing.
  const rateable = ok.filter(r => r.outputTokens > 0 && r.durationMs > 0);
  const tokensPerSecond = rateable.length
    ? rateable.reduce((n, r) => n + r.outputTokens, 0) / (rateable.reduce((n, r) => n + r.durationMs, 0) / 1000)
    : null;

  const group = <K extends string>(
    keyOf: (r: typeof rows[number]) => K,
  ): Map<K, typeof rows> => {
    const m = new Map<K, typeof rows>();
    for (const r of rows) {
      const k = keyOf(r);
      const list = m.get(k);
      if (list) list.push(r); else m.set(k, [r]);
    }
    return m;
  };

  const byModel = [...group(r => `${r.siteModelId ?? ''}|${r.modelName}`).entries()]
    .map(([, list]) => {
      const good = list.filter(r => r.outcome === 'success').map(r => r.durationMs)
        .filter(d => d > 0).sort((a, b) => a - b);
      return {
        siteModelId: list[0].siteModelId,
        label: list[0].modelLabel || '(unnamed)',
        model: list[0].modelName,
        calls: list.length,
        failed: list.filter(r => r.outcome === 'failed').length,
        medianMs: percentile(good, 0.5),
        outputTokens: list.reduce((n, r) => n + r.outputTokens, 0),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const byTask = [...group(r => r.taskId ?? r.taskLabel).entries()]
    .map(([, list]) => ({
      taskId: list[0].taskId,
      name: list[0].taskLabel || '(none)',
      calls: list.length,
      failed: list.filter(r => r.outcome === 'failed').length,
    }))
    .sort((a, b) => b.calls - a.calls);

  const byDay = [...group(r => r.createdAt.toISOString().slice(0, 10)).entries()]
    .map(([date, list]) => ({
      date,
      calls: list.length,
      failed: list.filter(r => r.outcome === 'failed').length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    windowDays,
    totals: {
      calls: rows.length,
      failed: rows.filter(r => r.outcome === 'failed').length,
      inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
      medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      tokensPerSecond,
    },
    byModel,
    byTask,
    byDay,
    recent: rows.slice(0, 50).map(r => ({
      id: r.id,
      kind: r.kind,
      outcome: r.outcome,
      label: r.modelLabel || '(unnamed)',
      model: r.modelName,
      taskLabel: r.taskLabel,
      durationMs: r.durationMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
