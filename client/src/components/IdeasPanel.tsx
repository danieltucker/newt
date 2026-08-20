import { useRef, useState } from 'react';
import { IdeasReport, postIdeas, apiErrorText } from '../services/llm';
import styles from './IdeasPanel.module.css';

/**
 * Ideas for a post, in the composer.
 *
 * The counterpart to ProofreadPanel at the other end of writing something: that
 * one reads a finished draft, this one is for the blank page and the
 * half-finished one. The author says what they are thinking of writing about,
 * and gets back angles to take, questions the piece would have to answer, and
 * articles out of their own feed worth reading first.
 *
 * What it deliberately does not return is prose. There is no "insert" button
 * here and nothing on screen is a paragraph you could paste, because the moment
 * a composer offers finished sentences the post stops being the author's — the
 * same line ProofreadPanel holds by reporting rather than rewriting. The server
 * prompt is written to match (see IDEAS_SYSTEM); this is the half of that
 * decision the author can actually see.
 *
 * The draft is read at the moment Get ideas is pressed, never watched, so
 * nothing leaves the browser until it is asked for. The HTML goes up rather
 * than the text: the server reads the draft's links out of it and goes and
 * reads those pages too.
 */

interface Props {
  /** Reads the current draft. Called on demand, never on a timer. */
  getDraft: () => { title: string; body: string };
}

/** "Mar 4" for a dated article, '' for an undated one. */
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

/**
 * What the panel says it read, under the results.
 *
 * Worth saying because the difference between "it had your three sources" and
 * "every one of them was behind a paywall" is most of the difference between a
 * thin answer being the model's fault and being nobody's.
 */
function linkNote(read: number, tried: number): string {
  if (tried === 0) return '';
  if (read === 0) return `Couldn’t read ${tried === 1 ? 'the link' : `any of the ${tried} links`} it opened from your draft.`;
  if (read < tried) return `Read ${read} of the ${tried} links it opened from your draft.`;
  return `Read ${read === 1 ? 'one link' : `${read} links`} from your draft.`;
}

export default function IdeasPanel({ getDraft }: Props) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [report, setReport] = useState<IdeasReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    // The prompt is the point of opening this, so put the caret in it. After
    // paint, since the textarea does not exist until this render commits.
    if (next) requestAnimationFrame(() => briefRef.current?.focus());
  }

  async function run() {
    if (busy) return;
    const { title, body } = getDraft();
    setBusy(true);
    setError(null);
    try {
      setReport(await postIdeas(brief.trim(), title, body));
    } catch (err) {
      setReport(null);
      setError(apiErrorText(err, 'Could not come up with anything for this draft.'));
    } finally {
      setBusy(false);
    }
  }

  // Ctrl/Cmd+Enter submits, since Enter has to stay as a newline in a box
  // people are expected to write a paragraph in.
  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
  }

  const note = report ? linkNote(report.linksRead, report.linksTried) : '';

  return (
    <>
      <button type="button" className={styles.trigger} onClick={toggle} aria-expanded={open}>
        {busy ? 'Thinking…' : 'Ideas'}
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.head}>
            <span className={styles.title}>Ideas</span>
            <button
              type="button"
              className={styles.close}
              onClick={() => setOpen(false)}
              aria-label="Close the ideas panel"
            >
              ×
            </button>
          </div>

          <label className={styles.label} htmlFor="ideas-brief">
            What are you thinking of writing about?
          </label>
          <textarea
            id="ideas-brief"
            ref={briefRef}
            className={styles.brief}
            value={brief}
            onChange={e => setBrief(e.target.value)}
            onKeyDown={handleKey}
            rows={3}
            maxLength={2000}
            placeholder="A couple of sentences on the piece you have in mind…"
            disabled={busy}
          />

          <div className={styles.actions}>
            <span className={styles.hint}>
              Reads your draft and any links in it, and searches your feeds.
            </span>
            <button type="button" className={styles.go} onClick={run} disabled={busy}>
              {busy ? 'Thinking…' : report ? 'Try again' : 'Get ideas'}
            </button>
          </div>

          {busy && <p className={styles.status}>Reading your draft and looking through your feeds…</p>}
          {error && <div className={styles.error}>{error}</div>}

          {report && !busy && (
            <>
              {report.summary && <p className={styles.summary}>{report.summary}</p>}

              {report.angles.length > 0 && (
                <ul className={styles.angles}>
                  {report.angles.map((angle, i) => (
                    <li key={i} className={styles.angle}>
                      <span className={styles.angleTitle}>{angle.title}</span>
                      {angle.detail && <p className={styles.angleDetail}>{angle.detail}</p>}
                    </li>
                  ))}
                </ul>
              )}

              {report.questions.length > 0 && (
                <div className={styles.block}>
                  <span className={styles.blockTitle}>Worth answering</span>
                  <ul className={styles.questions}>
                    {report.questions.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
              )}

              {report.related.length > 0 && (
                <div className={styles.block}>
                  <span className={styles.blockTitle}>From your feeds</span>
                  <ul className={styles.related}>
                    {report.related.map(article => (
                      <li key={article.url} className={styles.article}>
                        {/* A new tab, always: the draft is unsaved-ish and
                            sitting in this one. */}
                        <a
                          className={styles.articleLink}
                          href={article.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {article.title || article.url}
                        </a>
                        <span className={styles.articleMeta}>
                          {[article.source, shortDate(article.pubDate)].filter(Boolean).join(' · ')}
                        </span>
                        {article.why && <p className={styles.articleWhy}>{article.why}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.angles.length === 0 && report.related.length === 0 && (
                <p className={styles.status}>
                  Nothing came back worth showing. Try saying more about the piece you have in mind.
                </p>
              )}

              <p className={styles.footnote}>
                {note && <>{note} </>}
                Suggestions from your own model. Nothing here has been added to your draft.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
