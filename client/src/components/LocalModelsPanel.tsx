import { useState, useEffect, useCallback } from 'react';
import {
  LocalModel, PullState, localModels, pullStatus, startPull, removeModel,
} from '../services/aiTasks';
import { fetchSiteModels, SiteModel } from '../services/siteModels';
import { apiErrorText } from '../services/api';
import styles from './AiTasksPanel.module.css';

/**
 * The weights on the operator's own box: what is downloaded, what is in VRAM,
 * and pulling more.
 *
 * **Self-hiding, and that is the important behaviour.** `models: null` from the
 * server means the endpoint did not answer Ollama's `/api/tags` — which is the
 * correct, non-error answer for a vLLM, LM Studio, Groq or OpenRouter endpoint.
 * A panel that showed "failed to load models" for a Groq endpoint that is
 * working perfectly would be worse than no panel, so this draws nothing at all
 * unless it is looking at an Ollama box.
 */

const GB = 1024 ** 3;

function sizeText(bytes: number): string {
  if (!bytes) return '';
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default function LocalModelsPanel() {
  const [endpoints, setEndpoints] = useState<SiteModel[]>([]);
  const [selected, setSelected] = useState('');
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [pulling, setPulling] = useState<PullState | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void fetchSiteModels()
      .then((res: { models: SiteModel[] }) => {
        setEndpoints(res.models);
        const first = res.models.find((m: SiteModel) => m.isDefault) ?? res.models[0];
        if (first) setSelected(first.id);
      })
      .catch(() => { /* the panel above already reports endpoint failures */ });
  }, []);

  const reload = useCallback(async () => {
    if (!selected) return;
    try {
      const res = await localModels(selected);
      setModels(res.models);
      setPulling(res.pulling);
    } catch (e) {
      setError(apiErrorText(e, 'Could not read that box.'));
    } finally {
      setLoaded(true);
    }
  }, [selected]);

  useEffect(() => { void reload(); }, [reload]);

  // Poll only while something is downloading. A pull is minutes long and the
  // only moving number on the screen; polling when nothing is running would be
  // a request every two seconds for a panel nobody is watching.
  useEffect(() => {
    if (!pulling) return;
    const t = setInterval(() => {
      void pullStatus().then(res => {
        setPulling(res.pulling);
        // Finished: refresh the list so the new model appears without a manual
        // reload, which is the moment the operator is waiting for.
        if (!res.pulling) void reload();
      }).catch(() => {});
    }, 2_000);
    return () => clearInterval(t);
  }, [pulling, reload]);

  async function pull() {
    if (!name.trim() || !selected) return;
    setBusy(true);
    setError('');
    try {
      await startPull(selected, name.trim());
      setName('');
      setPulling({ model: name.trim(), progress: { status: 'starting', completed: 0, total: 0 } });
    } catch (e) {
      setError(apiErrorText(e, 'Could not start that pull.'));
    } finally { setBusy(false); }
  }

  async function remove(model: string) {
    if (!confirm(`Delete ${model} from the box? Only another download brings it back.`)) return;
    setBusy(true);
    try {
      await removeModel(selected, model);
      await reload();
    } catch (e) {
      setError(apiErrorText(e, 'Could not delete that model.'));
    } finally { setBusy(false); }
  }

  // Not an Ollama endpoint, or nothing configured. Draw nothing.
  if (!loaded || models === null) return null;

  const pct = pulling && pulling.progress.total > 0
    ? Math.round((pulling.progress.completed / pulling.progress.total) * 100)
    : null;

  return (
    <>
      <div className={styles.sectionTitle}>
        Downloaded models
        <span className={styles.sectionNote}>on this box</span>
      </div>

      {endpoints.length > 1 && (
        <div className={styles.actions}>
          <select className={styles.select} value={selected} onChange={e => setSelected(e.target.value)}>
            {endpoints.map(m => (
              <option key={m.id} value={m.id}>{m.label || m.baseUrl}</option>
            ))}
          </select>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {pulling && (
        <div className={styles.notice}>
          Downloading <strong>{pulling.model}</strong> — {pulling.progress.status}
          {pct !== null && ` · ${pct}%`}
          {pulling.progress.total > 0 && ` (${sizeText(pulling.progress.completed)} of ${sizeText(pulling.progress.total)})`}
        </div>
      )}

      {models.length === 0 && <div className={styles.empty}>Nothing downloaded on this box yet.</div>}

      {models.map(m => (
        <div key={m.name} className={styles.row}>
          <div className={styles.rowHead}>
            <span className={styles.label}>{m.name}</span>
            {/* The thing the usage panel can only infer from latency. If two
                tasks run different models and only one is ever resident, every
                alternation is an unload and a reload. */}
            {m.loaded && <span className={styles.enforcing}>in VRAM</span>}
            <span className={styles.model}>
              {[m.parameterSize, m.quantization, sizeText(m.sizeBytes)].filter(Boolean).join(' · ')}
            </span>
          </div>
          <div className={styles.rowActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.danger}`}
              onClick={() => remove(m.name)}
              disabled={busy || !!pulling}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Download a model</span>
          <input
            className={styles.input}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="qwen3:30b-a3b"
            disabled={!!pulling}
            spellCheck={false}
            // No datalist here on purpose: a pull names a model the box does
            // *not* have, so the downloaded list is the wrong set to suggest
            // from. This only stops the browser covering the field with its
            // own saved-value dropdown.
            autoComplete="off"
          />
          <span className={styles.hint}>
            An Ollama model name. This downloads several gigabytes onto the box and cannot be
            paused — check it has the space first.
          </span>
        </label>
        <div className={styles.formActions}>
          <button type="button" className={styles.primary} onClick={pull} disabled={busy || !!pulling || !name.trim()}>
            {pulling ? 'A download is running' : 'Download'}
          </button>
        </div>
      </div>
    </>
  );
}
