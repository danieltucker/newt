import { describe, it, expect } from 'vitest';
import {
  SEARCH_PATH, isSearchPath, searchPathFor, parseSearchQuery, parseSearchFilter,
  isServerKind,
} from './searchUrl';

describe('isSearchPath', () => {
  it('matches the page and its trailing slash', () => {
    expect(isSearchPath('/search')).toBe(true);
    expect(isSearchPath('/search/')).toBe(true);
  });

  it('does not claim addresses beneath it', () => {
    // Nothing lives under /search today, and a helper that claimed the whole
    // subtree would quietly swallow anything added there later.
    expect(isSearchPath('/search/posts')).toBe(false);
    expect(isSearchPath('/searching')).toBe(false);
    expect(isSearchPath('/')).toBe(false);
  });
});

describe('searchPathFor', () => {
  it('puts the query in ?q=', () => {
    expect(searchPathFor('grid storage')).toBe('/search?q=grid+storage');
  });

  it('escapes punctuation rather than letting it into the URL', () => {
    expect(searchPathFor('a&b=c#d')).toBe(`${SEARCH_PATH}?q=a%26b%3Dc%23d`);
  });

  it('leaves the default filter out', () => {
    expect(searchPathFor('climate', 'all')).toBe('/search?q=climate');
  });

  it('writes down a filter the reader chose', () => {
    expect(searchPathFor('climate', 'posts')).toBe('/search?q=climate&kind=posts');
  });
});

describe('parseSearchQuery', () => {
  it('reads the query back out, whatever was in it', () => {
    expect(parseSearchQuery('?q=a%26b%3Dc%23d')).toBe('a&b=c#d');
  });

  it('trims, so a stray space is not a different search', () => {
    expect(parseSearchQuery('?q=+climate+')).toBe('climate');
  });

  it('returns empty for a bare /search', () => {
    expect(parseSearchQuery('')).toBe('');
    expect(parseSearchQuery('?kind=posts')).toBe('');
  });

  it('survives a round trip', () => {
    const q = 'schools closing — “winter 2026”';
    expect(parseSearchQuery(searchPathFor(q).slice(SEARCH_PATH.length))).toBe(q);
  });
});

describe('parseSearchFilter', () => {
  it('defaults to all', () => {
    expect(parseSearchFilter('?q=climate')).toBe('all');
  });

  it('reads a known tab', () => {
    expect(parseSearchFilter('?q=climate&kind=explores')).toBe('explores');
  });

  it('falls back to all for a name it does not know', () => {
    // A stale or hand-edited link should show results rather than an empty tab
    // that reads as "nothing found".
    expect(parseSearchFilter('?kind=widgets')).toBe('all');
    expect(parseSearchFilter('?kind=')).toBe('all');
  });
});

describe('isServerKind', () => {
  it('separates what the server answers from what the shell already holds', () => {
    expect(isServerKind('articles')).toBe(true);
    expect(isServerKind('posts')).toBe(true);
    expect(isServerKind('explores')).toBe(true);
    expect(isServerKind('bookmarks')).toBe(false);
    expect(isServerKind('notes')).toBe(false);
    expect(isServerKind('saved')).toBe(false);
    expect(isServerKind('all')).toBe(false);
  });
});
