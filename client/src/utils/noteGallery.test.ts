// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  GALLERY_CARD_CLASS, GALLERY_CLASS, MAX_GALLERY_IMAGES, buildGalleryHtml, cleanGalleryImages,
  createGallery, galleryAt, galleryImages, galleryIndexOf, hydrateGalleries, isGallery,
} from './noteGallery';

const src = (n: number) => `/api/v1/images/img${n}`;
const set = (n: number) => Array.from({ length: n }, (_, i) => ({ src: src(i), alt: `photo ${i}` }));

const parse = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
};

describe('buildGalleryHtml', () => {
  it('writes one card per image, whatever the fan shows', () => {
    const el = parse(buildGalleryHtml(set(7)));
    expect(el.querySelectorAll(`img.${GALLERY_CARD_CLASS}`)).toHaveLength(7);
  });

  it('marks the wrapper atomic and records the count', () => {
    const el = parse(buildGalleryHtml(set(3)));
    expect(el.classList.contains(GALLERY_CLASS)).toBe(true);
    expect(el.getAttribute('contenteditable')).toBe('false');
    expect(el.getAttribute('data-gallery')).toBe('3');
  });

  it('badges only what the fan cannot show', () => {
    expect(parse(buildGalleryHtml(set(3))).querySelector('.note-gallery-more')).toBeNull();
    expect(parse(buildGalleryHtml(set(5)))!.querySelector('.note-gallery-more')?.textContent)
      .toBe('+2');
  });

  it('is empty markup for an empty set, so nothing is inserted', () => {
    expect(buildGalleryHtml([])).toBe('');
    expect(createGallery([])).toBeNull();
  });

  it('escapes alt text rather than letting it reach the markup', () => {
    const html = buildGalleryHtml([{ src: src(0), alt: '"><script>alert(1)</script>' }]);
    expect(html).not.toContain('<script>');
    const el = parse(html);
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('"><script>alert(1)</script>');
  });
});

describe('cleanGalleryImages', () => {
  it('keeps our own uploads and plain web images', () => {
    const kept = cleanGalleryImages([
      { src: '/api/v1/images/abc' },
      { src: 'https://cdn.example.com/a.jpg' },
      { src: '//cdn.example.com/b.jpg' },
    ]);
    expect(kept).toHaveLength(3);
  });

  it('drops anything that could carry script', () => {
    const kept = cleanGalleryImages([
      { src: 'javascript:alert(1)' },
      { src: 'data:image/svg+xml,<svg onload=alert(1)>' },
      { src: '   ' },
      { src: '/api/v1/images/ok' },
    ]);
    expect(kept.map(i => i.src)).toEqual(['/api/v1/images/ok']);
  });

  it('caps the set', () => {
    expect(cleanGalleryImages(set(MAX_GALLERY_IMAGES + 5))).toHaveLength(MAX_GALLERY_IMAGES);
  });
});

describe('reading a gallery back', () => {
  it('recovers the images it was built from, in order', () => {
    const el = createGallery(set(4))!;
    expect(galleryImages(el)).toEqual([
      { src: src(0), alt: 'photo 0' },
      { src: src(1), alt: 'photo 1' },
      { src: src(2), alt: 'photo 2' },
      { src: src(3), alt: 'photo 3' },
    ]);
  });

  it('reports nothing for something that is not one of ours', () => {
    expect(isGallery(parse('<span class="note-embed"></span>'))).toBe(false);
    expect(galleryImages(parse('<p><img src="/x.png"></p>'))).toEqual([]);
  });
});

describe('galleryAt', () => {
  it('finds the gallery a card lies inside', () => {
    const root = document.createElement('div');
    root.appendChild(createGallery(set(3))!);
    const card = root.querySelector('img')!;
    expect(galleryAt(card, root)).toBe(root.firstElementChild);
  });

  it('refuses a gallery outside the root it was asked about', () => {
    const mine = document.createElement('div');
    const theirs = document.createElement('div');
    theirs.appendChild(createGallery(set(2))!);
    expect(galleryAt(theirs.querySelector('img'), mine)).toBeNull();
  });

  it('is null for ordinary content', () => {
    const root = parse('<p>just words</p>');
    expect(galleryAt(root.firstChild, root)).toBeNull();
  });
});

describe('galleryIndexOf', () => {
  it('reports which card was hit', () => {
    const el = createGallery(set(4))!;
    const cards = el.querySelectorAll('img');
    expect(galleryIndexOf(el, cards[2])).toBe(2);
  });

  it('falls back to the first card when the hit was elsewhere', () => {
    const el = createGallery(set(4))!;
    expect(galleryIndexOf(el, el)).toBe(0);
    expect(galleryIndexOf(el, null)).toBe(0);
  });
});

describe('hydrateGalleries', () => {
  it('puts back the attribute the server sanitizer strips', () => {
    // What a saved post body comes back as: the markup, without contenteditable
    const root = document.createElement('div');
    root.innerHTML = buildGalleryHtml(set(2)).replace(' contenteditable="false"', '');
    expect(root.firstElementChild?.hasAttribute('contenteditable')).toBe(false);
    hydrateGalleries(root);
    expect(root.firstElementChild?.getAttribute('contenteditable')).toBe('false');
  });
});
