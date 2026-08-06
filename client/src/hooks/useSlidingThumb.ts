import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * The moving highlight behind a segmented control.
 *
 * These switches used to say which segment was on by painting that segment and
 * unpainting the last one, so the selection teleported: the eye gets no line
 * between where it was and where it went, and on a three-way switch that is the
 * whole difference between "I moved this" and "something changed". One box that
 * slides is the same information with the connection left in.
 *
 * The geometry is measured rather than computed from an index, because only one
 * of these controls has segments of equal width - the visibility switch is three
 * words of different lengths, and it drops to bare icons on a narrow window.
 * Measuring covers both without either control having to describe its own shape.
 *
 * Usage: put `trackRef` on the container, `setItem(value)` on each segment, and
 * spread `thumbProps` onto an absolutely positioned element inside the track.
 * The track needs `position: relative`, the segments need to sit above the thumb
 * (`position: relative` and a z-index), and the thumb owns the transition.
 */
export default function useSlidingThumb<T extends string>(active: T) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const items = useRef(new Map<T, HTMLElement>());
  // Where the thumb is. Null until the active segment has been found, which is
  // the first layout effect - so this is only ever null before the first paint.
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  const [primed, setPrimed] = useState(false);

  const setItem = useCallback((key: T) => (el: HTMLElement | null) => {
    if (el) items.current.set(key, el);
    else items.current.delete(key);
  }, []);

  const measure = useCallback(() => {
    const el = items.current.get(active);
    // A zero width is a control that hasn't been laid out - inside a collapsed
    // panel, or a display: none branch - rather than a segment of no size. Park
    // the thumb until there is something real to measure, or it would animate
    // out of the corner the moment the thing it lives in is shown.
    if (!el || el.offsetWidth === 0) { setBox(null); setPrimed(false); return; }
    // offsetLeft is measured from the track's padding box, and so is the thumb
    // sitting at left: 0 inside it, so the two agree without the hook having to
    // know what padding the control carries.
    const x = el.offsetLeft;
    const w = el.offsetWidth;
    setBox(prev => (prev && prev.x === x && prev.w === w ? prev : { x, w }));
  }, [active]);

  useLayoutEffect(() => {
    measure();
    const track = trackRef.current;
    if (typeof ResizeObserver === 'undefined' || !track) return;
    // Labels that hide at a breakpoint, a font arriving late, a switch in a
    // panel that got narrower: all of them move the segments without React
    // rendering anything, and all of them change the track's own size.
    const ro = new ResizeObserver(() => measure());
    ro.observe(track);
    return () => ro.disconnect();
  }, [measure]);

  // The thumb is put where it belongs before the first paint, and only allowed
  // to animate a frame later. Without this a control that opens on its last
  // segment slides across on arrival, which says something just changed when
  // nothing did. The same applies every time it comes back from having nothing
  // to measure, so this waits on a box rather than only on mounting.
  useLayoutEffect(() => {
    if (primed || !box) return;
    const id = requestAnimationFrame(() => setPrimed(true));
    return () => cancelAnimationFrame(id);
  }, [primed, box]);

  return {
    trackRef,
    setItem,
    thumbProps: {
      'aria-hidden': true as const,
      style: box
        ? {
            transform: `translateX(${box.x}px)`,
            width: box.w,
            // Inline, and only while unprimed: the stylesheet owns what the
            // animation actually is.
            transition: primed ? undefined : 'none',
          }
        : { opacity: 0 },
    },
  };
}
