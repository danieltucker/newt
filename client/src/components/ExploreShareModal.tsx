import { useEffect, useMemo, useState } from 'react';
import styles from './ExploreShareModal.module.css';
import { CommentVisibility } from '../types';
import { ResearchMessage, setThreadVisibility, apiErrorText } from '../services/llm';
import { VIS_ORDER, VIS_META } from './VisibilityMeta';
import { sharedExplorePathFor } from '../utils/exploreShareUrl';
import CloseButton from './CloseButton';

// Sharing an explore thread.
//
// This is a dialog rather than a menu item, and the reason is the whole design:
// **an explore transcript is not only what you typed.** The server feeds the
// model your own comments on the article - including the `private` tier, which
// this app calls a Personal Note - and, when the article's text can't be found,
// your reading-list notes. The model quotes that material back as a matter of
// course. A thread can therefore contain writing you never meant anyone to see
// and have long forgotten was in scope.
//
// So the control is not a switch. It is a preview of every turn that is about
// to become visible, with the tiers underneath it. Flipping a toggle labelled
// "Public" would have been one click to publish a private note, and no amount
// of warning copy makes that an acceptable way to ask.
//
// The wording of the tiers themselves comes from VisibilityMeta, the same
// source the comment and post composers read, so the three tiers cannot come to
// mean different things in different corners of the app.

interface Props {
  threadId: string;
  title: string;
  visibility: CommentVisibility;
  messages: ResearchMessage[];
  /** Told the new tier once it has been saved, so the page can update. */
  onChanged: (v: CommentVisibility) => void;
  onClose: () => void;
}

// Explore threads are published writing rather than notes, so they read the way
// posts do: 'private' is not a "personal note" here, it is simply unshared.
const TIER_COPY: Record<CommentVisibility, { label: string; hint: string }> = {
  public:  { label: 'Anyone',  hint: 'Readable by anyone with the link, signed in or not, and listed on the article' },
  friends: { label: 'Friends', hint: 'Only your accepted friends, and listed on the article for them' },
  private: { label: 'Just me', hint: 'Nobody else can open it and it is listed nowhere' },
};

export default function ExploreShareModal({
  threadId, title, visibility, messages, onChanged, onClose,
}: Props) {
  const [choice, setChoice] = useState<CommentVisibility>(visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shareHref = `${window.location.origin}${sharedExplorePathFor(threadId)}`;
  const shared = visibility !== 'private';

  // Both halves of every exchange. Deliberately not trimmed to the answers:
  // what makes a transcript risky to publish is usually the question, and a
  // preview that hid them would be showing the safe half.
  const turns = useMemo(
    () => messages.filter(m => m.body.trim().length > 0),
    [messages],
  );

  async function save() {
    if (busy || choice === visibility) return;
    setBusy(true);
    setError('');
    try {
      await setThreadVisibility(threadId, choice);
      onChanged(choice);
      if (choice === 'private') onClose();
    } catch (e) {
      setError(apiErrorText(e, 'Could not change who can see this'));
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    navigator.clipboard?.writeText(shareHref).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => setError('Could not copy the link - select it and copy by hand'),
    );
  }

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={styles.card}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Share this explore"
      >
        <div className={styles.head}>
          <div className={styles.title}>Share “{title}”</div>
          <CloseButton onClick={onClose} />
        </div>

        <div className={styles.body}>
          {/* Stated plainly and first, because it is the thing the reader
              cannot work out for themselves. Everything else on this screen is
              visible; this is the part that isn't. */}
          <div className={styles.warn}>
            <strong>Read it through before you share it.</strong> An explore is answered
            with your own material: your comments on the article - including private
            ones - and your notes about it can be quoted back inside these answers.
            Sharing publishes the conversation exactly as it appears below.
          </div>

          <div className={styles.previewLabel}>
            {turns.length} message{turns.length === 1 ? '' : 's'}, all of which become visible
          </div>
          <div className={styles.preview}>
            {turns.map(m => (
              <div key={m.id} className={m.role === 'user' ? styles.turnUser : styles.turnAssistant}>
                <div className={styles.turnWho}>{m.role === 'user' ? 'You asked' : 'Answer'}</div>
                {/* Plain text on purpose. This is a safety review, not a
                    reading view - rendered markdown invites skimming, and the
                    point is to actually look at the words. */}
                <div className={styles.turnBody}>{m.body}</div>
              </div>
            ))}
            {turns.length === 0 && (
              <div className={styles.empty}>Nothing in this thread yet.</div>
            )}
          </div>

          <div className={styles.tiers} role="radiogroup" aria-label="Who can see this">
            {VIS_ORDER.map(v => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={choice === v}
                className={`${styles.tier} ${choice === v ? styles.tierActive : ''}`}
                onClick={() => setChoice(v)}
              >
                <span className={styles.tierIcon} aria-hidden>{VIS_META[v].icon}</span>
                <span className={styles.tierText}>
                  <span className={styles.tierLabel}>{TIER_COPY[v].label}</span>
                  <span className={styles.tierHint}>{TIER_COPY[v].hint}</span>
                </span>
              </button>
            ))}
          </div>

          {error && <div className={styles.error}>{error}</div>}

          {/* The link is only worth showing once there is something behind it.
              Offering it while the thread is private would hand over an address
              that 404s for everyone it is sent to. */}
          {shared && (
            <div className={styles.linkRow}>
              <input className={styles.linkField} readOnly value={shareHref} onFocus={e => e.currentTarget.select()} />
              <button className={styles.ghostBtn} onClick={copy}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          )}
        </div>

        <div className={styles.foot}>
          <button className={styles.ghostBtn} onClick={onClose}>Close</button>
          <button
            className={styles.primaryBtn}
            disabled={busy || choice === visibility}
            onClick={save}
          >
            {busy ? 'Saving…'
              : choice === 'private' ? 'Make it private'
              : shared ? 'Update' : 'Share it'}
          </button>
        </div>
      </div>
    </div>
  );
}
