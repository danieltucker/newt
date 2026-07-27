import { useState, useEffect } from 'react';
import styles from './ArticleModal.module.css';
import { apiFetch } from '../services/api';

interface Props {
  url: string;
  onClose: () => void;
}

export default function ArticleModal({ url, onClose }: Props) {
  const [embeddable, setEmbeddable] = useState<boolean | null>(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Server-side header check - more reliable than client-side iframe probing
  useEffect(() => {
    setEmbeddable(null);
    apiFetch(`/api/v1/util/check-frame?url=${encodeURIComponent(url)}`)
      .then(r => r.json())
      .then(d => {
        if (!d.embeddable) {
          window.open(url, '_blank', 'noopener,noreferrer');
          onClose();
        } else {
          setEmbeddable(true);
        }
      })
      .catch(() => setEmbeddable(true)); // network error - try anyway
  }, [url]);

  const displayUrl = (() => {
    try { return new URL(url).hostname; } catch { return url; }
  })();

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.toolbar}>
          <button className={styles.backBtn} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>
            </svg>
            Back
          </button>
          <span className={styles.urlLabel}>{displayUrl}</span>
          <a
            className={styles.externalBtn}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
          >
            Open in new tab
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        </div>

        <div className={styles.frameWrap}>
          {embeddable === null && (
            <div className={styles.loading}>
              <div className={styles.spinner} />
            </div>
          )}

          {embeddable === true && (
            <iframe
              className={styles.frame}
              src={url}
              title="Article"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          )}
        </div>
      </div>
    </div>
  );
}
