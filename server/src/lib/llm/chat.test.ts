import { describe, it, expect } from 'vitest';
import { buildBody, ChatRequest } from './chat';
import { PROVIDERS, utilityModelFor } from './providers';
import { PROOFREAD, PLANNER, researchDepth } from './depth';

// What actually goes on the wire. These assert the request body rather than the
// helper that shapes one field of it, because the bug this file exists for was
// invisible at the helper level: every piece was individually reasonable and
// the combination was a 400 from Anthropic on every proofread.

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: PROVIDERS.anthropic,
  apiKey: 'sk-ant-test',
  baseUrl: '',
  model: 'claude-sonnet-5',
  system: 'You are a proofreader.',
  turns: [{ role: 'user', content: 'Teh quick brown fox.' }],
  maxTokens: 1_000,
  ...over,
});

const bodyOf = (over: Partial<ChatRequest> = {}) =>
  JSON.parse(buildBody(req(over)).body) as Record<string, unknown>;

describe('the Anthropic body', () => {
  it('puts the system prompt at the top level, not in a turn', () => {
    const body = bodyOf();
    expect(body.system).toBe('You are a proofreader.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Teh quick brown fox.' }]);
  });

  it('sends the key as x-api-key with a pinned version', () => {
    const { headers } = buildBody(req());
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('carries effort for a model that takes it', () => {
    expect(bodyOf({ model: 'claude-sonnet-5', effort: 'high' }).output_config)
      .toEqual({ effort: 'high' });
  });

  // The regression. Haiku 4.5 predates output_config.effort and rejects a
  // request carrying it, and it is the model every proofread runs on.
  it('leaves effort off Haiku 4.5, whatever the caller asked for', () => {
    expect(bodyOf({ model: 'claude-haiku-4-5', effort: 'low' })).not.toHaveProperty('output_config');
  });

  it('leaves effort off a model it has never heard of', () => {
    expect(bodyOf({ model: 'claude-future-9', effort: 'low' })).not.toHaveProperty('output_config');
  });

  it('sends no sampling parameters, which the current models reject outright', () => {
    const body = bodyOf({ effort: 'high' });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    // Nor a thinking config: the 5-series reason by default, and the removed
    // budget_tokens form is a 400 on every one of them.
    expect(body).not.toHaveProperty('thinking');
  });

  it('marks the cache breakpoints only when asked to', () => {
    const cached = bodyOf({ cache: true, turns: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ] });
    // End of the system prompt, and end of the opening turn - the two places
    // the stable prefix stops.
    expect(cached.system).toEqual(
      [{ type: 'text', text: 'You are a proofreader.', cache_control: { type: 'ephemeral' } }]);
    const messages = cached.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toEqual(
      [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }]);
    expect(messages[2].content).toBe('follow-up');
  });
});

describe('the calls Newt actually makes', () => {
  // Both side tasks force the utility model regardless of what the account
  // chose, so these are the two requests every Claude user sends whatever their
  // settings say - and the two that were failing.
  const utility = utilityModelFor(PROVIDERS.anthropic, 'claude-opus-5');

  it('sends a proofread Anthropic will accept', () => {
    const body = bodyOf({ model: utility, maxTokens: PROOFREAD.maxTokens, effort: PROOFREAD.effort });
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body).not.toHaveProperty('output_config');
    expect(body.max_tokens).toBe(6_000);
  });

  it('sends a feed-search plan Anthropic will accept', () => {
    const body = bodyOf({ model: utility, maxTokens: PLANNER.maxTokens, effort: PLANNER.effort });
    expect(body).not.toHaveProperty('output_config');
  });

  it('still spends the effort dial on the research model, which is the point of it', () => {
    const body = bodyOf({ model: 'claude-opus-5', effort: researchDepth('thorough').effort });
    expect(body.output_config).toEqual({ effort: 'high' });
  });
});

describe('the OpenAI body', () => {
  const openai = (over: Partial<ChatRequest> = {}) =>
    JSON.parse(buildBody(req({ provider: PROVIDERS.openai, model: 'gpt-4o', ...over })).body);

  it('folds the system prompt into the turns and asks for usage', () => {
    const body = openai();
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a proofreader.' });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('never sends effort, which is not a field on this wire', () => {
    expect(openai({ effort: 'high' })).not.toHaveProperty('output_config');
  });

  it('sends no auth header at all when there is no key', () => {
    // A local Ollama has no auth; `Bearer ` reads as a bad key rather than none.
    const { headers } = buildBody(req({ provider: PROVIDERS.compatible, apiKey: '', model: 'llama3.1' }));
    expect(headers).not.toHaveProperty('authorization');
  });
});
