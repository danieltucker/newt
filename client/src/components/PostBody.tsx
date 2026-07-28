import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { applyCommentCounts, embeddedUrls, EMBED_CLASS } from '../utils/noteEmbed';
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

  // Which images this applies to. A reference card carries its own favicon,
  // cover and thumbnail, and the card is a link somewhere: clicking one means
  // "take me there", not "look closer". An image the author wrapped in a link
  // keeps the link, for the same reason.
  const zoomable = (el: EventTarget | null): el is HTMLImageElement =>
    el instanceof HTMLImageElement
    && !el.closest(`.${EMBED_CLASS}`)
    && !el.closest('a');

  const openImage = useCallback((img: HTMLImageElement) => {
    // currentSrc is what the browser actually fetched; src is the fallback for
    // the frame before it has decided.
    setZoomed({ src: img.currentSrc || img.src, alt: img.alt });
  }, []);

  // An <img> takes no focus of its own, so the ones that open have to be told to
  // - otherwise this is a mouse-only feature. Re-run per body: the markup is
  // replaced wholesale whenever `html` changes.
  useEffect(() => {
    const imgs = bodyRef.current?.querySelectorAll('img') ?? [];
    imgs.forEach(img => {
      if (!zoomable(img)) return;
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      if (!img.getAttribute('aria-label')) {
        img.setAttribute('aria-label', img.alt ? `View image: ${img.alt}` : 'View image full size');
      }
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
        if (!zoomable(e.target)) return;
        e.preventDefault();
        openImage(e.target);
      }}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (!zoomable(e.target)) return;
        // Space would otherwise scroll the page out from under the image.
        e.preventDefault();
        openImage(e.target);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );

  const lightbox = <Lightbox image={zoomed} onClose={() => setZoomed(null)} />;

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
