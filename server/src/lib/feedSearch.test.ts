import { describe, it, expect } from 'vitest';
import { terms, toTsQuery } from './feedSearch';

describe('terms', () => {
  it('splits a plain query into words', () => {
    expect(terms('two schools closing')).toEqual(['two', 'schools', 'closing']);
  });

  it('keeps words in other alphabets whole', () => {
    expect(terms('café Ürümqi 東京')).toEqual(['café', 'ürümqi', '東京']);
  });

  it('folds possessives rather than splitting on them', () => {
    expect(terms("council's vote")).toEqual(['councils', 'vote']);
    expect(terms('council’s vote')).toEqual(['councils', 'vote']);
  });

  it('drops punctuation without leaving empty terms', () => {
    expect(terms('  schools -- closing!! ')).toEqual(['schools', 'closing']);
  });

  it('caps the term count and the length of each', () => {
    expect(terms('a b c d e f g h i j k')).toHaveLength(8);
    expect(terms('x'.repeat(200))[0]).toHaveLength(40);
  });
});

// The point of these: a tsquery operator arriving from the input would either
// error the query or change what it means. Nothing here should survive as syntax.
describe('toTsQuery', () => {
  it('requires every term and prefixes the last', () => {
    expect(toTsQuery('two schools clos')).toBe('two & schools & clos:*');
  });

  it('prefixes a single term', () => {
    expect(toTsQuery('school')).toBe('school:*');
  });

  it('strips tsquery operators instead of honouring them', () => {
    expect(toTsQuery('schools & closing')).toBe('schools & closing:*');
    expect(toTsQuery('schools | closing')).toBe('schools & closing:*');
    expect(toTsQuery('!schools')).toBe('schools:*');
    expect(toTsQuery('(a <-> b)')).toBe('a & b:*');
    expect(toTsQuery("x'); DROP TABLE \"FeedItem\"; --")).toBe('x & drop & table & feeditem:*');
  });

  it('returns null when nothing usable is left', () => {
    expect(toTsQuery('')).toBeNull();
    expect(toTsQuery('   ')).toBeNull();
    expect(toTsQuery('!!! &&& ---')).toBeNull();
  });
});

// `any` is what the research planner searches with. AND against a vector of
// headline plus teaser is close to unmatchable for a multi-word query, which is
// the whole reason the mode exists.
describe('toTsQuery in any mode', () => {
  it('accepts any term rather than requiring all of them', () => {
    expect(toTsQuery('apple battery life', 'any')).toBe('apple:* | battery:* | life:*');
  });

  it('prefixes every term, not just the last', () => {
    // The stemming gap `:*` closes — closing vs closure — is not specific to the
    // last word, and in OR mode a loose prefix costs a low-ranked row, not the
    // whole result set.
    expect(toTsQuery('closing schools', 'any')).toBe('closing:* | schools:*');
  });

  it('leaves very short terms exact', () => {
    // `ai:*` would match aid, aim and air, and with no other term ANDed against
    // it there is nothing to filter those back out.
    expect(toTsQuery('ai chips', 'any')).toBe('ai | chips:*');
  });

  it('strips operators the same way as all mode', () => {
    expect(toTsQuery('nvidia | !earnings', 'any')).toBe('nvidia:* | earnings:*');
    expect(toTsQuery("x'); DROP TABLE \"FeedItem\"; --", 'any'))
      .toBe('x | drop:* | table:* | feeditem:*');
  });

  it('returns null when nothing usable is left', () => {
    expect(toTsQuery('', 'any')).toBeNull();
    expect(toTsQuery('!!! &&& ---', 'any')).toBeNull();
  });

  it('defaults to all mode when no mode is given', () => {
    expect(toTsQuery('two schools')).toBe(toTsQuery('two schools', 'all'));
  });
});
