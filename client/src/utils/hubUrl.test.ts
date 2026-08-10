import { describe, it, expect } from 'vitest';
import { tagPathFor, parseTagPath, isRecentPath, RECENT_PATH } from './hubUrl';

describe('tag paths', () => {
  it('round-trips a tag', () => {
    expect(parseTagPath(tagPathFor('editors'))).toBe('editors');
  });

  it('encodes a tag that would otherwise change the path', () => {
    expect(tagPathFor('a/b')).toBe('/t/a%2Fb');
    expect(parseTagPath('/t/a%2Fb')).toBe('a/b');
  });

  it('leaves the RSS address alone, since the server serves that', () => {
    // Claiming this in the router would render the app over a feed URL someone
    // pasted into a reader.
    expect(parseTagPath('/t/editors/feed.xml')).toBeNull();
  });

  it('tolerates a trailing slash', () => {
    expect(parseTagPath('/t/editors/')).toBe('editors');
  });

  it('is not fooled by a path that merely starts the same way', () => {
    expect(parseTagPath('/tags/editors')).toBeNull();
    expect(parseTagPath('/t/')).toBeNull();
  });

  it('falls back to the raw segment rather than throwing on bad encoding', () => {
    expect(parseTagPath('/t/%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('isRecentPath', () => {
  it('matches with and without the trailing slash', () => {
    expect(isRecentPath(RECENT_PATH)).toBe(true);
    expect(isRecentPath('/recent/')).toBe(true);
  });

  it('does not match a deeper path', () => {
    expect(isRecentPath('/recently')).toBe(false);
    expect(isRecentPath('/recent/x')).toBe(false);
  });
});
