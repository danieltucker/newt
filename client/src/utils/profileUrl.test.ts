import { describe, it, expect } from 'vitest';
import { profilePathFor, parseProfilePath } from './profileUrl';

describe('profile URL round-trip', () => {
  const usernames = ['alice', 'Bob_99', 'user with space', 'café', 'a/b'];

  it('builds a path and parses it back to the same username', () => {
    for (const u of usernames) {
      expect(parseProfilePath(profilePathFor(u))).toBe(u);
    }
  });

  it('tolerates a trailing slash', () => {
    expect(parseProfilePath('/u/alice/')).toBe('alice');
  });

  it('returns null for non-profile or empty paths', () => {
    expect(parseProfilePath('/')).toBeNull();
    expect(parseProfilePath('/settings')).toBeNull();
    expect(parseProfilePath('/a/abc')).toBeNull();
    expect(parseProfilePath('/u/')).toBeNull();
  });

  // A blog post lives at /u/<username>/<slug>. If this matched, every post URL
  // would render its author's profile instead of the post.
  it('does not claim blog post paths', () => {
    expect(parseProfilePath('/u/alice/hello-world-2026-07-24')).toBeNull();
    expect(parseProfilePath('/u/alice/hello-world-2026-07-24/')).toBeNull();
  });
});
