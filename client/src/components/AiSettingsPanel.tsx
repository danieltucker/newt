import { useState } from 'react';
import { Provider, ProviderId, Credential, Depth, testCredential, apiErrorText } from '../services/llm';
import ModelPicker from './ModelPicker';
import styles from './AiSettingsPanel.module.css';

/**
 * Settings → AI. Where the account's models are connected.
 *
 * The one rule this screen is built around: **a key that has been saved is
 * never shown again.** The server does not send keys back, so there is nothing
 * to show even if this wanted to — an existing key is a row of dots and a last
 * four, and changing it means pasting a new one. That is a small friction and
 * it buys the guarantee that a stolen browser session cannot read out the keys.
 */

export interface LlmBinding {
  providers: Provider[];
  credentials: Credential[];
  loaded: boolean;
  /** Set when the server couldn't be read. See useLlm. */
  error?: string | null;
  add: (input: {
    provider: ProviderId; label?: string; apiKey?: string;
    baseUrl?: string; model?: string; isDefault?: boolean;
  }) => Promise<unknown>;
  edit: (id: string, patch: {
    label?: string; apiKey?: string; baseUrl?: string; model?: string; isDefault?: boolean;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

interface Props {
  llm: LlmBinding;
  /** The three AI preferences out of the settings blob, and the writer for them. */
  depth: Depth;
  feedSearch: boolean;
  showCost: boolean;
  onUpdate: (patch: { aiDepth?: Depth; aiFeedSearch?: boolean; aiShowCost?: boolean }) => void;
}

/**
 * What each depth actually does, said in terms of the thing people care about.
 *
 * Naming the token ceilings would be precise and useless; what a reader wants
 * to know is how long the answer will be and roughly what it costs relative to
 * the others.
 */
const DEPTH_META: { id: Depth; label: string; hint: string }[] = [
  { id: 'brief',    label: 'Brief',    hint: 'A few sentences. Cheapest by a wide margin, and the right setting for most questions.' },
  { id: 'balanced', label: 'Balanced', hint: 'Length follows the question. The default.' },
  { id: 'thorough', label: 'Thorough', hint: 'Long answers and deeper reasoning. Several times the cost of Brief.' },
];

interface FormState {
  provider: ProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

const BLANK: FormState = { provider: 'anthropic', label: '', apiKey: '', baseUrl: '', model: '' };

export default function AiSettingsPanel({ llm, depth, feedSearch, showCost, onUpdate }: Props) {
  const { providers, credentials, loaded, error: loadError } = llm;

  const [form, setForm] = useState<FormState>(BLANK);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Which row is having its key replaced, and what has been typed so far.
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState('');

  const chosen = providers.find(p => p.id === form.provider);

  function pickProvider(id: ProviderId) {
    const provider = providers.find(p => p.id === id);
    // Carry the provider's own default model across rather than leaving the
    // field empty — for Claude and ChatGPT there is a right answer, and making
    // people type it is a chance to typo a model id.
    setForm({ ...BLANK, provider: id, model: provider?.defaultModel ?? '' });
    setError(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await llm.add({
        provider: form.provider,
        label: form.label.trim() || undefined,
        apiKey: form.apiKey.trim() || undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        model: form.model.trim() || undefined,
      });
      setForm(BLANK);
      setAdding(false);
    } catch (err) {
      setError(apiErrorText(err, 'Could not save that.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleTest(id: string) {
    setTesting(id);
    setTestResult(null);
    try {
      const { reply } = await testCredential(id);
      setTestResult({ id, ok: true, message: reply ? `Answered: “${reply}”` : 'Answered.' });
    } catch (err) {
      setTestResult({ id, ok: false, message: apiErrorText(err, 'That didn’t work.') });
    } finally {
      setTesting(null);
    }
  }

  async function handleReplaceKey(id: string) {
    const key = replacementKey.trim();
    if (!key) { setReplacing(null); return; }
    setBusy(true);
    setError(null);
    try {
      await llm.edit(id, { apiKey: key });
      setReplacing(null);
      setReplacementKey('');
    } catch (err) {
      setError(apiErrorText(err, 'Could not update that key.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleModelChange(id: string, model: string) {
    try { await llm.edit(id, { model }); }
    catch (err) { setError(apiErrorText(err, 'Could not change the model.')); }
  }

  async function handleMakeDefault(id: string) {
    try { await llm.edit(id, { isDefault: true }); }
    catch (err) { setError(apiErrorText(err, 'Could not set the default.')); }
  }

  async function handleRemove(id: string) {
    setConfirmRemove(null);
    try { await llm.remove(id); }
    catch (err) { setError(apiErrorText(err, 'Could not remove that.')); }
  }

  return (
    <>
      <div className={styles.block} data-setting="ai-models">
        <div className={styles.blockTitle}>Connected models</div>
        <div className={styles.hint}>
          Newt’s AI features (Explore, proofreading, and asking questions about what
          you’re reading) run on your own provider account using your own API key.
          There is no shared key: nothing is sent anywhere until you connect one, and
          usage is billed to you by the provider.
        </div>

        {error && <div className={styles.error}>{error}</div>}
        {loadError && <div className={styles.error}>{loadError}</div>}

        {!loaded && <div className={styles.hint}>Loading…</div>}

        {loaded && credentials.length === 0 && !adding && !loadError && (
          <div className={styles.empty}>Nothing connected yet.</div>
        )}

        {credentials.map(cred => {
          const provider = providers.find(p => p.id === cred.provider);
          return (
            <div key={cred.id} className={styles.credential}>
              <div className={styles.credHead}>
                <span className={styles.credName}>
                  {cred.label || provider?.label || cred.provider}
                  {cred.isDefault && <span className={styles.defaultTag}>Default</span>}
                </span>
                <span className={styles.credKey}>
                  {cred.keyLast4
                    ? `••••${cred.keyLast4}`
                    : <span className={styles.noKey}>no key</span>}
                </span>
              </div>

              {cred.baseUrl && <div className={styles.credUrl}>{cred.baseUrl}</div>}

              {provider && (
                <div className={styles.modelBlock}>
                  <span className={styles.fieldLabel}>Model</span>
                  {/* Changing the selection saves immediately. There is no Save
                      button on a saved credential, and a picker that quietly
                      kept a choice until some other action committed it would
                      be the wrong kind of surprise on a control that changes
                      what every question costs. */}
                  <ModelPicker
                    provider={provider}
                    value={cred.model}
                    onChange={model => { if (model && model !== cred.model) handleModelChange(cred.id, model); }}
                    credentialId={cred.id}
                    baseUrl={cred.baseUrl}
                    idPrefix={`cred-${cred.id}`}
                  />
                </div>
              )}

              {replacing === cred.id ? (
                <div className={styles.credRow}>
                  <input
                    className={styles.input}
                    type="password"
                    autoFocus
                    placeholder="Paste the new key"
                    value={replacementKey}
                    onChange={e => setReplacementKey(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleReplaceKey(cred.id); }}
                  />
                  <button className={styles.smallBtn} onClick={() => handleReplaceKey(cred.id)} disabled={busy}>
                    Save
                  </button>
                  <button
                    className={styles.ghostBtn}
                    onClick={() => { setReplacing(null); setReplacementKey(''); }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className={styles.credActions}>
                  <button
                    className={styles.smallBtn}
                    onClick={() => handleTest(cred.id)}
                    disabled={testing === cred.id}
                  >
                    {testing === cred.id ? 'Testing…' : 'Test'}
                  </button>
                  <button className={styles.smallBtn} onClick={() => setReplacing(cred.id)}>
                    Replace key
                  </button>
                  {!cred.isDefault && (
                    <button className={styles.smallBtn} onClick={() => handleMakeDefault(cred.id)}>
                      Make default
                    </button>
                  )}
                  {confirmRemove === cred.id ? (
                    <>
                      <button className={styles.dangerBtn} onClick={() => handleRemove(cred.id)}>
                        Really remove
                      </button>
                      <button className={styles.ghostBtn} onClick={() => setConfirmRemove(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className={styles.dangerBtn} onClick={() => setConfirmRemove(cred.id)}>
                      Remove
                    </button>
                  )}
                </div>
              )}

              {testResult?.id === cred.id && (
                <div className={testResult.ok ? styles.ok : styles.error}>{testResult.message}</div>
              )}
            </div>
          );
        })}

        {adding ? (
          <form className={styles.form} onSubmit={handleAdd}>
            {/* Without providers there is nothing to fill in, so say that
                instead of drawing an empty box with a Connect button in it. */}
            {providers.length === 0 && (
              <div className={styles.error}>
                Newt couldn’t load the list of providers, so there is nothing to fill
                in here yet. Reload the page once the server is reachable.
              </div>
            )}
            <div className={styles.providerRow}>
              {providers.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={`${styles.providerBtn} ${form.provider === p.id ? styles.providerActive : ''}`}
                  onClick={() => pickProvider(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {chosen && (
              <>
                <div className={styles.hint}>{chosen.blurb}</div>

                {chosen.needsBaseUrl && (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Base URL</span>
                    <input
                      className={styles.input}
                      placeholder="https://ollama.example.com/v1"
                      value={form.baseUrl}
                      onChange={e => setForm({ ...form, baseUrl: e.target.value })}
                    />
                    {/* The constraint that surprises people, said before they
                        hit it rather than after. */}
                    <span className={styles.subtle}>
                      Must be reachable from the internet. A LAN address like
                      192.168.x.x or localhost won’t work, because Newt refuses to make
                      requests to private networks. That is what stops a signed-up
                      stranger using it to probe the machine it runs on. Publish the box
                      through a tunnel or a reverse proxy with TLS.
                    </span>
                  </label>
                )}

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    API key{!chosen.needsKey && <span className={styles.subtle}> (optional)</span>}
                  </span>
                  <input
                    className={styles.input}
                    type="password"
                    autoComplete="off"
                    placeholder={chosen.needsKey ? 'sk-…' : 'Leave empty if your endpoint has no auth'}
                    value={form.apiKey}
                    onChange={e => setForm({ ...form, apiKey: e.target.value })}
                  />
                  <a className={styles.docsLink} href={chosen.docsUrl} target="_blank" rel="noopener noreferrer">
                    Where do I get a key? ↗
                  </a>
                </label>

                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Model</span>
                  <ModelPicker
                    provider={chosen}
                    value={form.model}
                    onChange={model => setForm({ ...form, model })}
                    baseUrl={form.baseUrl}
                    apiKey={form.apiKey}
                    idPrefix="new"
                  />
                </div>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Label <span className={styles.subtle}>(optional)</span></span>
                  <input
                    className={styles.input}
                    placeholder={chosen.label}
                    maxLength={60}
                    value={form.label}
                    onChange={e => setForm({ ...form, label: e.target.value })}
                  />
                </label>
              </>
            )}

            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryBtn} disabled={busy || !chosen}>
                {busy ? 'Saving…' : 'Connect'}
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => { setAdding(false); setForm(BLANK); setError(null); }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            className={styles.primaryBtn}
            onClick={() => { setAdding(true); pickProvider(providers[0]?.id ?? 'anthropic'); }}
            disabled={!loaded}
          >
            Connect a model
          </button>
        )}
      </div>

      <div className={styles.block} data-setting="ai-depth">
        <div className={styles.blockTitle}>Answer length and cost</div>
        <div className={styles.hint}>
          The single biggest control on what your AI features cost. Longer answers
          mean more output tokens, and on a reasoning model the thinking behind
          them is billed too.
        </div>
        <div className={styles.depthRow}>
          {DEPTH_META.map(option => (
            <button
              key={option.id}
              type="button"
              className={`${styles.depthBtn} ${depth === option.id ? styles.depthActive : ''}`}
              onClick={() => onUpdate({ aiDepth: option.id })}
            >
              <span className={styles.depthLabel}>{option.label}</span>
              <span className={styles.depthHint}>{option.hint}</span>
            </button>
          ))}
        </div>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={showCost}
            onChange={e => onUpdate({ aiShowCost: e.target.checked })}
          />
          <span>
            <span className={styles.checkLabel}>Show what each answer cost</span>
            <span className={styles.subtle}>
              An estimate under each reply, from the token counts your provider reports.
              Approximate, and only shown for models with a known price.
            </span>
          </span>
        </label>
      </div>

      <div className={styles.block} data-setting="ai-feed-search">
        <div className={styles.blockTitle}>Search your feed when exploring</div>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={feedSearch}
            onChange={e => onUpdate({ aiFeedSearch: e.target.checked })}
          />
          <span>
            <span className={styles.checkLabel}>Let Explore read your subscriptions</span>
            <span className={styles.subtle}>
              Your model has no way to browse and a training cutoff, so it is weakest on
              anything recent. With this on, Newt works out what your question is about,
              searches the articles already in your feed, and hands the relevant ones over
              as context. Answers can then cite what you actually follow. It adds one cheap
              call per question, on the smallest model your provider offers.
            </span>
          </span>
        </label>
      </div>

      <div className={styles.block} data-setting="ai-privacy">
        <div className={styles.blockTitle}>What gets sent, and where</div>
        <ul className={styles.list}>
          <li>
            Your key is encrypted before it is stored, and no part of it is ever sent
            back to your browser. That is why replacing a key means pasting a new one
            rather than editing the old.
          </li>
          <li>
            When you explore an article, its text and the comments <em>you can already
            see</em> are sent to your provider as context. Comments you can’t see are
            never included: private ones, friends-only ones from people you aren’t
            friends with, and anyone you’ve blocked.
          </li>
          <li>
            Most feeds publish a teaser rather than the whole piece, so where the stored
            copy is too short to answer from, Newt fetches the article’s own page and
            reads the text off it. That request goes to the publisher, from this server,
            with no cookies and nothing identifying you — and the result is cached and
            shared, so a page is read once rather than once per reader.
          </li>
          <li>
            Explore threads are private to you and stay in Newt. They become public
            only if you condense one into a post and then publish it.
          </li>
          <li>
            What your provider does with what you send is between you and them. Apart
            from the article fetch above, Newt makes no other calls on your behalf.
          </li>
        </ul>
      </div>
    </>
  );
}
