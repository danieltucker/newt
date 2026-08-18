import { useEffect, useState, useCallback } from 'react';
import {
  SiteModel, SiteModelList, SiteModelDraft,
  fetchSiteModels, createSiteModel, updateSiteModel, deleteSiteModel,
  probeModels, testSiteModel,
} from '../services/siteModels';
import { apiErrorText } from '../services/api';
import styles from './SiteModelsPanel.module.css';

/**
 * Admin → Personas → Models. The endpoints the instance writes with.
 *
 * The screen has one job beyond CRUD: making the **private-host rule** legible
 * before it bites. An admin typing a LAN address needs to know, at that moment,
 * that the host must be listed in OPERATOR_LLM_PRIVATE_HOSTS on the server — not
 * after saving a row that looks fine and failing at the first generation days
 * later. So the allowlist is printed next to the URL field, and the server
 * re-checks on save and returns the same explanation.
 */

const EMPTY: SiteModelDraft = { label: '', baseUrl: '', model: '', apiKey: '', isDefault: false };

/** A private address by inspection, for a hint shown before any request. */
function looksPrivate(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host)) return host;
    // A bare name with no dot is a container or LAN hostname, never public DNS.
    if (!host.includes('.')) return host;
    return null;
  } catch {
    return null;
  }
}

export default function SiteModelsPanel({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<SiteModelList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [draft, setDraft] = useState<SiteModelDraft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [found, setFound] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchSiteModels());
      setError('');
    } catch (e) {
      setError(apiErrorText(e, 'Could not load site models.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function reset() {
    setDraft(EMPTY);
    setEditingId(null);
    setShowForm(false);
    setFound(null);
  }

  async function probe() {
    if (!draft.baseUrl) return;
    setProbing(true);
    setError('');
    try {
      const { models } = await probeModels(draft.baseUrl, draft.apiKey || undefined);
      setFound(models);
      if (models.length === 0) setNotice('That endpoint reported no models. Pull one first.');
    } catch (e) {
      setError(apiErrorText(e, 'Could not read the model list.'));
    } finally {
      setProbing(false);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        // An omitted apiKey leaves the stored one alone; only send it when the
        // admin actually typed something, or the key would be cleared on every
        // unrelated edit.
        const patch: SiteModelDraft = { ...draft };
        if (!patch.apiKey) delete patch.apiKey;
        const updated = await updateSiteModel(editingId, patch);
        setNotice(`Saved ${updated.label || updated.baseUrl}.`);
      } else {
        const created = await createSiteModel(draft);
        setNotice(`Added ${created.label || created.baseUrl}.`);
      }
      reset();
      await load();
      onChanged?.();
    } catch (e) {
      setError(apiErrorText(e, 'Could not save that endpoint.'));
    } finally {
      setSaving(false);
    }
  }

  function startEdit(m: SiteModel) {
    setEditingId(m.id);
    // apiKey deliberately blank: the server never sends it back, and prefilling
    // dots would invite an edit that silently rewrites the key with the dots.
    setDraft({ label: m.label, baseUrl: m.baseUrl, model: m.model, apiKey: '', isDefault: m.isDefault });
    setFound(null);
    setShowForm(true);
  }

  async function act(id: string, fn: () => Promise<unknown>, message?: string) {
    setBusyId(id);
    setError('');
    try {
      await fn();
      if (message) setNotice(message);
      await load();
      onChanged?.();
    } catch (e) {
      setError(apiErrorText(e, 'That did not work.'));
    } finally {
      setBusyId(null);
    }
  }

  async function runTest(m: SiteModel) {
    setBusyId(m.id);
    setError('');
    try {
      const { durationMs, reply } = await testSiteModel(m.id);
      // The duration is the useful half: a cold model on a GPU takes tens of
      // seconds to load, and knowing that is the point of the button.
      setNotice(`${m.label || m.baseUrl} answered in ${(durationMs / 1000).toFixed(1)}s — “${reply}”`);
    } catch (e) {
      setError(apiErrorText(e, 'That endpoint did not answer.'));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className={styles.empty}>Loading…</div>;

  const privateHost = draft.baseUrl ? looksPrivate(draft.baseUrl) : null;
  const hosts = data?.privateHosts ?? [];
  const hostAllowed = privateHost ? hosts.includes(privateHost) : true;

  return (
    <div className={styles.wrap}>
      {error && <div className={styles.error}>{error}</div>}
      {notice && (
        <div className={styles.notice}>
          {notice}
          <button className={styles.noticeDismiss} onClick={() => setNotice('')} aria-label="Dismiss">✕</button>
        </div>
      )}

      <p className={styles.blurb}>
        Endpoints the instance generates with. These are paid for by you, not by the account
        using them, and are used only by AI personas — everyone’s research and proofreading
        still runs on their own key.
      </p>

      {data?.env && data.models.length === 0 && (
        <div className={styles.envNote}>
          Currently using the endpoint from the server’s environment:{' '}
          <code>{data.env.model}</code> at <code>{data.env.baseUrl}</code>.
          Adding one below replaces it.
        </div>
      )}

      {!showForm && (
        <button className={styles.primary} onClick={() => { setDraft(EMPTY); setShowForm(true); }}>
          Add endpoint
        </button>
      )}

      {showForm && (
        <div className={styles.form}>
          <h4 className={styles.formTitle}>{editingId ? 'Edit endpoint' : 'Add endpoint'}</h4>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name</span>
            <input
              className={styles.input}
              value={draft.label ?? ''}
              onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
              placeholder="3090 box"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Base URL</span>
            <input
              className={styles.input}
              value={draft.baseUrl ?? ''}
              onChange={e => { setDraft(d => ({ ...d, baseUrl: e.target.value })); setFound(null); }}
              placeholder="http://ollama:11434/v1"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {/* The rule, said where it applies rather than in a help page. */}
            {privateHost && (
              <span className={hostAllowed ? styles.fieldHint : styles.fieldWarn}>
                {hostAllowed
                  ? `“${privateHost}” is a private address, and is allowlisted on this server.`
                  : `“${privateHost}” is a private address and is not allowlisted, so this will be refused. ` +
                    `Add it to OPERATOR_LLM_PRIVATE_HOSTS on the server and restart. ` +
                    (hosts.length ? `Currently allowed: ${hosts.join(', ')}.` : 'Nothing is allowed yet.')}
              </span>
            )}
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>API key</span>
            <input
              className={styles.input}
              type="password"
              value={draft.apiKey ?? ''}
              onChange={e => setDraft(d => ({ ...d, apiKey: e.target.value }))}
              placeholder={editingId ? 'Leave blank to keep the stored key' : 'Leave blank — a local Ollama has no auth'}
              autoComplete="new-password"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Model</span>
            <div className={styles.modelRow}>
              <input
                className={styles.input}
                value={draft.model ?? ''}
                onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
                placeholder="llama3.1:8b"
                spellCheck={false}
                list="site-model-options"
              />
              <button
                className={styles.secondary}
                onClick={() => void probe()}
                disabled={!draft.baseUrl || probing}
                title="Ask the endpoint which models it serves"
              >
                {probing ? 'Asking…' : 'List models'}
              </button>
            </div>
            {found && found.length > 0 && (
              <>
                <datalist id="site-model-options">
                  {found.map(m => <option key={m} value={m} />)}
                </datalist>
                <span className={styles.fieldHint}>
                  {found.length} available — click the field for the list.
                </span>
              </>
            )}
          </label>

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.isDefault ?? false}
              onChange={e => setDraft(d => ({ ...d, isDefault: e.target.checked }))}
            />
            <span>Use this by default for every persona</span>
          </label>

          <div className={styles.formActions}>
            <button className={styles.primary} onClick={() => void save()} disabled={saving || !draft.baseUrl || !draft.model}>
              {saving ? 'Saving…' : editingId ? 'Save' : 'Add'}
            </button>
            <button className={styles.secondary} onClick={reset} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}

      {data && data.models.length === 0 ? (
        <div className={styles.empty}>No endpoints yet.</div>
      ) : (
        <ul className={styles.list}>
          {data?.models.map(m => (
            <li key={m.id} className={`${styles.item} ${m.enabled ? '' : styles.itemOff}`}>
              <div className={styles.itemHead}>
                <span className={styles.name}>{m.label || m.baseUrl}</span>
                {m.isDefault && <span className={styles.tag}>Default</span>}
                {!m.enabled && <span className={styles.tagMuted}>Disabled</span>}
              </div>
              <div className={styles.meta}><code>{m.model}</code> at <code>{m.baseUrl}</code></div>
              <div className={styles.meta}>
                {m.keyLast4 ? `Key ending ${m.keyLast4}` : 'No key'}
                {m.createdBy && <> · added by {m.createdBy}</>}
              </div>

              {confirmId === m.id ? (
                <div className={styles.confirm}>
                  <span>
                    Remove <strong>{m.label || m.baseUrl}</strong>? Personas using it fall back to
                    the default. Its usage history is kept.
                  </span>
                  <div className={styles.itemActions}>
                    <button
                      className={styles.danger}
                      disabled={busyId === m.id}
                      onClick={() => void act(m.id, async () => {
                        const { personasAffected } = await deleteSiteModel(m.id);
                        setConfirmId(null);
                        setNotice(personasAffected > 0
                          ? `Removed. ${personasAffected} persona${personasAffected === 1 ? '' : 's'} moved to the default.`
                          : 'Removed.');
                      })}
                    >
                      Remove
                    </button>
                    <button className={styles.secondary} onClick={() => setConfirmId(null)}>Keep</button>
                  </div>
                </div>
              ) : (
                <div className={styles.itemActions}>
                  <button className={styles.secondary} onClick={() => void runTest(m)} disabled={busyId === m.id}>
                    {busyId === m.id ? 'Testing…' : 'Test'}
                  </button>
                  <button className={styles.secondary} onClick={() => startEdit(m)}>Edit</button>
                  {!m.isDefault && m.enabled && (
                    <button
                      className={styles.secondary}
                      disabled={busyId === m.id}
                      onClick={() => void act(m.id, () => updateSiteModel(m.id, { isDefault: true }), 'Default changed.')}
                    >
                      Make default
                    </button>
                  )}
                  <button
                    className={styles.secondary}
                    disabled={busyId === m.id}
                    onClick={() => void act(m.id, () => updateSiteModel(m.id, { enabled: !m.enabled }))}
                  >
                    {m.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className={styles.dangerGhost} onClick={() => setConfirmId(m.id)}>Remove</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
