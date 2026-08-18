import { useEffect, useState, useCallback } from 'react';
import {
  Persona, PersonaOptions, PersonaDraft,
  fetchPersonas, fetchPersonaOptions, createPersona, updatePersona, deletePersona,
} from '../services/personas';
import { SiteModel, fetchSiteModels } from '../services/siteModels';
import { apiErrorText } from '../services/api';
import PersonaBadge from './PersonaBadge';
import SiteModelsPanel from './SiteModelsPanel';
import ModelUsagePanel from './ModelUsagePanel';
import styles from './PersonasPanel.module.css';

/**
 * Admin → Personas. Where the instance's AI accounts are made and tuned.
 *
 * Its own component rather than another branch inside AdminPage, which is
 * already 3,400 lines: nothing here shares state or a helper with the
 * moderation and feed tabs, and a panel that owns its own fetching can be
 * mounted lazily when the tab is first opened.
 *
 * The screen is built around one claim it has to keep making: **these accounts
 * are labelled.** The AI badge next to each name is the same component readers
 * see on a comment, on purpose — an admin should be looking at exactly what
 * everybody else looks at, not at an admin-only rendering that could drift from
 * it.
 */

const EMPTY_DRAFT: PersonaDraft = {
  voice: 'neutral',
  verbosity: 'balanced',
  formality: 'neutral',
  interests: [],
  guidance: '',
  displayName: '',
  username: '',
  siteModelId: null,
};

type Section = 'personas' | 'models' | 'usage';

interface DialProps {
  label: string;
  options: { id: string; label: string; hint: string }[];
  value: string;
  onChange: (v: string) => void;
}

/**
 * One tone dial, as a radio group.
 *
 * A radio group and not a `<select>` because the hint is the point: the labels
 * ("Wry", "Blunt") are too terse to choose between on their own, and a dropdown
 * hides every option's explanation behind an interaction.
 */
function Dial({ label, options, value, onChange }: DialProps) {
  return (
    <fieldset className={styles.dial}>
      <legend className={styles.dialLegend}>{label}</legend>
      <div className={styles.dialOptions}>
        {options.map(o => (
          <label key={o.id} className={`${styles.dialOption} ${value === o.id ? styles.dialOptionOn : ''}`}>
            <input
              type="radio"
              name={`${label}-${o.id}`}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
            />
            <span className={styles.dialLabel}>{o.label}</span>
            <span className={styles.dialHint}>{o.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function PersonasPanel() {
  const [section, setSection] = useState<Section>('personas');
  const [options, setOptions] = useState<PersonaOptions | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [models, setModels] = useState<SiteModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [draft, setDraft] = useState<PersonaDraft>(EMPTY_DRAFT);
  const [interestText, setInterestText] = useState('');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // The model list is needed here, not only in the Models section: the
      // persona form offers it as a picker, and the list rows name the endpoint
      // each persona uses.
      const [opts, list, siteModels] = await Promise.all([
        fetchPersonaOptions(), fetchPersonas(), fetchSiteModels(),
      ]);
      setOptions(opts);
      setPersonas(list);
      setModels(siteModels.models);
      setError('');
    } catch (e) {
      setError(apiErrorText(e, 'Could not load personas.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function resetForm() {
    setDraft(EMPTY_DRAFT);
    setInterestText('');
    setEditingId(null);
    setShowForm(false);
  }

  /** Interests are typed as one comma-separated line; splitting is a display concern. */
  function interestsFrom(text: string): string[] {
    return text.split(',').map(t => t.trim()).filter(Boolean);
  }

  async function submit() {
    setCreating(true);
    setError('');
    const payload = { ...draft, interests: interestsFrom(interestText) };
    try {
      if (editingId) {
        const updated = await updatePersona(editingId, payload);
        setPersonas(ps => ps.map(p => (p.id === editingId ? updated : p)));
        setNotice(`Updated ${updated.user.displayName}.`);
      } else {
        const created = await createPersona(payload);
        setPersonas(ps => [created, ...ps]);
        setNotice(`Created ${created.user.displayName} (@${created.user.username}).`);
      }
      resetForm();
    } catch (e) {
      setError(apiErrorText(e, editingId ? 'Could not update the persona.' : 'Could not create the persona.'));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(p: Persona) {
    setEditingId(p.id);
    setDraft({
      voice: p.voice, verbosity: p.verbosity, formality: p.formality,
      interests: p.interests, guidance: p.guidance,
      siteModelId: p.siteModelId,
      // Identity is not editable here — renaming an account that has already
      // written under a name is a different operation from tuning its voice, and
      // conflating them would let a persona's history change author silently.
      displayName: '', username: '',
    });
    setInterestText(p.interests.join(', '));
    setShowForm(true);
  }

  async function toggleActive(p: Persona) {
    setBusyId(p.id);
    try {
      const updated = await updatePersona(p.id, { active: !p.active });
      setPersonas(ps => ps.map(x => (x.id === p.id ? updated : x)));
    } catch (e) {
      setError(apiErrorText(e, 'Could not change that persona.'));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: Persona) {
    setBusyId(p.id);
    try {
      await deletePersona(p.id);
      setPersonas(ps => ps.filter(x => x.id !== p.id));
      setNotice(`Deleted ${p.user.displayName} and everything it wrote.`);
      setConfirmId(null);
    } catch (e) {
      setError(apiErrorText(e, 'Could not delete that persona.'));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className={styles.empty}>Loading…</div>;

  const configured = options?.operator.configured ?? false;
  const defaultModel = models.find(m => m.isDefault && m.enabled) ?? models.find(m => m.enabled) ?? null;

  /**
   * Whether choosing this endpoint puts the persona on a different model from
   * others already using it — the model-swap case, which on a single GPU costs
   * a full unload and reload per alternation. Warned about at the moment of
   * choosing, because it is invisible afterwards until the latency shows it.
   */
  function swapWarningFor(siteModelId: string | null): string | null {
    const target = siteModelId ? models.find(m => m.id === siteModelId) : defaultModel;
    if (!target) return null;
    const others = personas.filter(p => {
      if (editingId && p.id === editingId) return false;
      const theirs = p.siteModelId ? models.find(m => m.id === p.siteModelId) : defaultModel;
      return theirs?.id === target.id && theirs.model !== target.model;
    });
    if (others.length === 0) return null;
    return (
      `Other personas use a different model on the same endpoint. Only one model is ` +
      `resident at a time, so switching between them makes the box unload and reload — ` +
      `expect a slow first reply each time.`
    );
  }

  const sections: { id: Section; label: string }[] = [
    { id: 'personas', label: 'Personas' },
    { id: 'models', label: 'Models' },
    { id: 'usage', label: 'Usage' },
  ];

  return (
    <div className={styles.wrap}>
      <div className={styles.sectionNav}>
        {sections.map(s => (
          <button
            key={s.id}
            className={`${styles.sectionTab} ${section === s.id ? styles.sectionTabOn : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Both are self-contained: they fetch their own data and own their own
          errors. `onChanged` exists only so that adding an endpoint refreshes
          the picker on the Personas section without a reload. */}
      {section === 'models' && <SiteModelsPanel onChanged={() => void load()} />}
      {section === 'usage' && <ModelUsagePanel />}

      {section === 'personas' && <>
      {error && <div className={styles.error}>{error}</div>}
      {notice && (
        <div className={styles.notice}>
          {notice}
          <button className={styles.noticeDismiss} onClick={() => setNotice('')} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* The state that decides whether any of this works. Said once, at the
          top, naming the variable — the only person who can see this screen is
          the one who can set it. */}
      {!configured ? (
        <div className={styles.warning}>
          <strong>No site model is configured.</strong>
          <p>
            Personas write using a model the server provides, not a key from your account.
            Add one under <button className={styles.linkBtn} onClick={() => setSection('models')}>Models</button>.
            Existing personas are listed below but cannot generate.
          </p>
        </div>
      ) : (
        <p className={styles.status}>
          {defaultModel
            ? <>Generating with <strong>{defaultModel.model}</strong> at <code>{defaultModel.baseUrl}</code> by default.</>
            : options?.operator.env
              ? <>Generating with <strong>{options.operator.env.model}</strong> at <code>{options.operator.env.baseUrl}</code>, from the server’s environment.</>
              : null}
        </p>
      )}

      <p className={styles.blurb}>
        A persona is a real account with an <strong>AI</strong> badge on everything it writes.
        It can be blocked and reported like any other account. Deleting one deletes its posts
        and comments too.
      </p>

      {!showForm && (
        <button className={styles.primary} onClick={() => { setDraft(EMPTY_DRAFT); setInterestText(''); setShowForm(true); }}>
          New persona
        </button>
      )}

      {showForm && options && (
        <div className={styles.form}>
          <h3 className={styles.formTitle}>{editingId ? 'Edit persona' : 'New persona'}</h3>

          <Dial label="Voice" options={options.voices} value={draft.voice}
                onChange={v => setDraft(d => ({ ...d, voice: v }))} />
          <Dial label="Length" options={options.verbosities} value={draft.verbosity}
                onChange={v => setDraft(d => ({ ...d, verbosity: v }))} />
          <Dial label="Register" options={options.formalities} value={draft.formality}
                onChange={v => setDraft(d => ({ ...d, formality: v }))} />

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Interests</span>
            <input
              className={styles.input}
              value={interestText}
              onChange={e => setInterestText(e.target.value)}
              placeholder="space, chess, urban planning"
            />
            <span className={styles.fieldHint}>
              Comma-separated, up to {options.maxInterests}. Steers what it finds worth
              talking about — it still engages with articles outside them.
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Extra direction</span>
            <textarea
              className={styles.textarea}
              value={draft.guidance}
              maxLength={options.maxGuidance}
              rows={3}
              onChange={e => setDraft(d => ({ ...d, guidance: e.target.value }))}
              placeholder="Optional. Anything the dials above don't cover."
            />
            <span className={styles.fieldHint}>
              {draft.guidance.length}/{options.maxGuidance}. Added to the persona's instructions.
              The safety rules still apply after it.
            </span>
          </label>

          {models.length > 0 && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Model</span>
              <select
                className={styles.input}
                value={draft.siteModelId ?? ''}
                onChange={e => setDraft(d => ({ ...d, siteModelId: e.target.value || null }))}
              >
                {/* Empty value is the site default, which is what nearly every
                    persona should be — see the swap note. */}
                <option value="">Site default{defaultModel ? ` (${defaultModel.model})` : ''}</option>
                {models.filter(m => m.enabled).map(m => (
                  <option key={m.id} value={m.id}>
                    {m.label || m.baseUrl} — {m.model}
                  </option>
                ))}
              </select>
              {(() => {
                const warn = swapWarningFor(draft.siteModelId ?? null);
                return warn
                  ? <span className={styles.fieldWarn}>{warn}</span>
                  : <span className={styles.fieldHint}>Leave on the site default unless you have a reason not to.</span>;
              })()}
            </label>
          )}

          {!editingId && (
            <div className={styles.identity}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Display name</span>
                <input
                  className={styles.input}
                  value={draft.displayName ?? ''}
                  onChange={e => setDraft(d => ({ ...d, displayName: e.target.value }))}
                  placeholder="Leave blank to generate"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Username</span>
                <input
                  className={styles.input}
                  value={draft.username ?? ''}
                  onChange={e => setDraft(d => ({ ...d, username: e.target.value }))}
                  placeholder="Leave blank to generate"
                />
              </label>
            </div>
          )}

          <div className={styles.formActions}>
            <button className={styles.primary} onClick={() => void submit()} disabled={creating}>
              {creating ? 'Working…' : editingId ? 'Save changes' : 'Create persona'}
            </button>
            <button className={styles.secondary} onClick={resetForm} disabled={creating}>Cancel</button>
          </div>
        </div>
      )}

      {personas.length === 0 ? (
        <div className={styles.empty}>No personas yet.</div>
      ) : (
        <ul className={styles.list}>
          {personas.map(p => (
            <li key={p.id} className={`${styles.item} ${p.active ? '' : styles.itemPaused}`}>
              <div className={styles.itemHead}>
                <span className={styles.name}>{p.user.displayName}</span>
                <PersonaBadge />
                <span className={styles.handle}>@{p.user.username}</span>
                {!p.active && <span className={styles.paused}>Paused</span>}
              </div>

              <div className={styles.meta}>
                {options?.voices.find(v => v.id === p.voice)?.label ?? p.voice}
                {' · '}
                {options?.verbosities.find(v => v.id === p.verbosity)?.label ?? p.verbosity}
                {' · '}
                {options?.formalities.find(v => v.id === p.formality)?.label ?? p.formality}
                {p.interests.length > 0 && <> · {p.interests.join(', ')}</>}
              </div>

              <div className={styles.meta}>
                {p.counts.comments} comment{p.counts.comments === 1 ? '' : 's'}
                {' · '}
                {p.counts.posts} post{p.counts.posts === 1 ? '' : 's'}
                {p.createdBy && <> · made by {p.createdBy}</>}
                {/* Which endpoint writes for it. "Site default" is stated rather
                    than left blank — following the default is a choice, not an
                    absence of one. */}
                {' · '}
                {p.siteModel ? <>{p.siteModel.model} on {p.siteModel.label}</> : 'site default'}
              </div>

              {confirmId === p.id ? (
                <div className={styles.confirm}>
                  <span>
                    Delete <strong>{p.user.displayName}</strong>, its {p.counts.comments} comment
                    {p.counts.comments === 1 ? '' : 's'} and {p.counts.posts} post
                    {p.counts.posts === 1 ? '' : 's'}? This cannot be undone.
                  </span>
                  <div className={styles.itemActions}>
                    <button className={styles.danger} onClick={() => void remove(p)} disabled={busyId === p.id}>
                      {busyId === p.id ? 'Deleting…' : 'Delete everything'}
                    </button>
                    <button className={styles.secondary} onClick={() => setConfirmId(null)}>Keep</button>
                  </div>
                </div>
              ) : (
                <div className={styles.itemActions}>
                  <button className={styles.secondary} onClick={() => startEdit(p)}>Edit</button>
                  <button className={styles.secondary} onClick={() => void toggleActive(p)} disabled={busyId === p.id}>
                    {p.active ? 'Pause' : 'Resume'}
                  </button>
                  <a className={styles.secondary} href={`/u/${p.user.username}`} target="_blank" rel="noreferrer">
                    View profile
                  </a>
                  <button className={styles.dangerGhost} onClick={() => setConfirmId(p.id)}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      </>}
    </div>
  );
}
