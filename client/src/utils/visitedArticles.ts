// Which saved articles you've actually opened.
//
// This replaces the "Done with this?" prompt that used to appear over a card
// when you came back from reading it. That prompt asked a question at the worst
// moment - you'd just returned from an article and it covered the head of the
// card with two buttons and a countdown - and it only ever knew about the one
// article you'd opened most recently. What people want from a reading list is
// the much quieter thing a browser has always done for links: show which ones
// you've been to, and get out of the way.
//
// Local, not server-side. This is the same contract as `:visited` - it's about
// what happened on this device, not a property of the article - and it means
// opening something doesn't need a round trip to be visible on the card. The
// cost is that it doesn't follow you to another browser, which is the accepted
// trade for `:visited` too.
//
// Ids only, so nothing here identifies an article to anyone reading the store.

const KEY = 'newt:rl-visited';

/**
 * Kept at a size where the list stays small in storage and the oldest entries
 * age out on their own. A reading list is a working pile - a few hundred at a
 * time - so this is generous enough that nothing you can still see on screen
 * gets forgotten.
 */
const LIMIT = 800;

/** Insertion order, oldest first, so trimming drops what you opened longest ago. */
function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Private-mode storage, a quota error, or something else's key at ours.
    // Visited state is a nicety; never let it take the list down with it.
    return [];
  }
}

function write(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {}
}

export function loadVisited(): Set<string> {
  return new Set(read());
}

/**
 * Records an open and returns the new set, or null when the id was already
 * known - the caller can skip a re-render on the common case of re-opening
 * something you'd been to before.
 */
export function markVisited(id: string): Set<string> | null {
  const ids = read();
  if (ids.includes(id)) return null;
  ids.push(id);
  write(ids.length > LIMIT ? ids.slice(ids.length - LIMIT) : ids);
  return new Set(ids);
}

/**
 * Nothing in the UI calls this yet - there is deliberately no "clear visited"
 * control, because the reading list has just had a row of chrome taken out of
 * it and this would be the first thing to put back. It exists so that whoever
 * adds one (a console command is the natural home) doesn't have to reach into
 * the key by hand.
 */
export function clearVisited(): void {
  try { localStorage.removeItem(KEY); } catch {}
}
