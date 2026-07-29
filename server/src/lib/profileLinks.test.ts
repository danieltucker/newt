import { describe, it, expect } from 'vitest';
import { normalizeProfileLinks, readProfileLinks, MAX_PROFILE_LINKS } from './profileLinks';

const link = (platform: string, url: string) => ({ platform, url });

describe('normalizeProfileLinks', () => {
  it('accepts an ordinary list and keeps its order', () => {
    expect(normalizeProfileLinks([
      link('bluesky', 'https://bsky.app/profile/sam'),
      link('github', 'https://github.com/sam'),
    ])).toEqual([
      { platform: 'bluesky', url: 'https://bsky.app/profile/sam' },
      { platform: 'github', url: 'https://github.com/sam' },
    ]);
  });

  it('accepts an empty list - that is how you clear your links', () => {
    expect(normalizeProfileLinks([])).toEqual([]);
  });

  it('lowercases the platform id', () => {
    expect(normalizeProfileLinks([link('GitHub', 'https://github.com/sam')]))
      .toEqual([{ platform: 'github', url: 'https://github.com/sam' }]);
  });

  it('drops a repeated URL rather than rendering the same icon twice', () => {
    expect(normalizeProfileLinks([
      link('github', 'https://github.com/sam'),
      link('website', 'https://github.com/sam'),
    ])).toEqual([{ platform: 'github', url: 'https://github.com/sam' }]);
  });

  it('rejects anything that is not http(s)', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com/x',
    ]) {
      expect(normalizeProfileLinks([link('website', url)])).toBeNull();
    }
  });

  it('rejects a bare hostname with no dot', () => {
    expect(normalizeProfileLinks([link('website', 'http://localhost:3001/admin')])).toBeNull();
    expect(normalizeProfileLinks([link('website', 'https://intranet/')])).toBeNull();
  });

  it('rejects a URL that is not a URL at all', () => {
    expect(normalizeProfileLinks([link('website', 'example.com')])).toBeNull();
    expect(normalizeProfileLinks([link('website', '   ')])).toBeNull();
  });

  it('rejects an over-long URL', () => {
    expect(normalizeProfileLinks([link('website', `https://e.test/${'a'.repeat(400)}`)])).toBeNull();
  });

  it('rejects a malformed platform id', () => {
    for (const id of ['', '-lead', 'has space', 'UPPER CASE', 'a'.repeat(25), 'emoji🙂']) {
      expect(normalizeProfileLinks([link(id, 'https://example.com')])).toBeNull();
    }
  });

  it('rejects more links than a profile may hold', () => {
    const many = Array.from({ length: MAX_PROFILE_LINKS + 1 }, (_, i) =>
      link('website', `https://example.com/${i}`));
    expect(normalizeProfileLinks(many)).toBeNull();
    expect(normalizeProfileLinks(many.slice(0, MAX_PROFILE_LINKS))).toHaveLength(MAX_PROFILE_LINKS);
  });

  it('rejects shapes that are not a list of entries', () => {
    for (const bad of [null, undefined, {}, 'links', 42, [null], ['https://e.test'], [[]]]) {
      expect(normalizeProfileLinks(bad)).toBeNull();
    }
  });
});

describe('readProfileLinks', () => {
  it('reads a stored list back', () => {
    expect(readProfileLinks([link('github', 'https://github.com/sam')]))
      .toEqual([{ platform: 'github', url: 'https://github.com/sam' }]);
  });

  it('reads anything unrecognisable as no links, so a bad row cannot break a profile', () => {
    for (const bad of [null, undefined, {}, 'nonsense', [link('x', 'javascript:1')]]) {
      expect(readProfileLinks(bad)).toEqual([]);
    }
  });
});
