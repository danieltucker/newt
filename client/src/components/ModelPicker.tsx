import { useState } from 'react';
import { Provider, ModelOption, Tier, listModels, apiErrorText } from '../services/llm';
import styles from './ModelPicker.module.css';

/**
 * Choosing a model without having to know model names.
 *
 * The first version of this was a free-text box with a datalist of
 * suggestions, which is fine if you already know that `claude-haiku-4-5` is
 * the cheap one — and useless otherwise. Since the difference between the
 * options is mostly *price*, and price is the thing people were surprised by,
 * that is what the list leads with.
 *
 * Two sources of options, depending on the provider:
 *
 *   hosted        the catalogue in the server's registry, with indicative
 *                 per-million-token prices. Approximate on purpose, and
 *                 labelled as such: vendors change prices and this table only
 *                 moves when Newt does.
 *   self-hosted   whatever the box says it serves, fetched on demand from
 *                 GET /v1/models. No prices, because there aren't any.
 *
 * The free-text escape hatch stays, behind a link. A model released the week
 * after a Newt version must still be reachable, and the alternative is people
 * waiting on a release to use something they are already paying for.
 */

interface Props {
  provider: Provider;
  value: string;
  onChange: (model: string) => void;
  /** Set when editing a saved credential, so the server can use its stored key. */
  credentialId?: string;
  /** The base URL typed into the add form, before anything is saved. */
  baseUrl?: string;
  apiKey?: string;
  idPrefix: string;
}

const TIER_LABEL: Record<Tier, string> = {
  economy: 'Cheapest',
  balanced: 'Mid',
  premium: 'Most capable',
};

/**
 * "$1 / $5 per million" is precise but hard to compare at a glance, so the
 * cheapest option in the list is the yardstick and everything else is priced
 * against it. Output is what the multiplier is based on: it is the expensive
 * half of a chat workload, several times the input rate on every provider here.
 */
function relativeCost(model: ModelOption, cheapest: ModelOption | undefined): string | null {
  if (!cheapest || cheapest.id === model.id) return null;
  const ratio = model.outputPer1M / cheapest.outputPer1M;
  if (!Number.isFinite(ratio) || ratio <= 1.2) return null;
  return `about ${ratio < 10 ? ratio.toFixed(1).replace(/\.0$/, '') : Math.round(ratio)}x the cost of ${cheapest.label}`;
}

export default function ModelPicker({
  provider, value, onChange, credentialId, baseUrl, apiKey, idPrefix,
}: Props) {
  const [remote, setRemote] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Free text is opt-in, and stays open once the value isn't a known option —
  // otherwise editing a credential that names a custom model would silently
  // offer to replace it with something else.
  const [manual, setManual] = useState(false);

  const catalogue = provider.models;
  const cheapest = [...catalogue].sort((a, b) => a.outputPer1M - b.outputPer1M)[0];
  const knownIds = new Set([...catalogue.map(m => m.id), ...(remote ?? [])]);
  const showManual = manual || (value !== '' && !knownIds.has(value));

  async function fetchModels() {
    setFetching(true);
    setError(null);
    try {
      const { models } = await listModels({
        provider: provider.id,
        baseUrl,
        apiKey,
        credentialId,
      });
      setRemote(models);
      if (models.length === 0) setError('That endpoint didn’t list any models.');
    } catch (err) {
      setError(apiErrorText(err, 'Could not read the model list.'));
    } finally {
      setFetching(false);
    }
  }

  // ── Self-hosted: a plain list, fetched on demand ──────────────────────────
  if (provider.canListModels) {
    return (
      <div className={styles.wrap}>
        <div className={styles.row}>
          {remote && remote.length > 0 ? (
            <select
              id={`${idPrefix}-model`}
              className={styles.select}
              value={knownIds.has(value) ? value : ''}
              onChange={e => onChange(e.target.value)}
            >
              <option value="" disabled>Choose a model…</option>
              {remote.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          ) : (
            <input
              id={`${idPrefix}-model`}
              className={styles.input}
              value={value}
              placeholder="llama3.1"
              onChange={e => onChange(e.target.value)}
            />
          )}
          <button type="button" className={styles.fetchBtn} onClick={fetchModels} disabled={fetching}>
            {fetching ? 'Asking…' : remote ? 'Refresh list' : 'List models'}
          </button>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <p className={styles.note}>
          Newt can ask your endpoint what it serves. Enter the base URL first, then
          press List models. Costs depend on your own hosting, so nothing is
          estimated for these.
        </p>
      </div>
    );
  }

  // ── Hosted: the catalogue, priced ────────────────────────────────────────
  return (
    <div className={styles.wrap}>
      {!showManual ? (
        <div className={styles.options} role="radiogroup" aria-label="Model">
          {catalogue.map(model => {
            const selected = model.id === value;
            const relative = relativeCost(model, cheapest);
            return (
              <button
                key={model.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`${styles.option} ${selected ? styles.optionSelected : ''}`}
                onClick={() => onChange(model.id)}
              >
                <span className={styles.optionHead}>
                  <span className={styles.optionName}>{model.label}</span>
                  <span className={`${styles.tier} ${styles[model.tier]}`}>{TIER_LABEL[model.tier]}</span>
                </span>
                <span className={styles.price}>
                  ~${model.inputPer1M}/M in · ~${model.outputPer1M}/M out
                  {relative && <span className={styles.relative}> · {relative}</span>}
                </span>
                <span className={styles.optionBlurb}>{model.blurb}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <input
          id={`${idPrefix}-model`}
          className={styles.input}
          value={value}
          placeholder={provider.defaultModel}
          onChange={e => onChange(e.target.value)}
        />
      )}

      <p className={styles.note}>
        Prices are approximate and per million tokens, for ranking the options rather
        than for budgeting.{' '}
        {provider.pricingUrl && (
          <a href={provider.pricingUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
            {provider.label}’s current pricing ↗
          </a>
        )}
        {' · '}
        <button type="button" className={styles.linkBtn} onClick={() => setManual(m => !m)}>
          {showManual ? 'Pick from the list' : 'Enter a model name instead'}
        </button>
      </p>
    </div>
  );
}
