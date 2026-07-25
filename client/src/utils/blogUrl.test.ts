import { describe, it, expect } from 'vitest';
import { blogPathFor, parseBlogPath, blogEditPathFor, parseBlogEditPath } from './blogUrl';
import { parseProfilePath } from './profileUrl';

describe('blog post URL round-trip', () => {
  it('builds a path and parses it back', () => {
    const path = blogPathFor('alice', 'hello-world-2026-07-24');
    expect(path).toBe('/u/alice/hello-world-2026-07-24');
    expect(parseBlogPath(path)).toEqual({ username: 'alice', slug: 'hello-world-2026-07-24' });
  });

  it('round-trips a username needing encoding', () => {
    for (const u of ['user with space', 'café', 'a/b']) {
      expect(parseBlogPath(blogPathFor(u, 'x-2026-07-24'))?.username).toBe(u);
    }
  });

  it('tolerates a trailing slash', () => {
    expect(parseBlogPath('/u/alice/post-2026-07-24/')).toEqual({
      username: 'alice',
      slug: 'post-2026-07-24',
    });
  });

  it('returns null for a bare profile path', () => {
    expect(parseBlogPath('/u/alice')).toBeNull();
    expect(parseBlogPath('/u/alice/')).toBeNull();
  });

  it('returns null for non-blog paths', () => {
    expect(parseBlogPath('/')).toBeNull();
    expect(parseBlogPath('/a/abc')).toBeNull();
    expect(parseBlogPath('/u/')).toBeNull();
    expect(parseBlogPath('/u/alice/post/extra')).toBeNull();
  });
});

// The two parsers share the /u/ prefix, so exactly one of them must claim any
// given path. This is the check that a post URL can't render as a profile.
describe('profile and blog paths do not overlap', () => {
  it('routes a single segment to the profile only', () => {
    expect(parseProfilePath('/u/alice')).toBe('alice');
    expect(parseBlogPath('/u/alice')).toBeNull();
  });

  it('routes two segments to the post only', () => {
    expect(parseProfilePath('/u/alice/hello-2026-07-24')).toBeNull();
    expect(parseBlogPath('/u/alice/hello-2026-07-24')).toEqual({
      username: 'alice',
      slug: 'hello-2026-07-24',
    });
  });
});

describe('blog editor paths', () => {
  it('round-trips a post id', () => {
    expect(parseBlogEditPath(blogEditPathFor('abc123'))).toBe('abc123');
  });

  it('returns null for the list route and non-editor paths', () => {
    expect(parseBlogEditPath('/blog')).toBeNull();
    expect(parseBlogEditPath('/blog/')).toBeNull();
    expect(parseBlogEditPath('/settings')).toBeNull();
  });

  it('reads "new" as an id so the caller can special-case it', () => {
    expect(parseBlogEditPath('/blog/new')).toBe('new');
  });
});
