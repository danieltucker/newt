import { useEffect, useState, useCallback } from 'react';
import { UsageStats, fetchUsage } from '../services/siteModels';
import { apiErrorText } from '../services/api';
import styles from './ModelUsagePanel.module.css';

/**
 * Admin → Personas → Usage. What the instance's models have actually been doing.
 *
 * **This panel is not about money.** A local GPU bills nothing, so the numbers
 * that matter to a self-hosted operator are different ones: is the box
 * answering, how long is it taking, and how fast is it generating. Those are
 * latency, failure rate and tokens per second, and none can be reconstructed
 * after the fact — hence the log behind this.
 *
 * The single most useful reading here is **median vs p95 on one model**. A wide
 * gap on a single GPU almost always means model swapping: only one model is
 * resident at a time, so alternating between two makes Ollama unload and reload,
 * and the reload lands in the tail.
 */

const WINDOWS = [1, 7, 30];

/** Milliseconds as something a person reads at a glance. */
function ms(v: number | null): string {
  if (v === null) return '—';
  if (v < 1000) return `${v}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

function num(v: number): string {
  return v.toLocaleString();
}

function relTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function ModelUsagePanel() {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (window: number) => {
    setLoading(true);
    try {
      setStats(await fetchUsage(window));
      setError('');
    } catch (e) {
      setError(apiErrorText(e, 'Could not load usage.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(days); }, [load, days]);

  if (loading && !stats) return <div className={styles.empty}>Loading…</div>;
  if (error) return <div className={styles.error}>{error}</div>;
  if (!stats) return null;

  const { totals } = stats;
  const failRate = totals.calls > 0 ? (totals.failed / totals.calls) * 100 : 0;
  const peak = Math.max(1, ...stats.byDay.map(d => d.calls));

  return (
    <div className={styles.wrap}>
      <div className={styles.windowRow}>
        {WINDOWS.map(w => (
          <button
            key={w}
            className={`${styles.chip} ${days === w ? styles.chipOn : ''}`}
            onClick={() => setDays(w)}
          >
            {w === 1 ? '24 hours' : `${w} days`}
          </button>
        ))}
      </div>

      {totals.calls === 0 ? (
        <div className={styles.empty}>Nothing generated in this window.</div>
      ) : (
        <>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{num(totals.calls)}</span>
              <span className={styles.tileLabel}>generations</span>
            </div>
            <div className={styles.tile}>
              <span className={`${styles.tileValue} ${totals.failed > 0 ? styles.bad : ''}`}>
                {num(totals.failed)}
              </span>
              <span className={styles.tileLabel}>
                failed{totals.calls > 0 && ` · ${failRate.toFixed(0)}%`}
              </span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{ms(totals.medianMs)}</span>
              <span className={styles.tileLabel}>median</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{ms(totals.p95Ms)}</span>
              <span className={styles.tileLabel}>95th percentile</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>
                {totals.tokensPerSecond === null ? '—' : totals.tokensPerSecond.toFixed(1)}
              </span>
              <span className={styles.tileLabel}>tokens/sec</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileValue}>{num(totals.outputTokens)}</span>
              <span className={styles.tileLabel}>tokens written</span>
            </div>
          </div>

          {/* Said plainly rather than left for the reader to infer from two
              numbers that happen to sit next to each other. */}
          {totals.medianMs !== null && totals.p95Ms !== null && totals.p95Ms > totals.medianMs * 4 && (
            <p className={styles.insight}>
              The slowest calls take far longer than the typical one. On a single GPU that
              usually means the model is being unloaded and reloaded — check whether personas
              are split across two models on the same endpoint.
            </p>
          )}
          {totals.tokensPerSecond === null && (
            <p className={styles.hint}>
              This endpoint doesn’t report token counts, so rates are unavailable. Latency is
              still measured.
            </p>
          )}

          <div className={styles.sectionTitle}>By day</div>
          <div className={styles.bars}>
            {stats.byDay.map(d => (
              <div key={d.date} className={styles.barCol} title={`${d.date}: ${d.calls} generations, ${d.failed} failed`}>
                <div className={styles.barTrack}>
                  <div className={styles.bar} style={{ height: `${(d.calls / peak) * 100}%` }}>
                    {d.failed > 0 && (
                      <div className={styles.barFail} style={{ height: `${(d.failed / d.calls) * 100}%` }} />
                    )}
                  </div>
                </div>
                <span className={styles.barLabel}>{d.date.slice(5)}</span>
              </div>
            ))}
          </div>

          <div className={styles.sectionTitle}>By model</div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Endpoint</th><th>Model</th>
                  <th className={styles.numCol}>Calls</th>
                  <th className={styles.numCol}>Failed</th>
                  <th className={styles.numCol}>Median</th>
                  <th className={styles.numCol}>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {stats.byModel.map(m => (
                  <tr key={`${m.siteModelId ?? ''}${m.model}`}>
                    <td>{m.label}{m.siteModelId === null && <span className={styles.gone}> (removed)</span>}</td>
                    <td><code>{m.model}</code></td>
                    <td className={styles.numCol}>{num(m.calls)}</td>
                    <td className={`${styles.numCol} ${m.failed > 0 ? styles.bad : ''}`}>{num(m.failed)}</td>
                    <td className={styles.numCol}>{ms(m.medianMs)}</td>
                    <td className={styles.numCol}>{num(m.outputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.sectionTitle}>By persona</div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Persona</th><th className={styles.numCol}>Calls</th><th className={styles.numCol}>Failed</th></tr>
              </thead>
              <tbody>
                {stats.byPersona.map(p => (
                  <tr key={p.personaId ?? p.name}>
                    <td>{p.name}</td>
                    <td className={styles.numCol}>{num(p.calls)}</td>
                    <td className={`${styles.numCol} ${p.failed > 0 ? styles.bad : ''}`}>{num(p.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.sectionTitle}>Recent</div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>When</th><th>Persona</th><th>Kind</th><th>Model</th>
                  <th className={styles.numCol}>Took</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map(r => (
                  <tr key={r.id}>
                    <td title={new Date(r.createdAt).toLocaleString()}>{relTime(r.createdAt)}</td>
                    <td>{r.personaName || '—'}</td>
                    <td>{r.kind}</td>
                    <td><code>{r.model}</code></td>
                    <td className={styles.numCol}>{ms(r.durationMs || null)}</td>
                    <td className={r.outcome === 'failed' ? styles.bad : ''}>
                      {/* The error text is why a failure row is worth keeping —
                          it is gone from anywhere else by the time anyone looks. */}
                      {r.outcome === 'failed' ? (r.error || 'failed') : 'ok'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
