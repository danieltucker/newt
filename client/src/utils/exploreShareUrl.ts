// The public address of a shared explore thread.
//
// Deliberately not /explore/<id>, which is the *owner's* view: that route loads
// the whole Explore surface - the thread list, the composer, the model picker -
// and is signed-in only. /e/<id> is the read-only one, it opens for a visitor
// with no account, and it is what the share dialog puts on the clipboard.
//
// Short because it is meant to be pasted somewhere, and distinct because the
// two views of one thread must never be confused for each other: sending
// somebody /explore/<id> would send them to a sign-in wall.

const PREFIX = '/e/';

export function sharedExplorePathFor(id: string): string {
  return PREFIX + encodeURIComponent(id);
}

/** The thread id in a path like /e/<id>, or null if the path isn't one. */
export function parseSharedExplorePath(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const id = pathname.slice(PREFIX.length).replace(/\/+$/, '');
  if (!id) return null;
  try {
    const decoded = decodeURIComponent(id);
    // Thread ids are cuids - a path segment, never a nested path.
    return /^[A-Za-z0-9_-]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
