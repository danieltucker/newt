import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './Lightbox.module.css';

// An image on its own, over everything else. Post bodies are read in a ~780px
// column, so anything wider than that has been shown shrunk to fit ever since it
// was uploaded; this is where you get to see it.
//
// Uploads are capped at MAX_UPLOAD_DIMENSION on the longest edge (see
// imageUpload), and only that one copy is stored - so "full resolution" is the
// image's natural size, which is exactly what this renders. Nothing is upscaled:
// an image smaller than the viewport is shown at its own size rather than
// stretched into a blurry one.
//
// It also pages through a set, which is what a gallery opens (see
// utils/noteGallery). The single-image and set forms are the same component
// because they are the same thing seen from a different starting point - the
// navigation simply has nothing to offer when the set has one member.
//
// Rendered through a portal to <body>. It cannot be an ordinary child: the
// profile's .bodyGrid ends its entrance animation on a transform, and a
// transformed ancestor becomes the containing block for position:fixed - which
// would pin this to that grid instead of the viewport. The clamped post bodies
// on the same page are overflow:hidden, which would clip it too.

export interface LightboxImage {
  src: string;
  alt?: string;
}

interface Props {
  /** A single image to show, or null when nothing is open. */
  image?: LightboxImage | null;
  /**
   * A set to page through, or null when nothing is open. Takes precedence over
   * `image`; callers pass one or the other, never both.
   */
  images?: LightboxImage[] | null;
  /** Which member of `images` opens first. */
  index?: number;
  /**
   * Throw the photo being viewed out of the set it came from. Supplied only
   * where the viewer owns what they are looking at - the editor, on a gallery
   * being written - and absent everywhere a set is merely being read.
   */
  onRemove?: (index: number) => void;
  onClose: () => void;
}

export default function Lightbox({ image, images, index = 0, onRemove, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Natural size, once the browser knows it. Shown as a hint that this is the
  // whole thing, and it also tells the reader whether the "open original" link
  // is worth following.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // One list, whichever form the caller used. Memoised on the props themselves,
  // so its identity only changes when what is open does - which is what the
  // cursor reset below keys on.
  const set = useMemo<LightboxImage[]>(
    () => (images && images.length ? images : image ? [image] : []),
    [images, image],
  );

  // Where in the set we are. Owned here rather than by the caller: paging is
  // this component's own business, and every caller would otherwise repeat the
  // same wrapping arithmetic to hand the answer straight back.
  const [cursor, setCursor] = useState(index);
  useEffect(() => {
    setCursor(Math.min(Math.max(index, 0), Math.max(set.length - 1, 0)));
  }, [set]); // eslint-disable-line react-hooks/exhaustive-deps

  const current: LightboxImage | undefined = set[cursor];
  const many = set.length > 1;

  // Wraps in both directions, the way every image viewer does - reaching the
  // last photo and stopping dead reads as a broken button.
  const step = useCallback((delta: number) => {
    setCursor(c => (c + delta + set.length) % set.length);
  }, [set.length]);

  useEffect(() => { setNatural(null); }, [current?.src]);

  useEffect(() => {
    if (!current) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (!many) return;
      if (e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft')  { e.stopPropagation(); e.preventDefault(); step(-1); }
    }
    // Capture, so this closes the image before any Escape handler further up
    // (the notes console, a modal) acts on the same press.
    document.addEventListener('keydown', onKey, true);

    // The page behind must not scroll under the overlay. Restoring the previous
    // value rather than clearing it keeps a modal that had already locked the
    // body from being unlocked when this closes on top of it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus moves in so Escape and Tab belong to the overlay; what had focus is
    // given it back on the way out.
    const returnTo = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previous;
      returnTo?.focus?.();
    };
    // `current` rather than `current.src`: re-running per photo would fight the
    // focus restore, and everything in here is about the overlay being open at
    // all rather than about which member of the set is showing.
  }, [!!current, many, step, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={many ? `Image gallery, ${set.length} images` : (current.alt || 'Image')}
      // Anywhere but the image itself dismisses - the whole backdrop is the
      // target, which is what the zoom-out cursor is promising.
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <button ref={closeRef} className={styles.closeBtn} onClick={onClose} aria-label="Close image">
        <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M1 1l10 10M11 1L1 11" />
        </svg>
      </button>

      {/* Fixed to the edges of the screen rather than sitting beside the photo:
          a nav button in the flow would take width off the image on every
          viewport, including the ones with none to spare. */}
      {many && (
        <>
          <button
            className={`${styles.navBtn} ${styles.navPrev}`}
            onClick={() => step(-1)}
            aria-label="Previous image"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            className={`${styles.navBtn} ${styles.navNext}`}
            onClick={() => step(1)}
            aria-label="Next image"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </>
      )}

      <img
        // Keyed on the source so a step swaps the element rather than mutating
        // one: without it the browser holds the previous photo on screen until
        // the next has decoded, which reads as the button not having worked.
        key={current.src}
        className={styles.image}
        src={current.src}
        alt={current.alt ?? ''}
        onLoad={e => setNatural({
          w: e.currentTarget.naturalWidth,
          h: e.currentTarget.naturalHeight,
        })}
      />

      <div className={styles.bar}>
        {many && <span className={styles.counter}>{cursor + 1} / {set.length}</span>}
        {current.alt && <span className={styles.caption}>{current.alt}</span>}
        {natural && <span className={styles.dims}>{natural.w} × {natural.h}</span>}
        {/* The stored file itself, for saving it or for pixel-peeping past
            whatever the viewport could fit. */}
        <a
          className={styles.openLink}
          href={current.src}
          target="_blank"
          rel="noreferrer"
        >
          Open original ↗
        </a>
        {onRemove && (
          <button
            className={`${styles.openLink} ${styles.removeBtn}`}
            onClick={() => onRemove(cursor)}
          >
            Remove
          </button>
        )}
      </div>

      {/* Paging one at a time is fine for three photos and tedious for twenty,
          so the whole set stays reachable in one click. */}
      {many && (
        <div className={styles.thumbs}>
          {set.map((img, i) => (
            <button
              key={`${img.src}-${i}`}
              className={`${styles.thumb} ${i === cursor ? styles.thumbOn : ''}`}
              onClick={() => setCursor(i)}
              aria-label={`Image ${i + 1}${img.alt ? `: ${img.alt}` : ''}`}
              aria-current={i === cursor}
            >
              <img src={img.src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
