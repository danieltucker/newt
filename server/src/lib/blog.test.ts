import { describe, it, expect } from 'vitest';
import {
  slugify,
  uniqueSlug,
  excerptOf,
  canSeePost,
  visiblePostWhere,
  isBlogVisibility,
  postPathFor,
  normalizeHeroImage,
} from './blog';

describe('slugify', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(slugify('On Rewriting My Editor')).toBe('on-rewriting-my-editor');
  });

  it('drops punctuation rather than encoding it', () => {
    expect(slugify('Hello, world! (again?)')).toBe('hello-world-again');
  });

  it('folds accents to ASCII so the URL stays typeable', () => {
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
  });

  it('falls back to "post" when the title has no usable characters', () => {
    expect(slugify('')).toBe('post');
    expect(slugify('!!! ???')).toBe('post');
  });

  it('never leaves a dangling separator when the cut lands on one', () => {
    // 59 chars of title + the separator is exactly the 60-char budget, so the
    // slice ends on a hyphen — which must not survive into the finished slug.
    expect(slugify('a'.repeat(59) + ' tail')).toBe('a'.repeat(59));
  });

  it('truncates an over-long title without doubling separators', () => {
    const slug = slugify('word '.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).not.toContain('--');
    expect(slug.endsWith('-')).toBe(false);
  });

  it('carries no date, so it cannot disagree with the published byline', () => {
    // Two posts of the same title written on different days slug identically;
    // uniqueSlug, not the date, is what keeps them apart.
    expect(slugify('Late post')).toBe('late-post');
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when it is free', () => {
    expect(uniqueSlug('hello', new Set())).toBe('hello');
  });

  it('appends a counter when the author already used that slug', () => {
    expect(uniqueSlug('hello', new Set(['hello']))).toBe('hello-2');
  });

  it('skips over counters that are themselves taken', () => {
    const taken = new Set(['hello', 'hello-2', 'hello-3']);
    expect(uniqueSlug('hello', taken)).toBe('hello-4');
  });

  // Without the date suffix, same-title collisions are the common case rather
  // than a same-day edge case, so this is the load-bearing uniqueness path.
  it('keeps a repeated title unique across many posts', () => {
    const taken = new Set<string>();
    const slugs = Array.from({ length: 5 }, () => {
      const s = uniqueSlug(slugify('Weekly notes'), taken);
      taken.add(s);
      return s;
    });
    expect(slugs).toEqual(['weekly-notes', 'weekly-notes-2', 'weekly-notes-3', 'weekly-notes-4', 'weekly-notes-5']);
  });
});

describe('excerptOf', () => {
  it('strips markup and collapses whitespace', () => {
    expect(excerptOf('<h1>Title</h1>\n<p>Some   <b>bold</b> text.</p>')).toBe('Title Some bold text.');
  });

  it('decodes the entities the editor emits', () => {
    expect(excerptOf('<p>a&nbsp;b &amp; c</p>')).toBe('a b & c');
  });

  it('returns short text unchanged, with no ellipsis', () => {
    expect(excerptOf('<p>Short.</p>', 100)).toBe('Short.');
  });

  it('truncates on a word boundary and marks the cut', () => {
    const out = excerptOf('<p>alpha beta gamma delta epsilon</p>', 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe('alpha beta gamma…');
  });

  it('hard-cuts a single unbroken word rather than returning almost nothing', () => {
    const out = excerptOf(`<p>${'x'.repeat(50)}</p>`, 20);
    expect(out).toBe('x'.repeat(20) + '…');
  });
});

describe('canSeePost', () => {
  const author = 'author-1';
  const friend = 'friend-1';
  const stranger = 'stranger-1';
  const viewersFriends = new Set([author]);   // the viewer is friends with the author

  it('shows public posts to everyone, including logged-out visitors', () => {
    const post = { userId: author, visibility: 'public' };
    expect(canSeePost(post, undefined, new Set())).toBe(true);
    expect(canSeePost(post, stranger, new Set())).toBe(true);
  });

  it('shows friends-only posts to accepted friends but not to strangers', () => {
    const post = { userId: author, visibility: 'friends' };
    expect(canSeePost(post, friend, viewersFriends)).toBe(true);
    expect(canSeePost(post, stranger, new Set())).toBe(false);
  });

  it('never shows friends-only or private posts to a logged-out visitor', () => {
    expect(canSeePost({ userId: author, visibility: 'friends' }, undefined, new Set())).toBe(false);
    expect(canSeePost({ userId: author, visibility: 'private' }, undefined, new Set())).toBe(false);
  });

  it('shows the author their own posts at every visibility', () => {
    for (const visibility of ['public', 'friends', 'private']) {
      expect(canSeePost({ userId: author, visibility }, author, new Set())).toBe(true);
    }
  });

  it('hides private posts from friends — private is the draft state', () => {
    expect(canSeePost({ userId: author, visibility: 'private' }, friend, viewersFriends)).toBe(false);
  });
});

describe('visiblePostWhere', () => {
  it('matches only public posts for a logged-out viewer', () => {
    // Crucially no `{ userId: undefined }` clause, which Prisma would treat as
    // matching every row.
    expect(visiblePostWhere(undefined, new Set())).toEqual({ OR: [{ visibility: 'public' }] });
  });

  it('adds the viewer’s own posts and their friends’ friends-only posts', () => {
    expect(visiblePostWhere('me', new Set(['a']))).toEqual({
      OR: [
        { visibility: 'public' },
        { userId: 'me' },
        { visibility: 'friends', userId: { in: ['a'] } },
      ],
    });
  });

  it('omits the friends clause entirely when the viewer has no friends', () => {
    expect(visiblePostWhere('me', new Set())).toEqual({
      OR: [{ visibility: 'public' }, { userId: 'me' }],
    });
  });
});

describe('isBlogVisibility', () => {
  it('accepts the three tiers and rejects anything else', () => {
    expect(isBlogVisibility('public')).toBe(true);
    expect(isBlogVisibility('friends')).toBe(true);
    expect(isBlogVisibility('private')).toBe(true);
    expect(isBlogVisibility('secret')).toBe(false);
    expect(isBlogVisibility(undefined)).toBe(false);
  });
});

describe('normalizeHeroImage', () => {
  it('accepts one of our own uploaded image paths', () => {
    expect(normalizeHeroImage('/api/v1/images/clx123abc')).toBe('/api/v1/images/clx123abc');
  });

  it('treats an empty or whitespace-only value as clearing the hero', () => {
    expect(normalizeHeroImage('')).toBe('');
    expect(normalizeHeroImage('   ')).toBe('');
  });

  it('trims surrounding whitespace off an otherwise valid path', () => {
    expect(normalizeHeroImage('  /api/v1/images/abc  ')).toBe('/api/v1/images/abc');
  });

  // The whole point of the check: the column must not become a way to point a
  // reader's browser at somewhere else, or to smuggle a script URL into an
  // `src` attribute.
  it('rejects anything that is not a site-relative image path', () => {
    expect(normalizeHeroImage('https://evil.test/tracker.png')).toBeNull();
    expect(normalizeHeroImage('//evil.test/tracker.png')).toBeNull();
    expect(normalizeHeroImage('javascript:alert(1)')).toBeNull();
    expect(normalizeHeroImage('data:image/png;base64,AAAA')).toBeNull();
    expect(normalizeHeroImage('/api/v1/images/abc/../../account')).toBeNull();
    expect(normalizeHeroImage('/etc/passwd')).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(normalizeHeroImage(undefined)).toBeNull();
    expect(normalizeHeroImage(null)).toBeNull();
    expect(normalizeHeroImage(42)).toBeNull();
  });
});

describe('postPathFor', () => {
  it('builds the /u/<username>/<slug> path', () => {
    expect(postPathFor('alice', 'hello-2026-07-24')).toBe('/u/alice/hello-2026-07-24');
  });

  it('encodes a username with characters that are unsafe in a path', () => {
    expect(postPathFor('a b/c', 'x-2026-07-24')).toBe('/u/a%20b%2Fc/x-2026-07-24');
  });
});
