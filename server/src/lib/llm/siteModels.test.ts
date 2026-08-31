import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The statistics the Usage panel draws.
 *
 * Worth testing because every interesting rule here is about *not* counting
 * something: a failure's duration is not latency, an unreported token count is
 * not zero tokens, and an average over no samples is not 0.
 */

const rows: Record<string, unknown>[] = [];

vi.mock('../prisma', () => ({
  default: {
    siteModelUsage: {
      findMany: async () => rows,
      create: async () => undefined,
      deleteMany: async () => undefined,
    },
    siteModel: { count: async () => 0 },
  },
}));

const { usageStats } = await import('./siteModels');

function row(over: Record<string, unknown> = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    siteModelId: 'm1',
    modelLabel: '3090 box',
    modelName: 'llama3.1:8b',
    taskId: 'p1',
    taskLabel: 'Rae',
    kind: 'comment',
    outcome: 'success',
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 1000,
    error: '',
    createdAt: new Date('2026-08-17T12:00:00Z'),
    ...over,
  };
}

beforeEach(() => { rows.length = 0; });
afterEach(() => { rows.length = 0; });

describe('usageStats', () => {
  it('reports nulls rather than zeros when there is nothing to average', async () => {
    const s = await usageStats(7);
    expect(s.totals.calls).toBe(0);
    // A median of 0ms would read as an instantaneous model, which is a lie.
    expect(s.totals.medianMs).toBeNull();
    expect(s.totals.p95Ms).toBeNull();
    expect(s.totals.tokensPerSecond).toBeNull();
  });

  it('counts calls and failures', async () => {
    rows.push(row(), row(), row({ outcome: 'failed', error: 'timeout' }));
    const s = await usageStats(7);
    expect(s.totals.calls).toBe(3);
    expect(s.totals.failed).toBe(1);
  });

  // A refused connection returns in 2ms and a timeout in 30s; neither describes
  // how fast the model is, and both would wreck the percentiles.
  it('excludes failures from the latency percentiles', async () => {
    rows.push(row({ durationMs: 1000 }), row({ durationMs: 1000 }));
    rows.push(row({ outcome: 'failed', durationMs: 30000 }));
    const s = await usageStats(7);
    expect(s.totals.medianMs).toBe(1000);
    expect(s.totals.p95Ms).toBe(1000);
  });

  it('excludes zero durations, which mean "not measured"', async () => {
    rows.push(row({ durationMs: 0 }), row({ durationMs: 500 }));
    expect((await usageStats(7)).totals.medianMs).toBe(500);
  });

  it('computes tokens per second only over calls that reported tokens', async () => {
    // 50 tokens in 1s, plus a call that reported nothing. Counting the second
    // as zero-token would halve the answer and misrepresent the hardware.
    rows.push(row({ outputTokens: 50, durationMs: 1000 }));
    rows.push(row({ outputTokens: 0, durationMs: 1000 }));
    expect((await usageStats(7)).totals.tokensPerSecond).toBeCloseTo(50, 5);
  });

  it('still sums raw token totals across every row', async () => {
    rows.push(row({ inputTokens: 100, outputTokens: 50 }), row({ inputTokens: 20, outputTokens: 5 }));
    const s = await usageStats(7);
    expect(s.totals.inputTokens).toBe(120);
    expect(s.totals.outputTokens).toBe(55);
  });

  it('groups by model and keeps a per-model median', async () => {
    rows.push(row({ modelName: 'llama3.1:8b', durationMs: 1000 }));
    rows.push(row({ modelName: 'llama3.1:8b', durationMs: 1000 }));
    rows.push(row({ siteModelId: 'm2', modelName: 'qwen2.5:32b', durationMs: 9000 }));
    const s = await usageStats(7);
    expect(s.byModel).toHaveLength(2);
    expect(s.byModel[0].model).toBe('llama3.1:8b');
    expect(s.byModel[0].calls).toBe(2);
    expect(s.byModel[0].medianMs).toBe(1000);
    expect(s.byModel.find(m => m.model === 'qwen2.5:32b')?.medianMs).toBe(9000);
  });

  // The row survives its endpoint being deleted (siteModelId goes null), and the
  // denormalised name is what keeps it readable.
  it('groups rows whose endpoint was deleted by their stored model name', async () => {
    rows.push(row({ siteModelId: null, modelName: 'gone:7b' }));
    const s = await usageStats(7);
    expect(s.byModel[0].model).toBe('gone:7b');
    expect(s.byModel[0].siteModelId).toBeNull();
  });

  it('groups by task and by day', async () => {
    rows.push(row({ taskId: 'p1', taskLabel: 'Rae', createdAt: new Date('2026-08-16T10:00:00Z') }));
    rows.push(row({ taskId: 'p2', taskLabel: 'Kit', createdAt: new Date('2026-08-17T10:00:00Z') }));
    rows.push(row({ taskId: 'p2', taskLabel: 'Kit', createdAt: new Date('2026-08-17T11:00:00Z') }));
    const s = await usageStats(7);
    expect(s.byTask[0]).toMatchObject({ name: 'Kit', calls: 2 });
    expect(s.byDay).toEqual([
      { date: '2026-08-16', calls: 1, failed: 0 },
      { date: '2026-08-17', calls: 2, failed: 0 },
    ]);
  });

  it('caps the recent list at 50', async () => {
    for (let i = 0; i < 80; i++) rows.push(row());
    expect((await usageStats(7)).recent).toHaveLength(50);
  });

  it('echoes the window it was asked for', async () => {
    expect((await usageStats(30)).windowDays).toBe(30);
  });
});
