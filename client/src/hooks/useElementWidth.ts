import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The measured content width of an element, kept up to date as it resizes.
 *
 * For controls that have to change shape when they run out of room, this is the
 * honest question where a viewport media query is only a guess. The feed's
 * control bar is the case that forced it: the bar lives in a column beside a
 * 248px rail, so its width is not a monotonic function of the window at all —
 * a 900px window gives the bar ~848px because the rail has just dropped away,
 * and a 901px window gives it ~543px because the rail is back. Any threshold
 * written against the viewport is wrong on one side of that jump.
 *
 * `useLayoutEffect`, so the first measurement lands before the browser paints:
 * measuring in a passive effect would show one frame of the wrong shape on
 * every mount. Width starts at 0 and the caller decides what an unmeasured bar
 * looks like — the narrow shape is the safe answer, since it fits everywhere.
 *
 * Only observe elements whose width comes from their container. Measuring one
 * that is sized by its own contents, and then changing those contents on the
 * measurement, is a resize loop.
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    // jsdom has no ResizeObserver. Components under test then see width 0 and
    // render their narrow shape, which is a fair thing for a test to assert
    // against and better than throwing.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}
