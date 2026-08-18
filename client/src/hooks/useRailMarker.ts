import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Where the navigation rail's highlight belongs.
 *
 * One painted box sits on the place you are in and slides when you go
 * somewhere else. It tracks the *selection* and nothing else: an earlier
 * version had it follow the pointer as well, leaving a fading echo on the row
 * it came from, and it was too much - a coloured box darting around under the
 * cursor is the loudest thing on screen, and the rail is meant to be read past
 * rather than watched. Hover is a plain grey wash on the row itself now, and
 * the colour is reserved for the one row that has earned it.
 *
 * The position is measured rather than stepped. Rows are 38px under a pointer
 * and 44px under a thumb, so no constant survives both, and the Explore row
 * appears and disappears with whether a model is connected.
 */

export interface RailMarker {
  top: number;
  height: number;
}

export function useRailMarker(opts: {
  /** The row the highlight rests on, or null for somewhere the rail doesn't name. */
  activeId: string | null;
  /** The element for a row id, or null if it isn't mounted. */
  elementFor: (id: string) => HTMLElement | null;
  /** The box the rows are measured inside. Watched for resizes. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Anything else that can move the rows. */
  deps?: React.DependencyList;
}) {
  const { activeId, elementFor, containerRef, deps = [] } = opts;
  const [marker, setMarker] = useState<RailMarker | null>(null);

  const measure = useCallback(() => {
    const el = activeId ? elementFor(activeId) : null;
    setMarker(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
    // elementFor is rebuilt every render by its caller; keeping it out of the
    // dependency list is what stops this looping. activeId and the caller's own
    // deps are what actually decide the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, ...deps]);

  // Before paint, so the marker is where it belongs on the first frame and has
  // nothing to animate in from. A highlight that slid down from the top of the
  // rail on every page load would be a mannerism.
  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, containerRef]);

  return marker;
}
