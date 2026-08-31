import { useState, useEffect, useCallback } from 'react';
import {
  AiTask, AiOptions, AiJob, QueueStats, TaskKind, TriggerConfig, AutoPublish,
  aiOptions, listTasks, createTask, updateTask, deleteTask,
  listJobs, runScheduledPass, publishThread, discardThread,
} from '../services/aiTasks';
import { apiErrorText } from '../services/api';
import SiteModelsPanel from './SiteModelsPanel';
import ModelUsagePanel from './ModelUsagePanel';
import LocalModelsPanel from './LocalModelsPanel';
import styles from './AiTasksPanel.module.css';

/**
 * Admin → AI. What replaced PersonasPanel.
 *
 * Four sections, in the order an operator meets them: the tasks themselves, the
 * queue those tasks feed, the endpoints they run on, and what the endpoints have
 * been doing. Models and Usage are the existing panels unchanged — that half of
 * the screen was always about the box rather than about personas, which is why
 * it survived the removal intact.
 */

type Section = 'tasks' | 'queue' | 'models' | 'usage';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'queue', label: 'Queue' },
  { id: 'models', label: 'Models' },
  { id: 'usage', label: 'Usage' },
];

/** "40 minutes" for a backlog age. The unit an operator acts on, not a date. */
function ageText(ms: number | null): string {
  if (ms === null) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export default function AiTasksPanel() {
  const [section, setSection] = useState<Section>('tasks');
  const [options, setOptions] = useState<AiOptions | null>(null);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const [opts, { tasks: rows }] = await Promise.all([aiOptions(), listTasks()]);
      setOptions(opts);
      setTasks(rows);
    } catch (e) {
      setError(apiErrorText(e, 'Could not load AI tasks.'));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className={styles.body}>
      <div className={styles.subnav}>
        {SECTIONS.map(s => (
          <button
            key={s.id}
            type="button"
            className={`${styles.subnavBtn} ${section === s.id ? styles.subnavActive : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* Said once, at the top, rather than on each disabled button: with no
          endpoint nothing on this screen can run, and an operator should learn
          that before reading four sections of controls. */}
      {options && !options.configured && (
        <div className={styles.notice}>
          No site model is configured, so no task can run. Add an endpoint under <strong>Models</strong>.
        </div>
      )}

      {section === 'tasks' && options && (
        <TasksSection tasks={tasks} options={options} onChanged={reload} />
      )}
      {section === 'queue' && <QueueSection />}
      {section === 'models' && (
        <>
          <SiteModelsPanel />
          <LocalModelsPanel />
        </>
      )}
      {section === 'usage' && <ModelUsagePanel />}
    </div>
  );
}

// ── Tasks ───────────────────────────────────────────────────────────────────

function TasksSection({ tasks, options, onChanged }: {
  tasks: AiTask[];
  options: AiOptions;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState<TaskKind | null>(null);

  return (
    <>
      <div className={styles.sectionTitle}>
        Tasks
        <span className={styles.sectionNote}>{tasks.length} configured</span>
      </div>

      <div className={styles.actions}>
        {options.kinds.map(kind => (
          <button key={kind} type="button" className={styles.addBtn} onClick={() => setCreating(kind)}>
            Add {kind} task
          </button>
        ))}
      </div>

      {creating && (
        <TaskForm
          kind={creating}
          options={options}
          onCancel={() => setCreating(null)}
          onSaved={() => { setCreating(null); onChanged(); }}
        />
      )}

      {tasks.length === 0 && !creating && (
        <div className={styles.empty}>
          Nothing configured. An <strong>explore</strong> task writes a research thread about an
          article; a <strong>moderate</strong> task screens new comments; a <strong>relate</strong>
          task finds other sites covering the same story.
        </div>
      )}

      {tasks.map(task => (
        editing === task.id ? (
          <TaskForm
            key={task.id}
            kind={task.kind}
            task={task}
            options={options}
            onCancel={() => setEditing(null)}
            onSaved={() => { setEditing(null); onChanged(); }}
          />
        ) : (
          <TaskRow
            key={task.id}
            task={task}
            onEdit={() => setEditing(task.id)}
            onChanged={onChanged}
          />
        )
      ))}
    </>
  );
}

function TaskRow({ task, onEdit, onChanged }: { task: AiTask; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await updateTask(task.id, { enabled: !task.enabled });
      onChanged();
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm(`Delete "${task.label || task.kind}"? Generated explores it produced stay published.`)) return;
    setBusy(true);
    try {
      await deleteTask(task.id);
      onChanged();
    } finally { setBusy(false); }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={styles.kind}>{task.kind}</span>
        <span className={styles.label}>{task.label || <em>unnamed</em>}</span>
        {!task.enabled && <span className={styles.paused}>paused</span>}
        {/* The single most important thing on this screen. A moderate task that
            is enforcing is hiding real people's comments, and that must be
            legible without opening the row. */}
        {task.kind === 'moderate' && (
          <span className={task.trigger.enforce ? styles.enforcing : styles.shadow}>
            {task.trigger.enforce ? 'enforcing' : 'shadow'}
          </span>
        )}
        <span className={styles.model}>{task.siteModel?.model ?? 'site default'}</span>
      </div>

      <div className={styles.triggers}>{triggerSummary(task.trigger, task.kind)}</div>

      <div className={styles.rowActions}>
        <button type="button" className={styles.btn} onClick={onEdit} disabled={busy}>Edit</button>
        <button type="button" className={styles.btn} onClick={toggle} disabled={busy}>
          {task.enabled ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className={`${styles.btn} ${styles.danger}`} onClick={remove} disabled={busy}>
          Delete
        </button>
      </div>
    </div>
  );
}

function triggerSummary(t: TriggerConfig, kind: TaskKind): string {
  if (kind === 'moderate') {
    return t.enforce
      ? 'Screens every new comment and hides what it judges to be abuse.'
      : 'Screens every new comment and records a verdict. Nothing is hidden.';
  }
  if (kind === 'relate') {
    return `Every day, reads the top ${t.relateTopSites} sites and ${t.relateTopSaved} most-saved ` +
      `articles from the last ${t.relateWindowHours}h and links ones covering the same story` +
      `${t.relateCrossSiteOnly ? ', across different sites only' : ''}.`;
  }
  const parts: string[] = [];
  if (t.onAdminRequest) parts.push('the button on an article');
  if (t.onCommentCount) parts.push(`${t.onCommentCount} comments`);
  if (t.onSaveCount) parts.push(`${t.onSaveCount} people saving it`);
  if (t.scheduledTopN) parts.push(`the daily pass (top ${t.scheduledTopN})`);
  const runs = parts.length ? `Runs on: ${parts.join(', ')}.` : 'Nothing triggers this task.';
  const review =
    t.autoPublish === 'always' ? ' Publishes everything without review.'
    : t.autoPublish === 'admin' ? ' Threads you ask for publish immediately; the rest wait.'
    : ' Everything waits for review.';
  return runs + review;
}

function TaskForm({ kind, task, options, onCancel, onSaved }: {
  kind: TaskKind;
  task?: AiTask;
  options: AiOptions;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const fallbackPrompt = options.defaultPrompts[kind] ?? '';

  const [label, setLabel] = useState(task?.label ?? '');
  // Pre-filled with the default rather than showing it as a placeholder.
  //
  // A placeholder is text you can save without ever having read, and the thing
  // being saved here is the instruction the instance will run unattended. It
  // also cannot be edited — you have to retype it from scratch to change one
  // sentence of it — which made the common case (take the default, adjust a
  // line) the most awkward one. The server stores the default too, so what is
  // in this box is exactly what will run. See promptToStore.
  const [prompt, setPrompt] = useState(task?.prompt || fallbackPrompt);
  const [trigger, setTrigger] = useState<TriggerConfig>(task?.trigger ?? options.defaultTrigger);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = { kind, label, prompt, trigger };
      if (task) await updateTask(task.id, body);
      else await createTask(body);
      onSaved();
    } catch (e) {
      setError(apiErrorText(e, 'Could not save that.'));
    } finally { setBusy(false); }
  }

  const set = (patch: Partial<TriggerConfig>) => setTrigger(t => ({ ...t, ...patch }));

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={styles.input}
          value={label}
          onChange={e => setLabel(e.target.value)}
          maxLength={options.limits.label}
          placeholder={kind === 'explore' ? 'Nightly explores' : 'Comment screen'}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Prompt</span>
        <textarea
          className={styles.textarea}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          maxLength={options.limits.prompt}
          rows={12}
          placeholder={fallbackPrompt}
        />
        <span className={styles.hint}>
          This is exactly what the model is told. Newt appends its own safety rules after it —
          those cannot be overridden.{' '}
          {prompt.trim() !== fallbackPrompt.trim() && (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => setPrompt(fallbackPrompt)}
            >
              Reset to the default
            </button>
          )}
        </span>
      </label>

      {kind === 'relate' ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>What to read</legend>
          <p className={styles.hint}>
            Runs once a day with the pass. It reads headlines only — no article pages are
            fetched — and writes a “Also covered by” list onto the articles it pairs up.
          </p>

          <label className={styles.numField}>
            <span>Look back this many hours</span>
            <input
              type="number" min={1} max={168} className={styles.num}
              value={trigger.relateWindowHours}
              onChange={e => set({ relateWindowHours: Number(e.target.value) })}
            />
            <span className={styles.hint}>
              Two sites covering one story publish within hours of each other, so a wide window
              mostly adds noise. 24 is a sensible default; 168 is the ceiling.
            </span>
          </label>

          <label className={styles.numField}>
            <span>From the busiest sites</span>
            <input
              type="number" min={0} max={40} className={styles.num}
              value={trigger.relateTopSites}
              onChange={e => set({ relateTopSites: Number(e.target.value) })}
            />
            <span className={styles.hint}>0 to switch this source off.</span>
          </label>

          <label className={styles.numField}>
            <span>From the most-saved articles</span>
            <input
              type="number" min={0} max={40} className={styles.num}
              value={trigger.relateTopSaved}
              onChange={e => set({ relateTopSaved: Number(e.target.value) })}
            />
            <span className={styles.hint}>0 to switch this source off.</span>
          </label>

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={trigger.relateCrossSiteOnly}
              onChange={e => set({ relateCrossSiteOnly: e.target.checked })}
            />
            Only link articles from different sites
          </label>
          <p className={styles.hint}>
            On is almost always right: the value here is a reader on one site finding that
            another covered the same thing. Two pieces from one outlet are its own follow-up,
            which its page already links to better than this can.
          </p>
        </fieldset>
      ) : kind === 'explore' ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>When to run</legend>

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={trigger.onAdminRequest}
              onChange={e => set({ onAdminRequest: e.target.checked })}
            />
            Show a button on articles
          </label>

          <label className={styles.numField}>
            <span>After this many public comments</span>
            <input
              type="number" min={0} className={styles.num}
              value={trigger.onCommentCount}
              onChange={e => set({ onCommentCount: Number(e.target.value) })}
            />
            <span className={styles.hint}>0 to switch off. Minimum 2.</span>
          </label>

          <label className={styles.numField}>
            <span>After this many people save it</span>
            <input
              type="number" min={0} className={styles.num}
              value={trigger.onSaveCount}
              onChange={e => set({ onSaveCount: Number(e.target.value) })}
            />
            {/* The floor is a privacy rule, not a tuning preference, so it is
                explained here rather than left to be discovered when the number
                springs back to 3. */}
            <span className={styles.hint}>
              0 to switch off. Minimum 3 — saving an article is private, and a lower
              threshold would let a generated explore reveal that one person saved it.
            </span>
          </label>

          <label className={styles.numField}>
            <span>Daily pass: most-discussed articles</span>
            <input
              type="number" min={0} max={10} className={styles.num}
              value={trigger.scheduledTopN}
              onChange={e => set({ scheduledTopN: Number(e.target.value) })}
            />
            <span className={styles.hint}>0 to switch off. At most 10.</span>
          </label>

          {/* The review switch. Split by *which trigger produced the thread*
              rather than being one on/off, because the two cases are not alike:
              pressing the button on an article is already a human decision, and
              asking for a second one is a signature on the same page twice. An
              article the nightly pass chose has had no such moment. */}
          <label className={styles.numField}>
            <span>Publish without review</span>
            <select
              className={styles.select}
              value={trigger.autoPublish}
              onChange={e => set({ autoPublish: e.target.value as AutoPublish })}
            >
              <option value="never">Never — everything waits for me</option>
              <option value="admin">When I press the button on an article</option>
              <option value="always">Always, including the daily pass</option>
            </select>
            <span className={styles.hint}>
              {trigger.autoPublish === 'never' && 'Every generated thread waits in the Queue until you publish it.'}
              {trigger.autoPublish === 'admin' && 'Threads you ask for go live on the article immediately. The automatic triggers still wait for you.'}
              {trigger.autoPublish === 'always' && 'Every thread goes live, including ones nobody has read. Worth watching the output for a while first.'}
            </span>
          </label>
        </fieldset>
      ) : (
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>What to do with a verdict</legend>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={trigger.enforce}
              onChange={e => set({ enforce: e.target.checked })}
            />
            Hide comments this task judges to be abuse
          </label>
          <p className={styles.hint}>
            Leave this off to start. Every comment is scored either way and the verdicts appear
            under <strong>Queue</strong>, so you can see how often the model would have been
            wrong before letting it act. Hiding is reversible; nothing here ever deletes a
            comment or bans an account.
          </p>
        </fieldset>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button type="button" className={styles.btn} onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className={styles.primary} onClick={save} disabled={busy}>
          {busy ? 'Saving…' : task ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  );
}

// ── Queue ───────────────────────────────────────────────────────────────────

/** "1m 42s" — a running job's elapsed time, where seconds are the whole point. */
function elapsedText(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * What the worker has in hand right now.
 *
 * Its own block above the list rather than a row inside it, because it answers
 * a different question. The list is a history; this is "is anything happening,
 * and has it hung" — and on a single GPU those are minutes apart. A cold 30B
 * model legitimately takes a couple of minutes to answer, so elapsed time alone
 * is not alarming; passing the queue's own reclaim threshold is, and that is
 * what the warning keys on rather than a number invented here.
 */
function NowRunning({ stats }: { stats: QueueStats }) {
  if (stats.active.length === 0) {
    return (
      <div className={styles.idle}>
        {stats.queued > 0
          ? `Idle — ${stats.queued} job${stats.queued === 1 ? '' : 's'} waiting for the next tick (up to 15s).`
          : 'Idle. Nothing queued.'}
      </div>
    );
  }

  return (
    <>
      {stats.active.map(job => {
        const stuck = job.elapsedMs > stats.staleAfterMs;
        return (
          <div key={job.id} className={`${styles.row} ${styles.runningRow}`}>
            <div className={styles.rowHead}>
              <span className={stuck ? styles.enforcing : styles.status}>
                {stuck ? 'stalled' : 'running'}
              </span>
              <span className={styles.kind}>{job.kind}</span>
              <span className={styles.label}>{job.taskLabel}</span>
              <span className={styles.model}>
                {elapsedText(job.elapsedMs)}
                {job.attempt > 1 && ` · attempt ${job.attempt}`}
                {` · via ${job.trigger}`}
              </span>
            </div>
            <div className={styles.triggers}>
              {job.subject || 'no subject recorded'}
              {stuck && ' — past the point the queue gives up; it will be retried on the next tick.'}
            </div>
          </div>
        );
      })}
    </>
  );
}

function QueueSection() {
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    try {
      const res = await listJobs({ status });
      setJobs(res.jobs);
      setStats(res.stats);
    } catch (e) {
      setError(apiErrorText(e, 'Could not load the queue.'));
    }
  }, [status]);

  useEffect(() => { void reload(); }, [reload]);

  // Poll only while there is something to watch. A job in flight is the one
  // moving thing on this screen, and its elapsed time is the number that says
  // whether it is working or wedged — a static reading of that is worse than
  // none. Idle, this costs nothing.
  const inFlight = (stats?.running ?? 0) > 0 || (stats?.queued ?? 0) > 0;
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => { void reload(); }, 3_000);
    return () => clearInterval(t);
  }, [inFlight, reload]);

  async function pass() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await runScheduledPass();
      // A bare count is what this used to report, and zero — the usual answer —
      // has at least four meanings. Each gets its own sentence, because "0" on
      // its own sends an operator looking for a bug that is not there.
      if (res.noTasks) {
        setNotice('No explore task has the daily pass switched on. Set “Daily pass” above zero on one of them.');
      } else if (res.queued > 0 || res.relateQueued > 0) {
        const parts = [];
        if (res.queued > 0) parts.push(`${res.queued} of ${res.considered} article${res.considered === 1 ? '' : 's'} to explore`);
        if (res.relateQueued > 0) parts.push(`${res.relateQueued} relate run${res.relateQueued === 1 ? '' : 's'}`);
        setNotice(`Queued ${parts.join(' and ')}.`);
      } else if (res.considered === 0) {
        setNotice('Nothing to pick from — no article has been publicly commented on in the last 48 hours.');
      } else {
        const why = res.skipped.map(sk => `${sk.count} ${sk.reason}`).join(', ');
        setNotice(`Nothing queued. All ${res.considered} candidates were skipped: ${why}.`);
      }
      await reload();
    } catch (e) {
      setError(apiErrorText(e, 'Could not run the pass.'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className={styles.sectionTitle}>
        Queue
        {stats && (
          <span className={styles.sectionNote}>
            {stats.queued} waiting, {stats.running} running
            {stats.oldestMs !== null && ` · oldest ${ageText(stats.oldestMs)}`}
            {inFlight && ' · refreshing'}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        <select className={styles.select} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">All</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="done">Done</option>
          <option value="skipped">Skipped</option>
          <option value="failed">Failed</option>
        </select>
        <button type="button" className={styles.btn} onClick={pass} disabled={busy}>
          Run the daily pass now
        </button>
        <button type="button" className={styles.btn} onClick={() => void reload()}>Refresh</button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {notice && (
        <div className={styles.notice}>
          {notice}
          <button className={styles.noticeDismiss} onClick={() => setNotice('')} aria-label="Dismiss">✕</button>
        </div>
      )}

      {stats && <NowRunning stats={stats} />}

      {jobs.length === 0 && <div className={styles.empty}>Nothing here.</div>}

      {jobs.map(job => (
        <JobRow key={job.id} job={job} onChanged={reload} onNotice={setNotice} />
      ))}
    </>
  );
}

function JobRow({ job, onChanged, onNotice }: {
  job: AiJob;
  onChanged: () => void;
  onNotice: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      onNotice(done);
      onChanged();
    } catch (e) {
      onNotice(apiErrorText(e, 'That did not work.'));
    } finally { setBusy(false); }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <span className={`${styles.status} ${styles[`status_${job.status}`] ?? ''}`}>{job.status}</span>
        <span className={styles.kind}>{job.task?.kind ?? 'gone'}</span>
        <span className={styles.label}>{job.task?.label || job.articleUrl || job.subjectId}</span>
        {job.verdict && (
          <span className={job.verdict === 'allow' ? styles.shadow : styles.enforcing}>
            {job.verdict}{job.category && ` · ${job.category}`}
            {job.confidence > 0 && ` · ${Math.round(job.confidence * 100)}%`}
          </span>
        )}
        <span className={styles.model}>{job.trigger}</span>
      </div>

      {job.note && <div className={styles.triggers}>{job.note}</div>}

      {/* Only a generated thread gets these, and only before it is published.
          The two verbs are the whole human-in-the-loop step. */}
      {job.threadId && (
        <div className={styles.rowActions}>
          <a className={styles.btn} href={`/explore/${job.threadId}`} target="_blank" rel="noopener noreferrer">
            Read it
          </a>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => act(() => publishThread(job.threadId!), 'Published. It is on the article page now.')}
          >
            Publish
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.danger}`}
            disabled={busy}
            onClick={() => act(() => discardThread(job.threadId!), 'Discarded.')}
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
