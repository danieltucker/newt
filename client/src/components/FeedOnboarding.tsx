import { useState, useMemo } from 'react';
import { SuggestedFeed } from '../types';
import styles from './FeedOnboarding.module.css';

interface Props {
  suggested: SuggestedFeed[];
  onFollow: (feeds: Array<{ url: string; name?: string; category?: string }>) => Promise<unknown>;
  /** Records that this has been seen, whether or not anything was picked. */
  onDone: () => void;
}

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/**
 * Shown once, on the first visit after signing up.
 *
 * A reader with nothing in it is a reader that looks broken, and "go and find
 * some RSS URLs" is not a first task anyone wants. So the app opens by offering
 * a handful of publications worth following - but nothing is subscribed until
 * it's picked, and skipping is a first-class option rather than fine print.
 */
export default function FeedOnboarding({ suggested, onFollow, onDone }: Props) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const byCategory = useMemo(() => {
    const map = new Map<string, SuggestedFeed[]>();
    for (const s of suggested) {
      const list = map.get(s.category);
      if (list) list.push(s); else map.set(s.category, [s]);
    }
    return [...map.entries()];
  }, [suggested]);

  function toggle(url: string) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  function toggleCategory(feeds: SuggestedFeed[]) {
    const all = feeds.every(f => picked.has(f.url));
    setPicked(prev => {
      const next = new Set(prev);
      for (const f of feeds) {
        if (all) next.delete(f.url); else next.add(f.url);
      }
      return next;
    });
  }

  async function handleFollow() {
    if (picked.size === 0) { onDone(); return; }
    setBusy(true);
    setError('');
    try {
      await onFollow(
        suggested.filter(s => picked.has(s.url))
          .map(s => ({ url: s.url, name: s.name, category: s.category }))
      );
      onDone();
    } catch {
      // Nothing here is worth trapping someone on a first-run screen for.
      setError("Couldn't add those just now — you can add feeds any time from Manage feeds.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.card} role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className={styles.head}>
          <div className={styles.eyebrow}>Welcome</div>
          <h1 className={styles.title} id="onboarding-title">Pick a few feeds to start with</h1>
          <p className={styles.sub}>
            New articles from anything you follow land in your feed. Pick as many
            or as few as you like — you can change all of this later.
          </p>
        </div>

        <div className={styles.body}>
          {byCategory.map(([category, feeds]) => {
            const allOn = feeds.every(f => picked.has(f.url));
            return (
              <div key={category} className={styles.group}>
                <div className={styles.groupHead}>
                  <span className={styles.groupName}>{category}</span>
                  <button className={styles.groupToggle} onClick={() => toggleCategory(feeds)}>
                    {allOn ? 'Clear' : 'Select all'}
                  </button>
                </div>
                <div className={styles.grid}>
                  {feeds.map(s => {
                    const on = picked.has(s.url);
                    return (
                      <button
                        key={s.url}
                        className={`${styles.pick} ${on ? styles.pickOn : ''}`}
                        onClick={() => toggle(s.url)}
                        aria-pressed={on}
                      >
                        <span className={styles.pickCheck}>{on ? <CheckIcon /> : null}</span>
                        <span className={styles.pickMain}>
                          <span className={styles.pickName}>{s.name}</span>
                          <span className={styles.pickBlurb}>{s.blurb}</span>
                          <span className={styles.pickSite}>{s.site}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {suggested.length === 0 && (
            <div className={styles.noneLeft}>
              Nothing to suggest right now — you can add feeds from Manage feeds
              whenever you like.
            </div>
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.foot}>
          <button className={styles.skipBtn} onClick={onDone} disabled={busy}>
            Skip for now
          </button>
          <button className={styles.followBtn} onClick={handleFollow} disabled={busy}>
            {busy
              ? 'Setting up…'
              : picked.size === 0
                ? 'Continue'
                : `Follow ${picked.size} feed${picked.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
