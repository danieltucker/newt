import { useEffect, useState } from 'react';
import styles from './ReportModal.module.css';
import { apiPost } from '../services/api';
import { ReportCategory, ReportTargetType } from '../types';
import CloseButton from './CloseButton';

// One dialog for every kind of report - a comment, a post, a person. What is
// being reported travels as an opaque (type, id) pair; the server resolves it,
// checks the reporter can actually see it, and snapshots the content. Nothing
// the client says about the target is trusted, which is why there is no field
// here for the author's name or the content itself.

// Kept in step with REPORT_CATEGORIES in server/src/lib/reports.ts. Duplicated
// rather than fetched: it is six strings that change with the moderation
// policy, not with the data, and a dropdown that needs a round-trip to render
// is worse than a list that needs a matching edit.
const CATEGORIES: { value: ReportCategory; label: string; hint: string }[] = [
  { value: 'spam',       label: 'Spam or scam',          hint: 'Bulk links, phishing, fake offers' },
  { value: 'harassment', label: 'Harassment or bullying', hint: 'Targeted at someone, repeated or personal' },
  { value: 'hate',       label: 'Hate speech',            hint: 'Attacks a group or protected characteristic' },
  { value: 'sexual',     label: 'Sexual content',         hint: 'Explicit material, or aimed at a minor' },
  { value: 'violence',   label: 'Violence or threats',    hint: 'Threatens harm to someone' },
  { value: 'other',      label: 'Something else',         hint: 'Tell us what’s wrong below' },
];

// Matches MAX_REPORT_NOTE on the server, which is what actually enforces it.
const MAX_NOTE = 1000;

const WHAT: Record<ReportTargetType, string> = {
  comment: 'comment',
  blogPost: 'post',
  user: 'account',
};

interface Props {
  targetType: ReportTargetType;
  targetId: string;
  // Whose content it is, for the dialog's own wording only - never sent.
  subjectName: string;
  onClose: () => void;
}

export default function ReportModal({ targetType, targetId, subjectName, onClose }: Props) {
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'filed' | 'already' | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 'other' says nothing on its own, so it has to be explained - the same rule
  // noteRequiredFor() enforces server-side.
  const noteRequired = category === 'other';
  const canSubmit = category !== null && (!noteRequired || note.trim().length > 0) && note.length <= MAX_NOTE;

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiPost<{ ok: boolean; alreadyReported?: boolean }>('/api/v1/reports', {
        targetType, targetId, category, note: note.trim(),
      });
      setDone(res.alreadyReported ? 'already' : 'filed');
    } catch (e) {
      let msg = 'Could not send this report';
      if (e instanceof Error) {
        try { msg = (JSON.parse(e.message).error as string) || msg; } catch { /* not JSON */ }
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.card} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Report this ${WHAT[targetType]}`}>
        <div className={styles.head}>
          <div className={styles.title}>Report this {WHAT[targetType]}</div>
          <CloseButton onClick={onClose} />
        </div>

        {done ? (
          // The terminal state does two jobs: confirm it arrived, and point at
          // blocking - a report is answered eventually, a block takes effect now.
          <div className={styles.body}>
            <div className={styles.doneWrap}>
              <div className={styles.doneMark} aria-hidden>✓</div>
              <div className={styles.doneTitle}>
                {done === 'already' ? 'You already reported this' : 'Report sent'}
              </div>
              <p className={styles.doneText}>
                {done === 'already'
                  ? 'A moderator already has this one in the queue - reporting it again wouldn’t move it up.'
                  : 'A moderator will review it. You won’t be told the outcome, and the person reported isn’t told who reported them.'}
              </p>
              <p className={styles.doneText}>
                If you’d rather not see {subjectName} at all, blocking them takes effect straight away -
                it’s on their profile.
              </p>
              <button className={styles.primaryBtn} onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.body}>
              <p className={styles.lede}>
                What’s wrong with this {WHAT[targetType]}
                {targetType === 'user' ? '' : ` by ${subjectName}`}?
              </p>

              <div className={styles.options} role="radiogroup" aria-label="Reason">
                {CATEGORIES.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={category === c.value}
                    className={`${styles.option} ${category === c.value ? styles.optionActive : ''}`}
                    onClick={() => setCategory(c.value)}
                  >
                    <span className={styles.optionMark} aria-hidden />
                    <span className={styles.optionText}>
                      <span className={styles.optionLabel}>{c.label}</span>
                      <span className={styles.optionHint}>{c.hint}</span>
                    </span>
                  </button>
                ))}
              </div>

              <label className={styles.noteLabel} htmlFor="report-note">
                {noteRequired ? 'What happened?' : 'Anything else the moderator should know? (optional)'}
              </label>
              <textarea
                id="report-note"
                className={styles.note}
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={MAX_NOTE}
                rows={3}
                placeholder={noteRequired ? 'Describe the problem…' : 'Add context…'}
              />
              {note.length > MAX_NOTE * 0.8 && (
                <div className={styles.charCount}>{note.length.toLocaleString()} / {MAX_NOTE.toLocaleString()}</div>
              )}

              {error && <div className={styles.error}>{error}</div>}
            </div>

            <div className={styles.foot}>
              <span className={styles.footNote}>The person reported isn’t told who reported them.</span>
              <div className={styles.footBtns}>
                <button className={styles.ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
                <button className={styles.primaryBtn} onClick={submit} disabled={!canSubmit || busy}>
                  {busy ? 'Sending…' : 'Send report'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
