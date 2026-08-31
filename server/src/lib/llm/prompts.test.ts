import { describe, it, expect } from 'vitest';
import {
  splitSuggestions, titleFromQuestion, parseCondensed, parseProofread, parsePlan, parseIdeas,
  parseRelevance, SUGGESTION_MARKER,
} from './prompts';

describe('splitSuggestions', () => {
  it('peels the block off the end', () => {
    const raw = `The answer is 42.\n\n${SUGGESTION_MARKER}\n- Why 42?\n- What about 43?\n- Who asked?`;
    const { body, suggestions } = splitSuggestions(raw);
    expect(body).toBe('The answer is 42.');
    expect(suggestions).toEqual(['Why 42?', 'What about 43?', 'Who asked?']);
  });

  it('accepts asterisk and numbered bullets', () => {
    const raw = `Body.\n${SUGGESTION_MARKER}\n* One\n2. Two`;
    expect(splitSuggestions(raw).suggestions).toEqual(['One', 'Two']);
  });

  it('yields no suggestions when the model forgot the block', () => {
    // A missing row of buttons, not a broken answer.
    const { body, suggestions } = splitSuggestions('Just an answer.');
    expect(body).toBe('Just an answer.');
    expect(suggestions).toEqual([]);
  });

  it('caps at three and drops overlong lines', () => {
    const raw = `B.\n${SUGGESTION_MARKER}\n- a\n- b\n- c\n- d\n- ${'x'.repeat(200)}`;
    expect(splitSuggestions(raw).suggestions).toEqual(['a', 'b', 'c']);
  });

  it('strips the angle brackets when the model echoes the template', () => {
    const raw = `B.\n${SUGGESTION_MARKER}\n- <a direction to take this next>`;
    expect(splitSuggestions(raw).suggestions).toEqual(['a direction to take this next']);
  });

  it('splits on the last marker when one appears in the prose', () => {
    // A thread *about* this feature can quote the marker. The real block is the
    // one at the end, so the last occurrence wins.
    const raw = `Newt uses ${SUGGESTION_MARKER} as a fence.\n\n${SUGGESTION_MARKER}\n- Ask why`;
    const { body, suggestions } = splitSuggestions(raw);
    expect(body).toContain('as a fence');
    expect(suggestions).toEqual(['Ask why']);
  });

  it('drops lines written as offers from the assistant', () => {
    // These get sent verbatim as the reader's next message, so an offer only
    // the assistant could make is nonsense on click.
    const raw = `B.\n${SUGGESTION_MARKER}\n` +
      `- Paste one article's text and I'll dig in\n` +
      `- Ask me a factual question instead\n` +
      `- I can compare the two approaches\n` +
      `- What's the strongest case against this?`;
    expect(splitSuggestions(raw).suggestions).toEqual(["What's the strongest case against this?"]);
  });

  it('keeps reader-voice imperatives that share those words', () => {
    const raw = `B.\n${SUGGESTION_MARKER}\n` +
      `- Tell me about the 1977 case\n` +
      `- Compare this with the EU approach\n` +
      `- Where would I see this in practice?`;
    expect(splitSuggestions(raw).suggestions).toEqual([
      'Tell me about the 1977 case',
      'Compare this with the EU approach',
      'Where would I see this in practice?',
    ]);
  });
});

describe('titleFromQuestion', () => {
  it('keeps a short question whole', () => {
    expect(titleFromQuestion('ways AI is changing health')).toBe('ways AI is changing health');
  });

  it('collapses whitespace', () => {
    expect(titleFromQuestion('  what\n  about   this?  ')).toBe('what about this?');
  });

  it('cuts a long one at a word boundary', () => {
    const title = titleFromQuestion('a '.repeat(80));
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back rather than returning an empty title', () => {
    expect(titleFromQuestion('   ')).toBe('Untitled research');
  });
});

describe('parseCondensed', () => {
  it('reads a clean object', () => {
    const out = parseCondensed('{"title":"T","body":"# Hi","tags":["a","b"],"excerpt":"E"}');
    expect(out).toEqual({ title: 'T', body: '# Hi', tags: ['a', 'b'], excerpt: 'E' });
  });

  it('finds the object inside a fence and preamble', () => {
    // "Reply with only JSON" is a request, not a guarantee.
    const raw = 'Sure, here you go:\n```json\n{"title":"T","body":"B"}\n```';
    expect(parseCondensed(raw)?.title).toBe('T');
  });

  it('handles braces and escaped quotes inside the body', () => {
    // The reason extraction counts braces instead of using a regex.
    const raw = '{"title":"T","body":"if (x) { say(\\"hi\\"); }","tags":[]}';
    expect(parseCondensed(raw)?.body).toBe('if (x) { say("hi"); }');
  });

  it('rejects an object with no title or body', () => {
    expect(parseCondensed('{"tags":["a"]}')).toBeNull();
    expect(parseCondensed('no json here at all')).toBeNull();
  });
});

describe('parseProofread', () => {
  it('reads issues and drops incomplete ones', () => {
    const raw = JSON.stringify({
      summary: 'Reads well.',
      readability: 'General audience.',
      issues: [
        { kind: 'spelling', quote: 'teh', suggestion: 'the' },
        { kind: 'grammar', quote: '', suggestion: 'missing quote is unusable' },
        { quote: 'x', suggestion: 'y' },
      ],
    });
    const out = parseProofread(raw);
    expect(out?.summary).toBe('Reads well.');
    expect(out?.issues).toHaveLength(2);
    // An unlabelled finding is still a finding — filed under the vaguest kind.
    expect(out?.issues[1].kind).toBe('style');
  });

  it('maps an unrecognised kind rather than dropping the issue', () => {
    const raw = '{"issues":[{"kind":"vibes","quote":"q","suggestion":"s"}]}';
    expect(parseProofread(raw)?.issues[0].kind).toBe('style');
  });

  it('returns an empty list for a clean draft', () => {
    const out = parseProofread('{"summary":"Clean.","readability":"Fine.","issues":[]}');
    expect(out?.issues).toEqual([]);
  });

  it('returns null when there is no object', () => {
    expect(parseProofread('I could not read that.')).toBeNull();
  });
});

describe('parsePlan', () => {
  it('reads the search terms', () => {
    expect(parsePlan('{"search":true,"queries":["iOS 27","Apple battery"]}'))
      .toEqual(['iOS 27', 'Apple battery']);
  });

  it('returns nothing when the planner declines', () => {
    // "Don't search" is a real answer: searching the feed for "explain monads"
    // wastes a query and fills the context with whatever happens to rank.
    expect(parsePlan('{"search":false,"queries":[]}')).toEqual([]);
    expect(parsePlan('{"search":false,"queries":["monads"]}')).toEqual([]);
  });

  it('finds the object through a code fence', () => {
    expect(parsePlan('```json\n{"search":true,"queries":["nvidia earnings"]}\n```'))
      .toEqual(['nvidia earnings']);
  });

  it('caps at three and drops junk entries', () => {
    const raw = '{"search":true,"queries":["a","ok one","two","three","four",5,null]}';
    // "a" is a single character — too short to be a useful tsquery term.
    expect(parsePlan(raw)).toEqual(['ok one', 'two', 'three']);
  });

  it('drops an absurdly long query rather than sending it', () => {
    expect(parsePlan(`{"search":true,"queries":["${'x'.repeat(200)}"]}`)).toEqual([]);
  });

  it('returns nothing rather than throwing on nonsense', () => {
    // Every failure here has to be "no feed search", never a broken turn.
    expect(parsePlan('I would search for iOS 27')).toEqual([]);
    expect(parsePlan('')).toEqual([]);
    expect(parsePlan('{"search":true}')).toEqual([]);
  });
});

describe('parseIdeas', () => {
  const full = JSON.stringify({
    summary: 'A piece about feed readers.',
    angles: [
      { title: 'RSS never died', detail: 'It just stopped being a product.' },
      { title: 'The cost of the algorithm', detail: 'Who pays for a chronological feed.' },
    ],
    questions: ['How many feeds does a typical reader keep?'],
    related: [{ url: 'https://example.com/a', why: 'Has the subscriber numbers.' }],
  });

  it('reads a well-formed reply', () => {
    const report = parseIdeas(full)!;
    expect(report.summary).toBe('A piece about feed readers.');
    expect(report.angles).toHaveLength(2);
    expect(report.angles[0]).toEqual({ title: 'RSS never died', detail: 'It just stopped being a product.' });
    expect(report.questions).toEqual(['How many feeds does a typical reader keep?']);
    expect(report.related).toEqual([{ url: 'https://example.com/a', why: 'Has the subscriber numbers.' }]);
  });

  it('digs the object out of a fenced reply with preamble', () => {
    const raw = 'Here you go:\n```json\n' + full + '\n```';
    expect(parseIdeas(raw)?.angles).toHaveLength(2);
  });

  // The feed block is absent on most drafts, so an answer with angles and no
  // reading list is the ordinary case rather than a failure.
  it('accepts a reply with no related articles', () => {
    const report = parseIdeas('{"angles":[{"title":"One","detail":"Two"}]}')!;
    expect(report.related).toEqual([]);
    expect(report.questions).toEqual([]);
    expect(report.summary).toBe('');
  });

  it('returns null when there is no object at all', () => {
    expect(parseIdeas('I could not think of anything.')).toBeNull();
    expect(parseIdeas('{not json')).toBeNull();
  });

  // The shapes a smaller model sends when asked for {title, detail} pairs. All
  // of these used to empty the panel, which then told the author nothing came
  // back worth showing — a lie about an answer that did arrive.
  it('takes a bare string as an angle with no detail', () => {
    const report = parseIdeas('{"angles":["RSS never died","The cost of the algorithm"]}')!;
    expect(report.angles).toEqual([
      { title: 'RSS never died', detail: '' },
      { title: 'The cost of the algorithm', detail: '' },
    ]);
  });

  it('accepts the field names a model paraphrases into', () => {
    const report = parseIdeas('{"angles":[{"heading":"One","body":"Two"}]}')!;
    expect(report.angles).toEqual([{ title: 'One', detail: 'Two' }]);
  });

  it('skips a reasoning block on its way to the object', () => {
    expect(parseIdeas(`<think>{"angles": []} — no, better than that</think>\n${full}`)?.angles).toHaveLength(2);
  });

  it('keeps an angle that only came with detail, as its own heading', () => {
    const report = parseIdeas('{"angles":[{"detail":"Compare it with Usenet."}]}')!;
    expect(report.angles).toEqual([{ title: 'Compare it with Usenet.', detail: '' }]);
  });

  it('drops empty angles, blank questions and picks with no url', () => {
    const raw = JSON.stringify({
      angles: [{ title: '', detail: '' }, { title: 'Real' }],
      questions: ['  ', 'Real?'],
      related: [{ why: 'no url' }, { url: 'https://example.com/a' }],
    });
    const report = parseIdeas(raw)!;
    expect(report.angles).toEqual([{ title: 'Real', detail: '' }]);
    expect(report.questions).toEqual(['Real?']);
    expect(report.related).toEqual([{ url: 'https://example.com/a', why: '' }]);
  });

  it('caps the lists', () => {
    const raw = JSON.stringify({
      angles: Array.from({ length: 12 }, (_, i) => ({ title: `A${i}`, detail: 'd' })),
      questions: Array.from({ length: 12 }, (_, i) => `Q${i}`),
      related: Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/${i}`, why: 'w' })),
    });
    const report = parseIdeas(raw)!;
    expect(report.angles).toHaveLength(6);
    expect(report.questions).toHaveLength(6);
    expect(report.related).toHaveLength(8);
  });
});


describe('parseRelevance', () => {
  it('reads the kept numbers and their reasons', () => {
    const kept = parseRelevance('{"keep":[{"n":2,"why":"Has the figures."},{"n":3,"why":""}]}', 4)!;
    expect(kept).toEqual([{ n: 2, why: 'Has the figures.' }, { n: 3, why: '' }]);
  });

  // Keeping none is the answer a keyword search over a year of somebody's
  // reading often deserves, and it has to survive as an empty list rather than
  // collapsing into "the screen did not run".
  it('distinguishes keeping nothing from failing to answer', () => {
    expect(parseRelevance('{"keep":[]}', 3)).toEqual([]);
    expect(parseRelevance('None of these are relevant.', 3)).toBeNull();
    expect(parseRelevance('{"verdict":"no"}', 3)).toBeNull();
  });

  it('drops numbers that name no article', () => {
    const kept = parseRelevance('{"keep":[{"n":0},{"n":4},{"n":1},{"n":-2},{"n":1.5}]}', 3)!;
    expect(kept).toEqual([{ n: 1, why: '' }]);
  });

  it('drops a repeat rather than showing the article twice', () => {
    const kept = parseRelevance('{"keep":[{"n":1,"why":"First"},{"n":1,"why":"Again"}]}', 2)!;
    expect(kept).toEqual([{ n: 1, why: 'First' }]);
  });

  it('accepts a number sent as a string', () => {
    expect(parseRelevance('{"keep":[{"n":"2","why":"ok"}]}', 3)).toEqual([{ n: 2, why: 'ok' }]);
  });

  it('keeps the order it was given, most useful first', () => {
    const kept = parseRelevance('{"keep":[{"n":3},{"n":1}]}', 3)!;
    expect(kept.map(k => k.n)).toEqual([3, 1]);
  });
});
