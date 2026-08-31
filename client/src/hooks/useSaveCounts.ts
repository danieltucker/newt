import { useState, useEffect, useCallback, useRef } from 'react';
import { apiPost } from '../services/api';

// How many people have saved each article, for a screenful of cards.
//
// Deliberately the same shape as useCommentCounts: one request for the whole
// visible list rather than a fetch per card, and URLs already counted are not
// re-requested when the list grows by paging.
//
// The number is an aggregate and nothing more - it never says who. A Library is
// self-only, and this asks the server for a count, never a list.
//
// What comes back counts *people*, so the local adjustment below has to as
// well: saving the same article onto a second shelf is not a second save.

interface CountsResponse {
  counts: Record<string, number>;
}

export function useSaveCounts(urls: string[]) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());

  const key = urls.join(' ');

  useEffect(() => {
    const pending = urls.filter(u => u && !requested.current.has(u));
    if (pending.length === 0) return;
    for (const u of pending) requested.current.add(u);

    let cancelled = false;
    apiPost<CountsResponse>('/api/v1/reading-list/counts', { urls: pending })
      .then(data => {
        if (cancelled || !data?.counts) return;
        setCounts(prev => ({ ...prev, ...data.counts }));
      })
      .catch(() => {
        // Let a later render retry rather than showing a wrong count forever
        for (const u of pending) requested.current.delete(u);
      });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The viewer just joined or left the count. Called only where their own saved
   * state actually flips - filing an already-saved article onto another shelf
   * passes 0 - because the server counts distinct people.
   *
   * Optimistic, and the card's Save button is the thing it follows: a number
   * that waits for a round-trip to move is a number nobody believes moved
   * because of them. It cannot go below zero, since an unsave arriving before
   * the first count lands would otherwise leave -1 on the card.
   */
  const adjust = useCallback((url: string, delta: number) => {
    if (!delta) return;
    setCounts(prev => {
      // Nothing counted for this URL yet, so there is nothing to move: the
      // number this card will show is whatever the request in flight returns.
      // That answer can be a beat stale if the save raced it; the next load
      // settles it, and a card with no number yet has nothing visibly wrong.
      if (prev[url] === undefined) return prev;
      return { ...prev, [url]: Math.max(0, prev[url] + delta) };
    });
  }, []);

  return { counts, adjust };
}
