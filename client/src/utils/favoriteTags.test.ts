import { describe, it, expect } from 'vitest';
import {
  tagTokens, tagKey, prepareFavorites, tagMatchesFavorite,
  favoritesFor, isFavoriteTag, toggleFavorite, hasFavorite, coveringFavorites,
} from './favoriteTags';

const prep = (...f: string[]) => prepareFavorites(f);
const matches = (tag: string, favorite: string) =>
  tagMatchesFavorite(tag, prepareFavorites([favorite])[0]);

describe('tagTokens', () => {
  it('lowercases and splits on punctuation', () => {
    expect(tagTokens('Apple Inc.')).toEqual(['apple', 'inc']);
    expect(tagTokens('apple-tv')).toEqual(['apple', 'tv']);
    expect(tagTokens('Apple/TV+')).toEqual(['apple', 'tv']);
    expect(tagTokens('  Apple   News  ')).toEqual(['apple', 'news']);
  });

  it('keeps digits, which tags lean on', () => {
    expect(tagTokens('Web3')).toEqual(['web3']);
    expect(tagTokens('iOS 18')).toEqual(['ios', '18']);
  });

  it('folds accents rather than splitting the word around them', () => {
    expect(tagTokens('Pokémon')).toEqual(['pokemon']);
    expect(tagTokens('café culture')).toEqual(['cafe', 'culture']);
  });

  it('keeps non-Latin scripts, which would otherwise vanish', () => {
    expect(tagTokens('Новости')).toEqual(['новости']);
    expect(tagTokens('日本 ニュース')).toEqual(['日本', 'ニュース']);
  });

  it('yields nothing for a tag with no word characters', () => {
    expect(tagTokens('')).toEqual([]);
    expect(tagTokens('  -  ')).toEqual([]);
  });
});

describe('tagMatchesFavorite - the cases that motivated tokens', () => {
  it('matches a favorite that leads or appears inside a longer tag', () => {
    expect(matches('Apple News', 'Apple')).toBe(true);
    expect(matches('Apple Updates', 'Apple')).toBe(true);
    expect(matches('apple-tv', 'Apple')).toBe(true);
    expect(matches('Everything Apple', 'Apple')).toBe(true);
    expect(matches('Apple', 'Apple')).toBe(true);
  });

  // The whole reason this isn't String.includes.
  it('does not match a favorite buried inside a word', () => {
    expect(matches('Snapple', 'Apple')).toBe(false);
    expect(matches('Pineapple', 'Apple')).toBe(false);
    expect(matches("Applebee's", 'Apple')).toBe(false);
  });

  it('keeps short favorites from matching everything', () => {
    for (const tag of ['Retail', 'Supply Chain', 'Air Travel', 'Email', 'Said']) {
      expect(matches(tag, 'AI')).toBe(false);
    }
    expect(matches('AI', 'AI')).toBe(true);
    expect(matches('AI Research', 'AI')).toBe(true);
    expect(matches('Generative AI', 'AI')).toBe(true);
  });

  it('keeps "art" out of Smart Home and Startup', () => {
    expect(matches('Smart Home', 'art')).toBe(false);
    expect(matches('Startups', 'art')).toBe(false);
    expect(matches('Art History', 'art')).toBe(true);
  });

  it('requires multi-word favorites to be adjacent and in order', () => {
    expect(matches('Machine Learning Weekly', 'machine learning')).toBe(true);
    expect(matches('machine-learning', 'Machine Learning')).toBe(true);
    expect(matches('Learning Machines', 'machine learning')).toBe(false);
    expect(matches('Machine Vision and Learning', 'machine learning')).toBe(false);
  });

  it('never matches a tag shorter than the favorite', () => {
    expect(matches('Apple', 'Apple News')).toBe(false);
  });

  it('ignores case and punctuation on both sides', () => {
    expect(matches('APPLE NEWS', 'apple')).toBe(true);
    expect(matches('apple.news', 'APPLE')).toBe(true);
  });
});

describe('prepareFavorites', () => {
  it('drops blanks and tags with nothing to match on', () => {
    expect(prep('Apple', '', '  ', '-').map(f => f.label)).toEqual(['Apple']);
  });

  it('collapses favorites that canonicalize the same, keeping the first', () => {
    expect(prep('Apple News', 'apple-news', 'APPLE  NEWS').map(f => f.label))
      .toEqual(['Apple News']);
  });

  it('keeps the raw label for display', () => {
    expect(prep('Apple TV+')[0]).toEqual({ label: 'Apple TV+', tokens: ['apple', 'tv'] });
  });
});

describe('favoritesFor', () => {
  const favorites = prep('Apple', 'machine learning', 'AI');

  it('names which favorites fired, in the order they were favorited', () => {
    expect(favoritesFor(['Apple News', 'AI Research'], favorites)).toEqual(['Apple', 'AI']);
  });

  it('reports a favorite once however many tags hit it', () => {
    expect(favoritesFor(['Apple News', 'Apple Updates', 'apple-tv'], favorites)).toEqual(['Apple']);
  });

  it('is empty when nothing matches - callers read that as "render normally"', () => {
    expect(favoritesFor(['Retail', 'Snapple'], favorites)).toEqual([]);
  });

  it('short-circuits on empty input', () => {
    expect(favoritesFor([], favorites)).toEqual([]);
    expect(favoritesFor(['Apple'], [])).toEqual([]);
  });
});

describe('isFavoriteTag', () => {
  it('is true for a tag covered by a broader favorite', () => {
    expect(isFavoriteTag('Apple News', prep('Apple'))).toBe(true);
    expect(isFavoriteTag('Retail', prep('AI'))).toBe(false);
  });
});

describe('coveringFavorites', () => {
  it('names the exact favorite and any broader one', () => {
    expect(coveringFavorites(['Apple'], 'Apple News')).toEqual(['Apple']);
    expect(coveringFavorites(['Apple News'], 'Apple News')).toEqual(['Apple News']);
    expect(coveringFavorites(['Apple', 'apple news'], 'Apple News')).toEqual(['Apple', 'apple news']);
  });

  it('does not treat a narrower favorite as covering', () => {
    expect(coveringFavorites(['Apple News'], 'Apple')).toEqual([]);
  });

  it('is empty for a tag with nothing to match on', () => {
    expect(coveringFavorites(['Apple'], '  ')).toEqual([]);
  });
});

describe('toggleFavorite / hasFavorite', () => {
  it('adds a tag that is not there, keeping it as typed', () => {
    expect(toggleFavorite([], 'Apple News')).toEqual(['Apple News']);
    expect(toggleFavorite(['AI'], '  Apple  ')).toEqual(['AI', 'Apple']);
  });

  it('removes an equivalent tag rather than adding a near-duplicate', () => {
    expect(toggleFavorite(['apple-news'], 'Apple News')).toEqual([]);
    expect(toggleFavorite(['AI', 'apple-news'], 'APPLE NEWS')).toEqual(['AI']);
  });

  // Otherwise clicking a starred chip would add a redundant favorite and leave
  // the star on, which reads as a broken button.
  it('unstarring a covered tag drops the broader favorite that starred it', () => {
    expect(toggleFavorite(['Apple'], 'Apple News')).toEqual([]);
    expect(toggleFavorite(['AI', 'Apple'], 'apple-tv')).toEqual(['AI']);
  });

  it('drops every covering favorite, so one click always clears the star', () => {
    expect(toggleFavorite(['Apple', 'apple news', 'AI'], 'Apple News')).toEqual(['AI']);
  });

  it('refuses a tag with nothing to match on', () => {
    expect(toggleFavorite(['AI'], '  ')).toEqual(['AI']);
  });

  it('hasFavorite is exact, not coverage - used by the settings list', () => {
    expect(hasFavorite(['Apple'], 'Apple News')).toBe(false);
    expect(hasFavorite(['Apple'], 'apple')).toBe(true);
    expect(hasFavorite(['Apple'], '')).toBe(false);
  });
});
