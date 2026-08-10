import { useEffect } from 'react';

/**
 * Publishes how much of the window the on-screen keyboard is covering, as
 * `--kb-inset` on <html>, so any full-height surface can subtract it:
 *
 *   .overlay { position: fixed; inset: 0; bottom: var(--kb-inset, 0px); }
 *
 * Why this rather than `interactive-widget=resizes-content` on the viewport
 * meta: that is Chromium-only. WebKit never shrinks the layout viewport for the
 * keyboard, so a `position: fixed; inset: 0` element keeps its full height and
 * everything in its bottom half - which on a writing surface is the line being
 * typed - sits behind the keyboard. The visual viewport is the only thing on
 * iOS that knows the keyboard is there at all.
 *
 * Mounted once, at the app root. It costs two listeners and writes a custom
 * property; surfaces opt in by reading it.
 */

const VAR = '--kb-inset';
// Under this it isn't a keyboard, it's browser chrome: the address bar
// collapsing on scroll moves the visual viewport by 40-70px, and a console that
// resized itself every time the toolbar slid away would be worse than one that
// ignored the keyboard.
const MIN_KEYBOARD = 90;

export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    let raf = 0;

    const apply = () => {
      raf = 0;
      // The gap between the bottom of the visual viewport and the bottom of the
      // layout viewport. `offsetTop` matters because WebKit scrolls the visual
      // viewport up when the keyboard opens, and a fixed element is positioned
      // against the layout viewport regardless.
      const occluded = window.innerHeight - vv.height - vv.offsetTop;
      const px = occluded > MIN_KEYBOARD ? Math.round(occluded) : 0;
      if (root.style.getPropertyValue(VAR) !== `${px}px`) {
        root.style.setProperty(VAR, `${px}px`);
        root.classList.toggle('kb-open', px > 0);
      }
    };

    // Both events can fire several times per keyboard animation frame.
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      root.style.removeProperty(VAR);
      root.classList.remove('kb-open');
    };
  }, []);
}
