import { describe, it, expect } from 'vitest';
import { SUGGESTED_FEEDS, SUGGESTED_CATEGORIES, starterFeeds } from './suggestedFeeds';
import { canonicalFeedKey } from './feedUtils';

// None of this reaches the network — whether a feed is *live* is checked by hand
// when it goes on the list (see the header comment there). What's guarded here
// is the shape, which is what breaks silently when the list is edited.
describe('SUGGESTED_FEEDS', () => {
  it('files every feed under a declared category', () => {
    const known = new Set(SUGGESTED_CATEGORIES.map(c => c.name));
    const orphans = SUGGESTED_FEEDS.filter(f => !known.has(f.category));
    expect(orphans.map(f => `${f.name} (${f.category})`)).toEqual([]);
  });

  it('gives every declared category at least one feed', () => {
    const used = new Set(SUGGESTED_FEEDS.map(f => f.category));
    expect(SUGGESTED_CATEGORIES.filter(c => !used.has(c.name)).map(c => c.name)).toEqual([]);
  });

  // Canonically, not literally: two spellings of one address would collapse onto
  // the same Feed row and offer the reader the same publication twice.
  it('lists no feed twice', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of SUGGESTED_FEEDS) {
      const key = canonicalFeedKey(f.url);
      const first = seen.get(key);
      if (first) dupes.push(`${f.name} duplicates ${first}`); else seen.set(key, f.name);
    }
    expect(dupes).toEqual([]);
  });

  it('gives every feed an https address and a blurb', () => {
    const bad = SUGGESTED_FEEDS.filter(f => !f.url.startsWith('https://') || !f.blurb.trim() || !f.site.trim());
    expect(bad.map(f => f.name)).toEqual([]);
  });
});

describe('starterFeeds', () => {
  it('is a real subset — the point is that it is shorter', () => {
    expect(starterFeeds().length).toBeGreaterThan(0);
    expect(starterFeeds().length).toBeLessThan(SUGGESTED_FEEDS.length);
  });

  // A category that lost its starter would vanish from the first-run screen
  // rather than fall back, which is the failure this is here to prevent.
  it('covers every category, flagged or not', () => {
    const covered = new Set(starterFeeds().map(f => f.category));
    expect(SUGGESTED_CATEGORIES.filter(c => !covered.has(c.name)).map(c => c.name)).toEqual([]);
  });

  it('keeps the order of the full list', () => {
    const positions = starterFeeds().map(f => SUGGESTED_FEEDS.indexOf(f));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
