import { useEffect, useRef, useState } from 'react';
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
  /** The image to show, or null when nothing is open. */
  image: LightboxImage | null;
  onClose: () => void;
}

export default function Lightbox({ image, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Natural size, once the browser knows it. Shown as a hint that this is the
  // whole thing, and it also tells the reader whether the "open original" link
  // is worth following.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => { setNatural(null); }, [image?.src]);

  useEffect(() => {
    if (!image) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
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
  }, [image, onClose]);

  if (!image) return null;

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={image.alt || 'Image'}
      // Anywhere but the image itself dismisses - the whole backdrop is the
      // target, which is what the zoom-out cursor is promising.
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <button ref={closeRef} className={styles.closeBtn} onClick={onClose} aria-label="Close image">
        <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M1 1l10 10M11 1L1 11" />
        </svg>
      </button>

      <img
        className={styles.image}
        src={image.src}
        alt={image.alt ?? ''}
        onLoad={e => setNatural({
          w: e.currentTarget.naturalWidth,
          h: e.currentTarget.naturalHeight,
        })}
      />

      <div className={styles.bar}>
        {image.alt && <span className={styles.caption}>{image.alt}</span>}
        {natural && <span className={styles.dims}>{natural.w} × {natural.h}</span>}
        {/* The stored file itself, for saving it or for pixel-peeping past
            whatever the viewport could fit. */}
        <a
          className={styles.openLink}
          href={image.src}
          target="_blank"
          rel="noreferrer"
        >
          Open original ↗
        </a>
      </div>
    </div>,
    document.body,
  );
}
