import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { applyCommentCounts, embeddedUrls, EMBED_CLASS } from '../utils/noteEmbed';
import { GALLERY_CLASS, galleryAt, galleryImages, galleryIndexOf } from '../utils/noteGallery';
import Lightbox, { LightboxImage } from './Lightbox';
import styles from './PostBody.module.css';

// A published post's body, wherever it is read: on its own page, or in full in
// the list on its author's profile. One component because it is one thing - the
// typography, the reference cards and the live comment counts on them all have
// to be identical in both places, and a second copy of these rules would drift
// the moment either was touched.
//
// The HTML is sanitized server-side on write (see sanitizeBlogHtml); nothing is
// re-checked here, and nothing here may add to what the allowlist permits.

interface Props {
  /** Sanitized post body HTML. */
  html: string;
  /**
   * Cut the body off at a screen's worth, with a way to open it in full. For
   * lists; a post on its own page is never clamped. The affordance only appears
   * if the body is measured to actually overflow.
   */
  clamp?: boolean;
  /** Invoked by "Continue reading". Required for any use of `clamp` to do anything. */
  onExpand?: () => void;
}

export default function PostBody({ html, clamp, onExpand }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  // References embedded in the post show how much conversation the thing they
  // point at has drawn. The number is fetched per view rather than stored with
  // the post - the server's allowlist refuses to carry it for exactly that
  // reason - and it is visibility-filtered, so a stranger is only told about
  // comments they could go and read.
  const { counts } = useCommentCounts(useMemo(() => embeddedUrls(html), [html]));
  useEffect(() => {
    if (bodyRef.current) applyCommentCounts(bodyRef.current, counts);
  }, [counts, html]);

  // ── Images open full size ──────────────────────────────────────────────────
  // A post is read in a ~780px column, so any image wider than that has been
  // shown shrunk to fit. Clicking one shows it whole.
  //
  // Delegated from the container rather than bound per image: the body is
  // server-sanitized HTML dropped in with dangerouslySetInnerHTML, so there are
  // no elements here to attach props to - and doing it this way means every post
  // already written gets this without being re-saved.
  const [zoomed, setZoomed] = useState<LightboxImage | null>(null);
  // A gallery opens the same overlay on its whole set, at the card that was
  // clicked - which is what the fan is an invitation to do.
  const [gallery, setGallery] = useState<{ images: LightboxImage[]; index: number } | null>(null);

  // Which images this applies to. A reference card carries its own favicon,
  // cover and thumbnail, and the card is a link somewhere: clicking one means
  // "take me there", not "look closer". An image the author wrapped in a link
  // keeps the link, for the same reason. A gallery card is excluded here and
  // handled below instead: it opens the set it belongs to, not itself alone.
  const zoomable = (el: EventTarget | null): el is HTMLImageElement =>
    el instanceof HTMLImageElement
    && !el.closest(`.${EMBED_CLASS}`)
    && !el.closest(`.${GALLERY_CLASS}`)
    && !el.closest('a');

  const openImage = useCallback((img: HTMLImageElement) => {
    // currentSrc is what the browser actually fetched; src is the fallback for
    // the frame before it has decided.
    setZoomed({ src: img.currentSrc || img.src, alt: img.alt });
  }, []);

  // Returns whether the event landed on a gallery, having opened it if so.
  const openGalleryAt = useCallback((target: EventTarget | null) => {
    const root = bodyRef.current;
    if (!root || !(target instanceof Node)) return false;
    const el = galleryAt(target, root);
    if (!el) return false;
    const images = galleryImages(el).map(img => ({ src: img.src, alt: img.alt }));
    if (!images.length) return false;
    setGallery({ images, index: galleryIndexOf(el, target) });
    return true;
  }, []);

  // Neither an <img> nor a <span> takes focus of its own, so everything that
  // opens has to be told to - otherwise this is a mouse-only feature. Re-run per
  // body: the markup is replaced wholesale whenever `html` changes.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    root.querySelectorAll('img').forEach(img => {
      if (!zoomable(img)) return;
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      if (!img.getAttribute('aria-label')) {
        img.setAttribute('aria-label', img.alt ? `View image: ${img.alt}` : 'View image full size');
      }
    });
    // The stack takes the focus, not the cards: it is one object, and tabbing
    // through three quarter-visible edges of the same gallery is not navigation.
    root.querySelectorAll(`.${GALLERY_CLASS}`).forEach(el => {
      const n = el.querySelectorAll('img').length;
      (el as HTMLElement).tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Open gallery, ${n} image${n === 1 ? '' : 's'}`);
    });
  }, [html]);

  // Whether the clamp is actually hiding anything. Measured rather than guessed
  // from the character count: a post is as tall as its images and code blocks
  // make it, which no amount of counting text will tell you.
  //
  // useLayoutEffect so the fade is right on the first paint. Images land later
  // and change the answer, so the observer keeps watching rather than measuring
  // once - a post whose only overflow was a photo would otherwise never say so.
  useLayoutEffect(() => {
    if (!clamp) { setOverflows(false); return; }
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight - el.clientHeight > 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [clamp, html]);

  const body = (
    <div
      ref={bodyRef}
      // note-embed-read is the themed skin for reference cards - see
      // styles/noteEmbed.css. Global, so it is not hashed.
      //
      // The cap goes on whenever clamping is asked for, not only once overflow
      // is known: the measurement above compares scrollHeight against
      // clientHeight, and without a cap in place those are always equal, so
      // gating the class on `overflows` would mean it could never become true.
      // A post shorter than the cap is unaffected by it either way.
      className={`${styles.body} note-embed-read ${clamp ? styles.clamped : ''}`}
      onClick={e => {
        if (openGalleryAt(e.target)) { e.preventDefault(); return; }
        if (!zoomable(e.target)) return;
        e.preventDefault();
        openImage(e.target);
      }}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Space would otherwise scroll the page out from under the image.
        if (openGalleryAt(e.target)) { e.preventDefault(); return; }
        if (!zoomable(e.target)) return;
        e.preventDefault();
        openImage(e.target);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );

  // Two overlays, but never two at once: opening either closes nothing because
  // only one can have been clicked. A single one taking both shapes would have
  // to be told which it is on every render for no gain.
  const lightbox = (
    <>
      <Lightbox image={zoomed} onClose={() => setZoomed(null)} />
      <Lightbox
        images={gallery?.images ?? null}
        index={gallery?.index ?? 0}
        onClose={() => setGallery(null)}
      />
    </>
  );

  if (!clamp) return <>{body}{lightbox}</>;

  return (
    <>
      <div className={styles.clampWrap}>
        {body}
        {overflows && <div className={styles.fade} aria-hidden />}
      </div>
      {overflows && onExpand && (
        <div className={styles.moreRow}>
          <button className={styles.moreBtn} onClick={onExpand}>Continue reading →</button>
        </div>
      )}
      {lightbox}
    </>
  );
}
