import { describe, it, expect } from 'vitest';
import { PROVIDERS, publicProviders, isProviderId, utilityModelFor, modelOption } from './providers';

describe('the registry', () => {
  it('gives every hosted provider a default that is in its own catalogue', () => {
    // A default naming a model the picker doesn't list would show as "no
    // selection" the moment someone opened the form.
    for (const provider of Object.values(PROVIDERS)) {
      if (!provider.defaultModel) continue;
      expect(modelOption(provider, provider.defaultModel), provider.id).toBeDefined();
    }
  });

  it('gives every hosted provider a cheap model to fall back on', () => {
    for (const id of ['anthropic', 'openai'] as const) {
      expect(PROVIDERS[id].models.some(m => m.utility), id).toBe(true);
    }
  });

  it('prices every model, so the picker can rank them', () => {
    for (const provider of Object.values(PROVIDERS)) {
      for (const model of provider.models) {
        expect(model.inputPer1M, model.id).toBeGreaterThan(0);
        expect(model.outputPer1M, model.id).toBeGreaterThan(0);
        // Output costs more than input on every provider here; the picker's
        // "about Nx the cost" line is computed off output alone on that basis.
        expect(model.outputPer1M, model.id).toBeGreaterThan(model.inputPer1M);
      }
    }
  });

  it('only offers model discovery where there is something to discover', () => {
    // The hosted providers have a catalogue; a self-hosted box does not.
    expect(PROVIDERS.compatible.canListModels).toBe(true);
    expect(PROVIDERS.compatible.models).toEqual([]);
    expect(PROVIDERS.anthropic.canListModels).toBe(false);
    expect(PROVIDERS.openai.canListModels).toBe(false);
  });
});

describe('isProviderId', () => {
  it('accepts the three real ones and nothing else', () => {
    expect(isProviderId('anthropic')).toBe(true);
    expect(isProviderId('compatible')).toBe(true);
    expect(isProviderId('gemini')).toBe(false);
    expect(isProviderId(null)).toBe(false);
    // Guards against a prototype-chain hit from hasOwnProperty misuse.
    expect(isProviderId('constructor')).toBe(false);
    expect(isProviderId('toString')).toBe(false);
  });
});

describe('utilityModelFor', () => {
  it('drops to the cheap model for side tasks', () => {
    expect(utilityModelFor(PROVIDERS.anthropic, 'claude-opus-5')).toBe('claude-haiku-4-5');
    expect(utilityModelFor(PROVIDERS.openai, 'gpt-4o')).toBe('gpt-4o-mini');
  });

  it('leaves an already-cheap choice alone', () => {
    // No "downgrading" someone who already picked the economy option.
    expect(utilityModelFor(PROVIDERS.anthropic, 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('keeps the chosen model when the provider has no cheap tier', () => {
    // Self-hosted: Newt has no idea what else that box serves, so quietly
    // switching to a model the user never picked would be worse than paying.
    expect(utilityModelFor(PROVIDERS.compatible, 'llama3.1')).toBe('llama3.1');
  });

  it('keeps an unrecognised model rather than substituting one', () => {
    expect(utilityModelFor(PROVIDERS.anthropic, 'claude-future-9')).toBe('claude-haiku-4-5');
  });
});

describe('publicProviders', () => {
  it('serves the fields the picker needs', () => {
    const anthropic = publicProviders().find(p => p.id === 'anthropic')!;
    expect(anthropic.models.length).toBeGreaterThan(0);
    expect(anthropic.pricingUrl).toMatch(/^https:/);
    expect(anthropic.docsUrl).toMatch(/^https:/);
  });
});
