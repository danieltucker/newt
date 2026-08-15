import { describe, it, expect } from 'vitest';
import { referenceCommandAt, referenceQuery, referenceSuggestions } from './referenceCommand';
import { EmbedData } from './noteEmbed';

function embed(title: string, url: string, source = 'example.com'): EmbedData {
  return { kind: 'article', href: url, url, title, source };
}

describe('referenceQuery', () => {
  it('reads the query after either prefix', () => {
    expect(referenceQuery('/reference climate')).toBe('climate');
    expect(referenceQuery('/ref climate')).toBe('climate');
  });

  it('treats the bare command as an empty query, not as no command', () => {
    // The difference decides whether the picker opens: '' is "waiting for you
    // to type", null is "this is an ordinary question".
    expect(referenceQuery('/reference')).toBe('');
    expect(referenceQuery('/ref')).toBe('');
    expect(referenceQuery('/reference ')).toBe('');
  });

  it('returns null for anything that is not the command', () => {
    expect(referenceQuery('what does this mean?')).toBeNull();
    expect(referenceQuery('')).toBeNull();
    // The other slash commands belong to the search bar's table and must not be
    // swallowed by a prefix test that is too eager.
    expect(referenceQuery('/g climate')).toBeNull();
    expect(referenceQuery('/ask climate')).toBeNull();
  });

  it('does not match a word that merely starts with the prefix', () => {
    // '/references' and '/refactor' are not this command, and answering them
    // with an article picker would be a worse mistake than doing nothing.
    expect(referenceQuery('/references')).toBeNull();
    expect(referenceQuery('/refactor the thing')).toBeNull();
  });

  it('ignores leading whitespace, which a composer collects easily', () => {
    expect(referenceQuery('  /reference climate')).toBe('climate');
  });

  it('keeps the whole query, spaces and all', () => {
    expect(referenceQuery('/reference the sky at night')).toBe('the sky at night');
  });
});

describe('referenceCommandAt', () => {
  it('finds the command at the end of a half-written question', () => {
    // The reported case: the thought comes first, the citation is reached for
    // partway through, and the picker has to open anyway.
    expect(referenceCommandAt('can you tell me what caused /reference'))
      .toEqual({ query: '', rest: 'can you tell me what caused' });
  });

  it('reads what is typed after it as the search', () => {
    expect(referenceCommandAt('what caused /reference the blackout'))
      .toEqual({ query: 'the blackout', rest: 'what caused' });
  });

  it('still handles the command on its own', () => {
    expect(referenceCommandAt('/reference climate')).toEqual({ query: 'climate', rest: '' });
    expect(referenceCommandAt('/ref')).toEqual({ query: '', rest: '' });
  });

  it('takes the last one — an earlier one is already a chip', () => {
    expect(referenceCommandAt('/reference done now /ref more'))
      .toEqual({ query: 'more', rest: '/reference done now' });
    // …whichever of the two spellings came last.
    expect(referenceCommandAt('/ref done now /reference more'))
      .toEqual({ query: 'more', rest: '/ref done now' });
  });

  it('needs the prefix to stand alone as a word', () => {
    expect(referenceCommandAt('why /refactor now')).toBeNull();
    // At index 0 specifically: lastIndexOf clamps a negative fromIndex to 0, so
    // walking back from here used to return the same match for ever.
    expect(referenceCommandAt('/refactor the thing')).toBeNull();
    expect(referenceCommandAt('/references')).toBeNull();
    expect(referenceCommandAt('see the /references section')).toBeNull();
    // A URL with the word in its path is not somebody typing a command.
    expect(referenceCommandAt('what about https://x.test/ref/1')).toBeNull();
  });

  it('returns null for an ordinary question', () => {
    expect(referenceCommandAt('what caused the blackout?')).toBeNull();
    expect(referenceCommandAt('')).toBeNull();
  });

  it('falls back to an earlier prefix when the last one is part of a word', () => {
    expect(referenceCommandAt('/ref power and /refactor'))
      .toEqual({ query: 'power and /refactor', rest: '' });
  });
});

describe('referenceSuggestions', () => {
  const library = [
    embed('Climate report 2025', 'https://x.test/climate'),
    embed('A newt in winter', 'https://x.test/newt'),
  ];
  const river = [
    { title: 'Climate talks stall', url: 'https://y.test/talks', source: 'y.test' },
  ];

  it('offers the library before the river', () => {
    expect(referenceSuggestions('climate', library, river).map(s => s.url))
      .toEqual(['https://x.test/climate', 'https://y.test/talks']);
  });

  it('offers nothing until something is typed', () => {
    // The bare command is a real state - the picker prompts for a headline
    // rather than tipping the whole library into a six-row list.
    expect(referenceSuggestions('', library, river)).toEqual([]);
    expect(referenceSuggestions('   ', library, river)).toEqual([]);
  });

  it('drops what is already attached', () => {
    const out = referenceSuggestions('climate', library, river, ['https://x.test/climate']);
    expect(out.map(s => s.url)).toEqual(['https://y.test/talks']);
  });

  it('drops a duplicate the two corpora both hold', () => {
    // The same article saved *and* carried by a feed is one row, not two.
    const both = [{ title: 'Climate report 2025', url: 'https://x.test/climate', source: 'x.test' }];
    expect(referenceSuggestions('climate', library, both)).toHaveLength(1);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => (
      { title: `Climate ${i}`, url: `https://y.test/${i}`, source: 'y.test' }
    ));
    expect(referenceSuggestions('climate', [], many, [], 6)).toHaveLength(6);
  });
});
