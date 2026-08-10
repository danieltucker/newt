import { useEffect, useRef, useState } from 'react';
import styles from './FeedOfferPrompt.module.css';

// "This site has a feed - want it?", asked after a bookmark is saved.
//
// Adding a bookmark used to subscribe to the site's feed on its own, silently.
// That is the right guess often enough to be tempting and wrong often enough to
// be a problem: a bookmarked shop, bank or ticket site would quietly start
// dealing its marketing blog into the river, and the only clue was the feed
// manager. Following a publisher is a reading decision, so it gets asked.
//
// Deliberately not a bell notification. The bell is a log of things that already
// happened to you; this is a question with a short shelf life, and an answer
// buried behind a badge would be read long after the bookmark it refers to
// stopped being on the user's mind.

export interface Props {
  /** The publisher's name, as the feed or the tile calls it. */
  title: string;
  /** Follow it. Rejects with a message if the server refuses (cap, blocklist). */
  onFollow: () => Promise<void>;
  /** Dismissed, by button, Escape, or timeout. */
  onDismiss: () => void;
}

// Long enough to notice and read after attention has moved back to the grid,
// short enough that an ignored question doesn't sit on screen forever. Paused
// while hovered or focused - see below.
const DISMISS_AFTER = 12_000;

function RssIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M3 12.5h.01" />
      <path d="M3 8.5a4 4 0 0 1 4 4" />
      <path d="M3 4.5a8 8 0 0 1 8 8" />
    </svg>
  );
}

export default function FeedOfferPrompt({ title, onFollow, onDismiss }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the follow succeeds: the prompt turns into its own confirmation
  // for a moment rather than vanishing, so the answer visibly landed somewhere.
  const [done, setDone] = useState(false);
  const [paused, setPaused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Escape dismisses, like every other transient surface in the app. Capture is
  // wrong here - a modal on top should get the key first - so this is a plain
  // bubble-phase listener.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // The self-dismiss timer, held off while the pointer is over the card or the
  // focus is inside it: a question that disappears mid-read, or mid-tab-to-the-
  // button, is worse than one that overstays. Cleared entirely once answered.
  useEffect(() => {
    if (paused || busy || done) return;
    const t = setTimeout(onDismiss, DISMISS_AFTER);
    return () => clearTimeout(t);
  }, [paused, busy, done, onDismiss]);

  // Confirmation is a beat, not a state - once it's read, the card goes.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onDismiss, 1600);
    return () => clearTimeout(t);
  }, [done, onDismiss]);

  async function follow() {
    setBusy(true);
    setError(null);
    try {
      await onFollow();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't follow that feed");
      setBusy(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className={styles.card}
      // polite, not assertive: this interrupts nothing, and a screen reader
      // should finish what it was saying before announcing it.
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={e => { if (!rootRef.current?.contains(e.relatedTarget as Node)) setPaused(false); }}
    >
      <span className={styles.icon} aria-hidden><RssIcon /></span>
      {done ? (
        <p className={styles.text}>
          Following <strong className={styles.name}>{title}</strong> in your feed.
        </p>
      ) : (
        <>
          <div className={styles.body}>
            <p className={styles.text}>
              <strong className={styles.name}>{title}</strong> publishes a feed. Follow it?
            </p>
            {error && <p className={styles.error}>{error}</p>}
          </div>
          <div className={styles.actions}>
            <button className={styles.ghost} onClick={onDismiss} disabled={busy}>
              No thanks
            </button>
            <button className={styles.primary} onClick={follow} disabled={busy}>
              {busy ? 'Following…' : 'Follow'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
