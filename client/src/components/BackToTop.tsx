import { useState, useEffect } from 'react';
import styles from './BackToTop.module.css';

// The feed is an infinite scroll: once you're a few screens down, getting back
// to the search box is a long drag. This is the shortcut.
//
// The whole page scrolls with the window (see NewTabPage.module.css - .page has
// no overflow of its own), so this listens to window scroll rather than being
// handed a container.

// Roughly a screenful. Below this the top is still in easy reach and the button
// would just be clutter over the content.
const SHOW_AFTER = 700;

function ArrowUpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 13V3" />
      <path d="M3.5 7.5L8 3l4.5 4.5" />
    </svg>
  );
}

export default function BackToTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // rAF-throttled: scroll fires far faster than we need to flip one boolean.
    let queued = false;
    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setShown(window.scrollY > SHOW_AFTER);
      });
    }
    onScroll(); // a reload can restore a scrolled position
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  function toTop() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }

  return (
    <button
      className={`${styles.btn} ${shown ? styles.shown : ''}`}
      onClick={toTop}
      // Hidden from the tab order while it's invisible, or it becomes a
      // focusable nothing sitting at the end of every page.
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
      aria-label="Back to top"
      title="Back to top"
    >
      <ArrowUpIcon />
    </button>
  );
}
