import { useState, useEffect } from 'react';
import { loadExploreTasks, runExploreTask, ExploreTaskSummary } from '../services/aiTasks';
import { apiErrorText } from '../services/api';
import styles from './ExploreTaskButton.module.css';

/**
 * The admin control on an article: have the instance explore it.
 *
 * What replaced PersonaArticleActions, and the shrinkage is the point. That
 * component offered three verbs — comment, angles, post — because a persona was
 * an author and an author can do three things. There is no author now, so there
 * is one verb, and it produces a research thread rather than a comment under a
 * name.
 *
 * Renders nothing for a non-admin, which is almost everybody: the task list
 * comes back empty for them (the route is admin-only), so this costs an
 * ordinary reader one memoised request per session and no pixels.
 *
 * **Nothing this button does is visible to readers.** The generated thread is
 * created private and appears in the article's Explored paths only once an
 * admin publishes it from Admin → AI. The result line says so rather than
 * saying "done", for the same reason the old component named which of its three
 * verbs had happened: an admin should never be surprised by what they just
 * caused.
 */

interface Props {
  url: string;
  title: string;
}

export default function ExploreTaskButton({ url }: Props) {
  const [tasks, setTasks] = useState<ExploreTaskSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void loadExploreTasks().then(ctx => {
      if (cancelled) return;
      setTasks(ctx.tasks);
      setReady(ctx.configured);
    });
    return () => { cancelled = true; };
  }, []);

  if (tasks.length === 0) return null;

  async function run(task: ExploreTaskSummary) {
    if (busy) return;
    setBusy(true);
    setError('');
    setResult('');
    try {
      const res = await runExploreTask(task.id, url);
      // Queued, not done. The work happens on a single worker behind whatever
      // else is waiting, so claiming it had finished would be a lie roughly as
      // often as the box is busy.
      //
      // Which of the two outcomes it will be is the task's autoPublish config,
      // which the person pressing this cannot see — so the server sends it back
      // rather than letting a thread appear publicly as a surprise.
      setResult(
        !res.queued ? `Skipped: ${res.reason}.`
        : res.willPublish
          ? 'Queued. It will publish to this article when it finishes.'
          : 'Queued. It will wait in Admin → AI for you to publish it.',
      );
      setOpen(false);
    } catch (e) {
      setError(apiErrorText(e, 'Could not queue that.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(o => !o)}
        disabled={busy || !ready}
        aria-expanded={open}
        title={ready ? undefined : 'No site model is configured'}
      >
        {busy ? 'Queueing…' : 'Explore this'}
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <p className={styles.note}>
            Generates a research thread about this article, on the instance’s own model.
          </p>
          {tasks.map(task => (
            <button
              key={task.id}
              type="button"
              className={styles.item}
              role="menuitem"
              onClick={() => run(task)}
              disabled={busy}
            >
              {task.label || 'Explore task'}
              {task.model && <span className={styles.model}>{task.model}</span>}
            </button>
          ))}
        </div>
      )}

      {result && <span className={styles.result}>{result}</span>}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
