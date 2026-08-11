import { describe, it, expect } from 'vitest';
import { estimateCost, formatCost } from './cost';
import { PROVIDERS } from './providers';

const anthropic = PROVIDERS.anthropic;
const compatible = PROVIDERS.compatible;

describe('estimateCost', () => {
  it('prices input and output at the model’s own rates', () => {
    // Haiku 4.5 is $1/M in, $5/M out.
    const { usd } = estimateCost(anthropic, 'claude-haiku-4-5', {
      input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0,
    });
    expect(usd).toBeCloseTo(6, 5);
  });

  it('charges cache reads at a fraction of the input rate', () => {
    // The reason a long thread stays affordable — and the reason cacheRead is
    // reported separately rather than lumped into input.
    const cached = estimateCost(anthropic, 'claude-opus-5', {
      input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0,
    });
    const fresh = estimateCost(anthropic, 'claude-opus-5', {
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0,
    });
    expect(cached.usd!).toBeLessThan(fresh.usd!);
    expect(cached.usd!).toBeCloseTo(fresh.usd! * 0.1, 5);
  });

  it('charges cache writes at a premium over plain input', () => {
    const written = estimateCost(anthropic, 'claude-opus-5', {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000,
    });
    const fresh = estimateCost(anthropic, 'claude-opus-5', {
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0,
    });
    expect(written.usd!).toBeGreaterThan(fresh.usd!);
  });

  it('ranks the tiers the way the picker claims', () => {
    const usage = { input: 10_000, output: 10_000, cacheRead: 0, cacheWrite: 0 };
    const opus = estimateCost(anthropic, 'claude-opus-5', usage).usd!;
    const sonnet = estimateCost(anthropic, 'claude-sonnet-5', usage).usd!;
    const haiku = estimateCost(anthropic, 'claude-haiku-4-5', usage).usd!;
    expect(opus).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(haiku);
  });

  it('returns null for a model with no known price rather than zero', () => {
    // "Free" and "unknown" are different claims, and only one of them is true
    // for a self-hosted box or a model id Newt has never heard of.
    const selfHosted = estimateCost(compatible, 'llama3.1', {
      input: 999_999, output: 999_999, cacheRead: 0, cacheWrite: 0,
    });
    expect(selfHosted.usd).toBeNull();
    expect(estimateCost(anthropic, 'some-future-model', {
      input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0,
    }).usd).toBeNull();
  });

  it('carries the raw usage back out untouched', () => {
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    expect(estimateCost(anthropic, 'claude-opus-5', usage).usage).toEqual(usage);
  });
});

describe('formatCost', () => {
  it('says "under $0.01" rather than rounding a real cost to zero', () => {
    // $0.00 reads as free, and a hundred free-looking questions is how someone
    // gets surprised by an invoice.
    expect(formatCost(0.004)).toBe('under $0.01');
  });

  it('formats real amounts to the cent', () => {
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(3)).toBe('$3.00');
  });

  it('shows nothing when there is nothing to show', () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(0)).toBeNull();
  });
});
