import { useEffect, useState } from 'react';

// Lets a component *move* an element between two places in the tree rather than
// render it twice and hide one with CSS. ShellBar needs that for the bookmarks
// rail: it owns drag state and its own dialogs, so a duplicate copy behind a
// `display: none` would put two of each in the DOM at once.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    // Sync once on subscribe - the viewport can change between the initial
    // state and this effect running.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
