import { describe, it, expect } from 'vitest';
import {
  isExplorePath, parseExplorePath, explorePathFor, exploreArticlePath, exploreAskPath,
  isLegacyResearchPath, explorePathFromLegacy,
} from './researchUrl';

describe('isExplorePath', () => {
  it('matches the index and a thread', () => {
    expect(isExplorePath('/explore')).toBe(true);
    expect(isExplorePath('/explore/')).toBe(true);
    expect(isExplorePath('/explore/abc123')).toBe(true);
  });

  it('does not match a neighbouring path', () => {
    // The prefix test must not claim /explorers or an unrelated route.
    expect(isExplorePath('/explorers')).toBe(false);
    expect(isExplorePath('/blog')).toBe(false);
    expect(isExplorePath('/')).toBe(false);
  });

  it('does not claim the old /research address', () => {
    // That one redirects rather than rendering — see App.
    expect(isExplorePath('/research')).toBe(false);
    expect(isExplorePath('/research/abc123')).toBe(false);
  });
});

describe('parseExplorePath', () => {
  it('reads the thread id', () => {
    expect(parseExplorePath('/explore/abc123')).toBe('abc123');
    expect(parseExplorePath('/explore/abc123/')).toBe('abc123');
  });

  it('returns null for the bare index', () => {
    expect(parseExplorePath('/explore')).toBeNull();
    expect(parseExplorePath('/explore/')).toBeNull();
  });

  it('round-trips an id that needs encoding', () => {
    const id = 'a b/c';
    expect(parseExplorePath(explorePathFor(id))).toBe(id);
  });
});

// Research became Explore in v1.17.0. Thread links were shareable from the day
// they existed, so the old address has to keep landing on the same thread.
describe('the old /research address', () => {
  it('is recognised as legacy, index and thread alike', () => {
    expect(isLegacyResearchPath('/research')).toBe(true);
    expect(isLegacyResearchPath('/research/abc123')).toBe(true);
    expect(isLegacyResearchPath('/researchers')).toBe(false);
    expect(isLegacyResearchPath('/explore')).toBe(false);
  });

  it('maps to the same thread under the new name', () => {
    expect(explorePathFromLegacy('/research/abc123')).toBe('/explore/abc123');
    expect(parseExplorePath(explorePathFromLegacy('/research/abc123'))).toBe('abc123');
  });

  it('collapses the bare index, with or without its trailing slash', () => {
    expect(explorePathFromLegacy('/research')).toBe('/explore');
    expect(explorePathFromLegacy('/research/')).toBe('/explore');
  });

  it('carries the query string over', () => {
    // A seeded link (?url=, ?q=) is exactly the kind that gets shared, so
    // dropping the query would redirect to an empty page.
    expect(explorePathFromLegacy('/research', '?url=https%3A%2F%2Fx.test%2Fa'))
      .toBe('/explore?url=https%3A%2F%2Fx.test%2Fa');
  });
});

describe('exploreArticlePath', () => {
  it('carries the url, and the title when there is one', () => {
    const params = new URLSearchParams(exploreArticlePath('https://x.test/a', 'A Title').split('?')[1]);
    expect(params.get('url')).toBe('https://x.test/a');
    expect(params.get('title')).toBe('A Title');
  });

  it('omits the title rather than sending an empty one', () => {
    expect(exploreArticlePath('https://x.test/a')).not.toContain('title=');
  });
});

describe('exploreAskPath', () => {
  it('carries the question, and the url when there is one', () => {
    const params = new URLSearchParams(exploreAskPath('why is the sky blue?', 'https://x.test/a').split('?')[1]);
    expect(params.get('q')).toBe('why is the sky blue?');
    expect(params.get('url')).toBe('https://x.test/a');
  });

  it('works without an article — a question away from one is still a question', () => {
    const path = exploreAskPath('what is a newt?');
    expect(new URLSearchParams(path.split('?')[1]).get('q')).toBe('what is a newt?');
    expect(path).not.toContain('url=');
  });

  it('encodes a question containing separators', () => {
    // A question with & or = in it must not split into extra params.
    const path = exploreAskPath('a=b & c?');
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('q')).toBe('a=b & c?');
    expect([...params.keys()]).toEqual(['q']);
  });
});
