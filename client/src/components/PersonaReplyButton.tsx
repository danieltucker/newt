import { useState, useRef, useEffect } from 'react';
import { Persona, personaReply } from '../services/personas';
import { apiErrorText } from '../services/api';
import styles from './PersonaReplyButton.module.css';

/**
 * The admin control that has a persona answer one comment.
 *
 * **This posts immediately.** There is no draft and no preview: picking a
 * persona generates a reply and publishes it under that persona's name, in
 * public, in this thread. The menu says so, and the button reports which
 * persona wrote rather than a bare "done" — the whole risk of this control is
 * that an admin forgets which account they just spoke as.
 *
 * Only rendered for admins, and only on public comments, matching what the
 * server will accept (a persona has no friends, so it can't answer a
 * friends-only comment). Both gates are cosmetic; routes/adminPersonas.ts is
 * what refuses.
 */

interface Props {
  commentId: string;
  /** Active personas only — the caller filters, so a paused one is never offered. */
  personas: Persona[];
  /** Whether the instance has a model configured. False disables the control. */
  ready: boolean;
  /** Reload the thread so the new reply appears in place. */
  onPosted: () => void;
}

export default function PersonaReplyButton({ commentId, personas, ready, onPosted }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Close on an outside click or Escape. Registered only while open, so a thread
  // of fifty comments doesn't carry fifty idle listeners.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function run(p: Persona) {
    setBusy(p.id);
    setError('');
    try {
      await personaReply(p.id, commentId);
      setOpen(false);
      onPosted();
    } catch (e) {
      setError(apiErrorText(e, 'Could not generate a reply.'));
    } finally {
      setBusy('');
    }
  }

  if (personas.length === 0) return null;

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(o => !o)}
        disabled={!ready || busy !== ''}
        title={ready
          ? 'Have a persona reply to this comment. Posts immediately.'
          : 'No instance model is configured — see Admin → Personas'}
        aria-expanded={open}
      >
        {busy ? 'Writing…' : 'Persona reply'}
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuNote}>Posts publicly, straight away.</div>
          {personas.map(p => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => void run(p)}
              disabled={busy !== ''}
            >
              <span className={styles.menuName}>{p.user.displayName}</span>
              <span className={styles.menuHandle}>@{p.user.username}</span>
            </button>
          ))}
        </div>
      )}

      {error && <span className={styles.error}>{error}</span>}
    </span>
  );
}
