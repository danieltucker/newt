import { describe, it, expect } from 'vitest';
import { sharedExplorePathFor, parseSharedExplorePath } from './exploreShareUrl';

// /e/<id> is the read-only view of a shared thread. Its whole job is to be
// distinguishable from /explore/<id>, which is the owner's workspace and is
// signed-in only - handing somebody the wrong one sends them to a sign-in wall
// instead of the conversation they were sent.
describe('shared explore paths', () => {
  it('round-trips a thread id', () => {
    const id = 'clx1a2b3c4d5e6f7g8h9';
    expect(parseSharedExplorePath(sharedExplorePathFor(id))).toBe(id);
  });

  it('tolerates a trailing slash', () => {
    expect(parseSharedExplorePath('/e/abc123/')).toBe('abc123');
  });

  it('is not confused with the owner-only Explore route', () => {
    expect(parseSharedExplorePath('/explore/abc123')).toBeNull();
    expect(parseSharedExplorePath('/explore')).toBeNull();
  });

  it('rejects paths that are not a share link', () => {
    for (const p of ['/', '/e', '/e/', '/a/abc', '/u/someone', '/eggs/abc']) {
      expect(parseSharedExplorePath(p)).toBeNull();
    }
  });

  // The id goes into an API path, so anything that isn't a plain cuid-shaped
  // segment is refused here rather than sent to the server to be refused there.
  it('rejects a segment that is not an id', () => {
    expect(parseSharedExplorePath('/e/abc/def')).toBeNull();
    expect(parseSharedExplorePath('/e/../../etc')).toBeNull();
    expect(parseSharedExplorePath('/e/%2e%2e%2fadmin')).toBeNull();
  });
});
