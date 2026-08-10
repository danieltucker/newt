import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/api';

/** What the search dropdown needs to draw a feed result. */
export interface FeedSearchHit {
  id: string;
  url: string;
  title: string;
  source: string;
  categories?: string[];
}

/**
 * Long enough that typing a word is one request rather than six, short enough
 * that the results feel like they belong to the keystroke that caused them.
 */
const DEBOUNCE_MS = 180;

/** Matches the server's floor — below it there is nothing worth asking about. */
const MIN_LEN = 2;

/**
 * Searches the whole archive of the user's subscribed feeds, server-side.
 *
 * This replaces a snapshot: the client used to pull the 200 newest articles once
 * at mount and filter that array, so anything older than a day or two of a busy
 * river was not merely unranked but absent. The trade is a request per query
 * instead of per session, which is why it debounces and why it aborts.
 *
 * Aborting matters more than the debounce does. Responses to "sch", "scho" and
 * "school" can arrive in any order, and a late one for a prefix the user has
 * already typed past would overwrite the results for the query actually in the
 * box. The AbortController makes that structurally impossible rather than
 * something a sequence number has to catch.
 */
export function useFeedSearch(query: string): FeedSearchHit[] {
  const [hits, setHits] = useState<FeedSearchHit[]>([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const raw = query.trim();
    // A slash shortcut is a command, not a search — "/g weather" is on its way
    // to Google and has no business hitting our database on the way.
    const tagged = raw.startsWith('#');
    const term = tagged ? raw.slice(1).trim() : raw;

    if (raw.startsWith('/') || term.length < MIN_LEN) {
      abort.current?.abort();
      setHits([]);
      return;
    }

    const timer = setTimeout(() => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      const params = new URLSearchParams({ q: term });
      if (tagged) params.set('mode', 'tag');

      apiFetch(`/api/v1/feeds/search?${params}`, { signal: controller.signal })
        .then(r => (r.ok ? r.json() : null))
        .then((data: { articles: FeedSearchHit[] } | null) => {
          if (!controller.signal.aborted) setHits(data?.articles ?? []);
        })
        // Abort lands here too, and means the query moved on — not a failure,
        // and specifically not a reason to clear results the user can see.
        .catch(() => {});
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  // Tear down on unmount only; the effect above owns the in-flight request
  // while the component is alive.
  useEffect(() => () => abort.current?.abort(), []);

  return hits;
}
