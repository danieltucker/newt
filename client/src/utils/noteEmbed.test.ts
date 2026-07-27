// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  EMBED_CLASS, EmbedData, applyCommentCounts, articleEmbed, buildEmbedHtml, commentLabel,
  createEmbed, embedAt, embedMatches, embeddedUrls, hydrateEmbeds, postEmbed, readEmbed,
  variantOf,
} from './noteEmbed';
import { parseArticlePath } from './articleUrl';
import { ReadingListItem } from '../types';

const item = (over: Partial<ReadingListItem> = {}): ReadingListItem => ({
  id: 'r1',
  url: 'https://example.com/post',
  title: 'A post',
  source: 'example.com',
  readTime: '6 min',
  tag: '',
  notes: '',
  imageUrl: 'https://cdn.example.com/hero.jpg',
  inLibrary: false,
  folderId: null,
  savedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const parse = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
};

describe('articleEmbed', () => {
  it('points at the article’s Newt page, not the source', () => {
    const data = articleEmbed(item());
    expect(parseArticlePath(data.href)).toBe('https://example.com/post');
    expect(data.url).toBe('https://example.com/post');
  });

  it('falls back to the URL when a saved article has no title', () => {
    expect(articleEmbed(item({ title: '  ' })).title).toBe('https://example.com/post');
  });

  it('leaves optional fields off rather than empty', () => {
    const data = articleEmbed(item({ imageUrl: '', readTime: '' }));
    expect(data.image).toBeUndefined();
    expect(data.meta).toBeUndefined();
  });
});

const post = (over: Partial<Parameters<typeof postEmbed>[0]> = {}) => ({
  url: 'https://newt.test/u/ada/on-looms',
  title: 'On looms',
  slug: 'on-looms',
  heroImage: '/api/v1/images/img1',
  // Midday, so the date renders the same either side of UTC - postEmbed formats
  // in the reader's zone, as every other date in the app does
  publishedAt: '2026-03-04T12:00:00.000Z',
  author: { username: 'ada', displayName: 'Ada Lovelace' },
  ...over,
});

describe('postEmbed', () => {
  it('points at the post’s own page, not a reader for it', () => {
    expect(postEmbed(post()).href).toBe('/u/ada/on-looms');
  });

  it('keeps the canonical URL, which is what its comments are threaded on', () => {
    expect(postEmbed(post()).url).toBe('https://newt.test/u/ada/on-looms');
  });

  it('credits the author where an article would name a publication', () => {
    const data = postEmbed(post());
    expect(data.source).toBe('Ada Lovelace');
    expect(data.meta).toBe('Mar 4, 2026');
  });

  it('shows no favicon, having a person’s name rather than a domain', () => {
    for (const variant of ['link', 'small', 'large'] as const) {
      expect(parse(buildEmbedHtml(postEmbed(post()), variant))
        .querySelector('img.note-embed-fav')).toBeNull();
    }
    // The article it sits beside still gets one - this is per kind, not a
    // favicon that stopped working
    expect(parse(buildEmbedHtml(articleEmbed(item()), 'small'))
      .querySelector('img.note-embed-fav')).not.toBeNull();
  });

  it('says what it is on the large card', () => {
    expect(parse(buildEmbedHtml(postEmbed(post()), 'large')).textContent).toContain('Blog post');
  });

  it('round-trips through the markup like any other kind', () => {
    const data = postEmbed(post());
    expect(readEmbed(parse(buildEmbedHtml(data, 'large')))).toEqual(data);
  });

  it('falls back to the canonical URL when the author is unknown', () => {
    expect(postEmbed(post({ author: null })).href).toBe('https://newt.test/u/ada/on-looms');
  });

  it('leaves a missing date and cover off rather than empty', () => {
    const data = postEmbed(post({ heroImage: '', publishedAt: null }));
    expect(data.image).toBeUndefined();
    expect(data.meta).toBeUndefined();
  });
});

describe('buildEmbedHtml', () => {
  const data = articleEmbed(item());

  it('round-trips its data through the markup at every size', () => {
    for (const variant of ['link', 'small', 'large'] as const) {
      const el = parse(buildEmbedHtml(data, variant));
      expect(variantOf(el)).toBe(variant);
      expect(readEmbed(el)).toEqual(data);
    }
  });

  it('stays inline-only, so a <p> round-trip cannot split it', () => {
    for (const variant of ['link', 'small', 'large'] as const) {
      const p = document.createElement('p');
      p.innerHTML = buildEmbedHtml(data, variant);
      // A block element inside <p> would be hoisted out by the parser, leaving
      // the wrapper behind as an empty shell.
      expect(p.querySelectorAll(`.${EMBED_CLASS}`)).toHaveLength(1);
      expect(p.querySelector('div, p, section, figure')).toBeNull();
    }
  });

  it('is atomic in the editor', () => {
    const el = parse(buildEmbedHtml(data, 'small'));
    expect(el.getAttribute('contenteditable')).toBe('false');
  });

  it('escapes text that would otherwise close an attribute or a tag', () => {
    const nasty = articleEmbed(item({ title: '" onerror="alert(1)', source: '<b>x</b>' }));
    const el = parse(buildEmbedHtml(nasty, 'small'));
    expect(readEmbed(el)?.title).toBe('" onerror="alert(1)');
    expect(el.querySelector('b')).toBeNull();
  });

  it('refuses a script-bearing scheme rather than rewriting it', () => {
    const el = parse(buildEmbedHtml(
      { ...data, href: 'javascript:alert(1)', image: 'javascript:alert(1)' }, 'large'));
    expect(el.querySelector('a')!.getAttribute('href')).toBe('#');
    expect(el.querySelector('img.note-embed-cover')).toBeNull();
  });

  it('drops the artwork slot when there is no artwork', () => {
    const bare = articleEmbed(item({ imageUrl: '' }));
    expect(parse(buildEmbedHtml(bare, 'small')).querySelector('img.note-embed-thumb')).toBeNull();
    expect(parse(buildEmbedHtml(bare, 'large')).querySelector('img.note-embed-cover')).toBeNull();
  });

  it('shows source and meta together on the card sizes', () => {
    expect(parse(buildEmbedHtml(data, 'small')).textContent).toContain('example.com · 6 min');
    expect(parse(buildEmbedHtml(data, 'large')).textContent).toContain('Saved article');
  });
});

describe('changing size', () => {
  it('rebuilds from the stored data, losing nothing', () => {
    const data = articleEmbed(item());
    const small = createEmbed(data, 'small');
    const large = createEmbed(readEmbed(small)!, 'large');
    const back = createEmbed(readEmbed(large)!, 'small');
    expect(readEmbed(back)).toEqual(data);
    expect(back.outerHTML).toBe(small.outerHTML);
  });
});

describe('readEmbed', () => {
  it('ignores markup that is not one of ours', () => {
    expect(readEmbed(null)).toBeNull();
    expect(readEmbed(parse('<span>plain</span>'))).toBeNull();
    expect(readEmbed(parse(`<span class="${EMBED_CLASS}" data-embed="tweet"></span>`))).toBeNull();
  });
});

describe('embedAt', () => {
  it('finds the embed a click landed inside', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>text ${buildEmbedHtml(articleEmbed(item()), 'small')}</p>`;
    const title = root.querySelector('.note-embed-title')!;
    expect(embedAt(title.firstChild, root)).toBe(root.querySelector(`.${EMBED_CLASS}`));
    expect(embedAt(root.querySelector('p')!.firstChild, root)).toBeNull();
  });

  it('will not reach outside the editor it was given', () => {
    const outer = document.createElement('div');
    outer.innerHTML = buildEmbedHtml(articleEmbed(item()), 'link');
    const other = document.createElement('div');
    expect(embedAt(outer.querySelector('.note-embed-title'), other)).toBeNull();
  });
});

describe('live comment counts', () => {
  const data = articleEmbed(item());
  const mount = (variant: 'link' | 'small' | 'large') => {
    const root = document.createElement('div');
    root.innerHTML = buildEmbedHtml(data, variant);
    return root;
  };

  it('is never written into the stored markup', () => {
    expect(buildEmbedHtml(data, 'large')).not.toContain('data-comments');
    // The slot is there, but empty - the number is added at render time
    expect(buildEmbedHtml(data, 'large')).toContain('class="note-embed-comments"');
  });

  it('reads the number back out of the counts, keyed by source URL', () => {
    const root = mount('large');
    applyCommentCounts(root, { 'https://example.com/post': 4 });
    expect(root.querySelector('.note-embed-comments')!.getAttribute('data-comments'))
      .toBe('4 comments');
  });

  it('leaves an unknown count resting on the neutral label', () => {
    const root = mount('large');
    applyCommentCounts(root, { 'https://other.example/x': 9 });
    // Absent attribute, not "0 comments" - "not asked yet" is not "none"
    expect(root.querySelector('.note-embed-comments')!.hasAttribute('data-comments')).toBe(false);
  });

  it('clears a count that no longer applies', () => {
    const root = mount('large');
    applyCommentCounts(root, { 'https://example.com/post': 4 });
    applyCommentCounts(root, {});
    expect(root.querySelector('.note-embed-comments')!.hasAttribute('data-comments')).toBe(false);
  });

  it('says it in words, singular and plural and none', () => {
    expect(commentLabel(0)).toBe('No comments yet');
    expect(commentLabel(1)).toBe('1 comment');
    expect(commentLabel(12)).toBe('12 comments');
  });

  it('counts a reposted post too - it has a thread of its own', () => {
    const root = document.createElement('div');
    root.innerHTML = buildEmbedHtml(postEmbed(post()), 'large');
    applyCommentCounts(root, { 'https://newt.test/u/ada/on-looms': 1 });
    expect(root.querySelector('.note-embed-comments')!.getAttribute('data-comments'))
      .toBe('1 comment');
  });

  it('does nothing to the sizes that have no slot', () => {
    for (const v of ['link', 'small'] as const) {
      const root = mount(v);
      applyCommentCounts(root, { 'https://example.com/post': 4 });
      expect(root.innerHTML).not.toContain('data-comments');
    }
  });
});

describe('hydrateEmbeds', () => {
  const data = articleEmbed(item());

  it('puts back the atomicity the server sanitizer strips', () => {
    const root = document.createElement('div');
    // What a blog body looks like coming back from sanitizeBlogHtml
    root.innerHTML = buildEmbedHtml(data, 'small').replace(' contenteditable="false"', '');
    expect(root.querySelector(`.${EMBED_CLASS}`)!.hasAttribute('contenteditable')).toBe(false);
    hydrateEmbeds(root);
    expect(root.querySelector(`.${EMBED_CLASS}`)!.getAttribute('contenteditable')).toBe('false');
  });

  it('drops a count that found its way into storage, so none is shown stale', () => {
    const root = document.createElement('div');
    root.innerHTML = buildEmbedHtml(data, 'large');
    applyCommentCounts(root, { 'https://example.com/post': 99 });
    hydrateEmbeds(root);
    expect(root.innerHTML).not.toContain('data-comments');
    expect(root.innerHTML).not.toContain('99');
  });
});

describe('embeddedUrls', () => {
  const data = articleEmbed(item());

  it('finds the article URLs a body cites', () => {
    const other = articleEmbed(item({ url: 'https://b.example/y' }));
    const html = `<p>x ${buildEmbedHtml(data, 'small')}</p><p>${buildEmbedHtml(other, 'large')}</p>`;
    expect(embeddedUrls(html).sort())
      .toEqual(['https://b.example/y', 'https://example.com/post']);
  });

  it('reports one URL once, however many times it is cited', () => {
    const html = buildEmbedHtml(data, 'small') + buildEmbedHtml(data, 'large');
    expect(embeddedUrls(html)).toEqual(['https://example.com/post']);
  });

  it('gathers article and post references alike, in one request', () => {
    const html = buildEmbedHtml(data, 'small') + buildEmbedHtml(postEmbed(post()), 'large');
    expect(embeddedUrls(html).sort())
      .toEqual(['https://example.com/post', 'https://newt.test/u/ada/on-looms']);
  });

  it('costs nothing on a body with no references', () => {
    expect(embeddedUrls('<p>just words</p>')).toEqual([]);
    expect(embeddedUrls('')).toEqual([]);
  });
});

describe('embedMatches', () => {
  const data: EmbedData = articleEmbed(item({ title: 'Rust ownership', source: 'fasterthanli.me' }));

  it('matches title, source and url alike', () => {
    expect(embedMatches(data, 'ownership')).toBe(true);
    expect(embedMatches(data, 'FASTERTHAN')).toBe(true);
    expect(embedMatches(data, '/post')).toBe(true);
    expect(embedMatches(data, 'zig')).toBe(false);
  });

  it('offers everything when nothing has been typed', () => {
    expect(embedMatches(data, '   ')).toBe(true);
  });
});
