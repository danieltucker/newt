import { describe, it, expect } from 'vitest';
import { jsonValues, stripReasoning } from './jsonReply';

/** Everything the scanner finds, so a test can assert on order as well as content. */
const all = (raw: string, opener: '{' | '[') => [...jsonValues(raw, opener)];

describe('stripReasoning', () => {
  it('removes a closed thinking block and keeps what follows', () => {
    expect(stripReasoning('<think>hmm</think>answer').trim()).toBe('answer');
    expect(stripReasoning('<thinking>hmm</thinking>answer').trim()).toBe('answer');
    expect(stripReasoning('<reasoning>hmm</reasoning>answer').trim()).toBe('answer');
  });

  it('is case-insensitive and survives attributes on the tag', () => {
    expect(stripReasoning('<THINK depth="2">hmm</THINK>answer').trim()).toBe('answer');
  });

  // A block that never closes means the model hit its ceiling mid-thought, so
  // everything after the opening tag is thinking. Cutting to the end is right:
  // there is no answer in a reply like that, and JSON found inside the reasoning
  // would be a discarded draft presented as the result.
  it('cuts to the end when the block never closes', () => {
    expect(stripReasoning('before<think>hmm {"a":1}').trim()).toBe('before');
  });

  it('leaves a reply with no thinking alone', () => {
    expect(stripReasoning('{"a":1}')).toBe('{"a":1}');
  });
});

describe('jsonValues', () => {
  it('finds a value wrapped in prose or a code fence', () => {
    expect(all('Sure:\n```json\n{"a":1}\n```', '{')).toEqual([{ a: 1 }]);
    expect(all('Here you go: [1,2] — enjoy', '[')).toEqual([[1, 2]]);
  });

  it('is not fooled by brackets inside strings', () => {
    expect(all('{"body":"a } and a { in prose"}', '{')).toEqual([{ body: 'a } and a { in prose' }]);
    expect(all('[{"text":"see [note]"}]', '[')).toEqual([[{ text: 'see [note]' }]]);
  });

  it('is not fooled by an escaped quote before a bracket', () => {
    expect(all('{"body":"he said \\"}\\" out loud"}', '{')).toEqual([{ body: 'he said "}" out loud' }]);
  });

  // The failure this file exists for. Reaching for the first opener finds the
  // one in the preamble; reaching for the last closer finds the one in the
  // sign-off. Both used to take the whole reply with them.
  it('skips a balanced run that is not JSON and keeps looking', () => {
    expect(all('angles [as requested]:\n[{"k":1}]', '[')).toEqual([[{ k: 1 }]]);
  });

  it('stops the value at its own closer, not at a later stray one', () => {
    expect(all('[{"k":1}]\nhope that helps [enjoy]', '[')).toEqual([[{ k: 1 }]]);
  });

  it('offers every candidate in order, so a caller can read past a wrong one', () => {
    expect(all('Top [1] pick:\n[{"k":2}]', '[')).toEqual([[1], [{ k: 2 }]]);
  });

  it('yields nothing when the value never closes', () => {
    expect(all('{"a":1', '{')).toEqual([]);
    expect(all('no json here', '{')).toEqual([]);
  });

  // The outer value comes first, which is what makes "take the first one" the
  // right rule for every caller. The nested objects are offered afterwards
  // because every opener is a candidate — harmless, since nothing reads on once
  // it has what it wants.
  it('handles nesting of its own bracket type, outermost first', () => {
    const found = all('{"a":{"b":{"c":1}}}', '{');
    expect(found[0]).toEqual({ a: { b: { c: 1 } } });
  });
});
