import { useState } from 'react';
import { ProofreadReport, ProofreadIssue, ProofreadKind, proofread, apiErrorText } from '../services/llm';
import styles from './ProofreadPanel.module.css';

/**
 * The proofreader, in the composer.
 *
 * It reports and does not rewrite — deliberately. A button that silently
 * replaces an author's sentences with a model's is not proofreading, it is
 * ghostwriting, and it is very hard to undo once you have accepted twenty of
 * them. Every finding here is a quote, a reason and a suggestion; the author
 * makes the change.
 *
 * The draft is read at the moment the button is pressed rather than watched,
 * so nothing is sent anywhere until it is asked for.
 */

interface Props {
  /** Reads the current draft. Called on demand, never on a timer. */
  getDraft: () => { title: string; body: string };
}

const KIND_LABEL: Record<ProofreadKind, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  clarity: 'Clarity',
  consistency: 'Consistency',
  style: 'Style',
};

// Errors first, taste last — the order the report is worth reading in, which is
// not necessarily the order it arrives in.
const KIND_ORDER: ProofreadKind[] = ['spelling', 'grammar', 'clarity', 'consistency', 'style'];

function sortIssues(issues: ProofreadIssue[]): ProofreadIssue[] {
  return [...issues].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

export default function ProofreadPanel({ getDraft }: Props) {
  const [report, setReport] = useState<ProofreadReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function run() {
    if (busy) return;
    const { title, body } = getDraft();
    setBusy(true);
    setError(null);
    setOpen(true);
    try {
      setReport(await proofread(title, body));
    } catch (err) {
      setReport(null);
      setError(apiErrorText(err, 'Could not proofread this draft.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={styles.trigger} onClick={run} disabled={busy}>
        {busy ? 'Reading…' : 'Proofread'}
      </button>

      {open && (busy || report || error) && (
        <div className={styles.panel}>
          <div className={styles.head}>
            <span className={styles.title}>Proofread</span>
            <button
              type="button"
              className={styles.close}
              onClick={() => setOpen(false)}
              aria-label="Close the proofreading report"
            >
              ×
            </button>
          </div>

          {busy && <p className={styles.status}>Reading your draft…</p>}
          {error && <div className={styles.error}>{error}</div>}

          {report && !busy && (
            <>
              {report.summary && <p className={styles.summary}>{report.summary}</p>}
              {report.readability && (
                <p className={styles.readability}>
                  <span className={styles.readabilityLabel}>Readability</span> {report.readability}
                </p>
              )}

              {report.issues.length === 0 ? (
                <p className={styles.clean}>Nothing flagged. It reads clean.</p>
              ) : (
                <ul className={styles.issues}>
                  {sortIssues(report.issues).map((issue, i) => (
                    <li key={i} className={styles.issue}>
                      <span className={`${styles.kind} ${styles[issue.kind]}`}>
                        {KIND_LABEL[issue.kind]}
                      </span>
                      {/* The quote is what makes a finding actionable: it is the
                          string to search the draft for. Selectable, not a link
                          — the editor is uncontrolled and jumping its cursor
                          from out here would fight whatever is being typed. */}
                      <blockquote className={styles.quote}>{issue.quote}</blockquote>
                      <p className={styles.suggestion}>{issue.suggestion}</p>
                    </li>
                  ))}
                </ul>
              )}

              <p className={styles.footnote}>
                Suggestions from your own model. Nothing here has been changed in your draft.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
