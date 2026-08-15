/**
 * Which corner the newt button sits in.
 *
 * A placement preference for *this* screen, so it is stored per-device rather
 * than synced with the rest of the settings - the same call the notes console
 * makes about its maximised state. Someone who drags the button left-handed on
 * a laptop has said nothing at all about where they want it on their phone.
 */

export type DockSide = 'left' | 'right';

const KEY = 'newt:dockSide';

export const DEFAULT_DOCK: DockSide = 'right';

export function readDock(): DockSide {
  try {
    return localStorage.getItem(KEY) === 'left' ? 'left' : DEFAULT_DOCK;
  } catch {
    return DEFAULT_DOCK;
  }
}

export function writeDock(side: DockSide) {
  try { localStorage.setItem(KEY, side); } catch { /* ignore */ }
}

/**
 * Where a drag that ended at `x` should park.
 *
 * Whichever half of the window the button was let go in, so the gesture is
 * "throw it over there" rather than "drag it all the way into the corner". A
 * zero-width viewport (a hidden tab, jsdom before layout) has no halves, so it
 * keeps the side it had.
 */
export function sideForX(x: number, viewportWidth: number, current: DockSide): DockSide {
  if (viewportWidth <= 0) return current;
  return x < viewportWidth / 2 ? 'left' : 'right';
}
