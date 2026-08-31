import { describe, it, expect } from 'vitest';
import {
  parseScreening, cleanTitle, VERDICTS, parseRelations,
  EXPLORE_PROMPT_DEFAULT, MODERATE_PROMPT_DEFAULT,
} from './prompts';

describe('parseScreening', () => {
  it('reads a well-formed verdict', () => {
    const out = parseScreening('{"verdict":"hide","category":"abuse","confidence":0.91,"reason":"Calls the author a name."}');
    expect(out).toEqual({
      verdict: 'hide', category: 'abuse', confidence: 0.91, reason: 'Calls the author a name.',
    });
  });

  it('accepts every verdict in the set', () => {
    for (const v of VERDICTS) {
      expect(parseScreening(`{"verdict":"${v}"}`)?.verdict).toBe(v);
    }
  });

  it('digs the object out of a fence, a preamble and a reasoning block', () => {
    expect(parseScreening('```json\n{"verdict":"allow"}\n```')?.verdict).toBe('allow');
    expect(parseScreening('Here is my judgement:\n{"verdict":"allow"}')?.verdict).toBe('allow');
    expect(parseScreening('<think>{"verdict":"hide"} no wait</think>{"verdict":"allow"}')?.verdict).toBe('allow');
  });

  it('accepts a verdict in the wrong case or padded', () => {
    expect(parseScreening('{"verdict":"  HIDE "}')?.verdict).toBe('hide');
  });

  // The single confusion a moderation log must not contain: an endpoint
  // returning gibberish must not look like an endpoint that approved the
  // comment. Null makes the caller record a *failed* job.
  describe('returns null rather than defaulting to allow', () => {
    it('for a reply with no JSON at all', () => {
      expect(parseScreening('I think this comment is fine.')).toBeNull();
    });

    it('for JSON with no recognisable verdict', () => {
      expect(parseScreening('{"ok":true}')).toBeNull();
      expect(parseScreening('{"verdict":"delete"}')).toBeNull();
      expect(parseScreening('{"verdict":"ban"}')).toBeNull();
    });

    it('for a truncated reply', () => {
      expect(parseScreening('{"verdict":"allow"')).toBeNull();
    });
  });

  // There is deliberately no `delete` verdict and no `ban`. The strongest
  // automated action is a reversible hide.
  it('has no destructive verdict to return', () => {
    expect(VERDICTS).toEqual(['allow', 'review', 'hide']);
  });

  it('drops an unrecognised category rather than failing the row', () => {
    const out = parseScreening('{"verdict":"hide","category":"rudeness"}');
    expect(out?.verdict).toBe('hide');
    expect(out?.category).toBe('');
  });

  describe('confidence', () => {
    it('clamps to 0..1', () => {
      expect(parseScreening('{"verdict":"allow","confidence":5}')?.confidence).toBe(1);
      expect(parseScreening('{"verdict":"allow","confidence":-2}')?.confidence).toBe(0);
    });

    // Sorted ascending in the queue, so an unscored row surfaces for a human
    // rather than passing as a certainty.
    it('reads a missing or unparseable value as 0', () => {
      expect(parseScreening('{"verdict":"allow"}')?.confidence).toBe(0);
      expect(parseScreening('{"verdict":"allow","confidence":"high"}')?.confidence).toBe(0);
    });

    it('accepts a number sent as a string', () => {
      expect(parseScreening('{"verdict":"allow","confidence":"0.5"}')?.confidence).toBe(0.5);
    });
  });
});

describe('cleanTitle', () => {
  it('strips the ways a model decorates a title', () => {
    expect(cleanTitle('"Edge caching and the latency claim"', 'x')).toBe('Edge caching and the latency claim');
    expect(cleanTitle('Title: Edge caching', 'x')).toBe('Edge caching');
    expect(cleanTitle('Edge caching.', 'x')).toBe('Edge caching');
  });

  it('takes the first non-empty line, ignoring what follows', () => {
    expect(cleanTitle('\n\nEdge caching\n\nHope that helps!', 'x')).toBe('Edge caching');
  });

  it('falls back when there is nothing usable', () => {
    expect(cleanTitle('', 'The article title')).toBe('The article title');
    expect(cleanTitle('   ', 'The article title')).toBe('The article title');
  });

  it('caps the length', () => {
    expect(cleanTitle('y'.repeat(400), 'x')).toHaveLength(120);
  });
});

// The defaults are what the admin form pre-fills and what the route writes into
// a row when the box is left alone (see promptToStore in routes/adminAi). That
// makes them a stored value rather than a runtime fallback, so the properties
// the parsers depend on have to actually be in the text.
describe('default prompts are usable as stored values', () => {
  it('are non-empty and substantial enough to be worth storing', () => {
    expect(EXPLORE_PROMPT_DEFAULT.length).toBeGreaterThan(200);
    expect(MODERATE_PROMPT_DEFAULT.length).toBeGreaterThan(200);
  });

  // parseScreening only accepts these three, so a default that invited any
  // other word would fail every job on a model that obeyed it.
  it('the moderation default names exactly the three verdicts', () => {
    for (const v of VERDICTS) expect(MODERATE_PROMPT_DEFAULT).toContain(`"${v}"`);
    expect(MODERATE_PROMPT_DEFAULT).not.toContain('"delete"');
    expect(MODERATE_PROMPT_DEFAULT).not.toContain('"ban"');
  });

  // The explore body is split on this heading by nothing today, but it is the
  // shape the prompt promises and the thing a reader sees, so a silent edit to
  // one half should fail here rather than in production.
  it('the explore default asks for the questions heading it documents', () => {
    expect(EXPLORE_PROMPT_DEFAULT).toContain('## Worth asking');
  });
});

describe('parseRelations', () => {
  const N = 6;

  it('reads well-formed groups', () => {
    const out = parseRelations('{"groups":[{"items":[1,4],"reason":"Both cover the EU AI Act vote."}]}', N);
    expect(out).toEqual([{ items: [1, 4], reason: 'Both cover the EU AI Act vote.' }]);
  });

  it('digs the object out of a fence and a reasoning block', () => {
    expect(parseRelations('```json\n{"groups":[{"items":[2,3]}]}\n```', N)).toHaveLength(1);
    expect(parseRelations('<think>maybe [1]</think>{"groups":[{"items":[2,3]}]}', N)).toHaveLength(1);
  });

  // An empty list is the *correct* answer for most runs, and the prompt asks
  // for it. It must not be mistaken for a parse failure that keeps searching.
  it('treats an explicit empty list as an answer', () => {
    expect(parseRelations('{"groups":[]}', N)).toEqual([]);
  });

  it('returns nothing for an unreadable reply', () => {
    expect(parseRelations('I found no matches.', N)).toEqual([]);
    expect(parseRelations('{"groups":', N)).toEqual([]);
  });

  // An out-of-range index would relate the wrong two articles, or throw. The
  // candidate list is the authority, never the model.
  describe('bounds every index against the candidate count', () => {
    it('drops indexes outside the list', () => {
      expect(parseRelations('{"groups":[{"items":[1,99]}]}', N)).toEqual([]);
      expect(parseRelations('{"groups":[{"items":[0,1]}]}', N)).toEqual([]);
      expect(parseRelations('{"groups":[{"items":[-3,2]}]}', N)).toEqual([]);
    });

    it('keeps a group that still has two valid members', () => {
      expect(parseRelations('{"groups":[{"items":[1,2,99]}]}', N)[0].items).toEqual([1, 2]);
    });

    it('drops a group left with fewer than two', () => {
      expect(parseRelations('{"groups":[{"items":[1]}]}', N)).toEqual([]);
      expect(parseRelations('{"groups":[{"items":[1,1]}]}', N)).toEqual([]);
    });
  });

  it('deduplicates and sorts members', () => {
    expect(parseRelations('{"groups":[{"items":[4,2,4,2,1]}]}', N)[0].items).toEqual([1, 2, 4]);
  });

  it('accepts numbers sent as strings', () => {
    expect(parseRelations('{"groups":[{"items":["1","3"]}]}', N)[0].items).toEqual([1, 3]);
  });
});
