import { useState, useRef } from 'react';
import styles from './ImportBookmarksModal.module.css';
import { parseBookmarkHTML, ParsedBookmark } from '../utils/parseBookmarks';
import { Folder } from '../types';
import { apiFetch } from '../services/api';
import { faviconUrl } from '../utils/color';
import CloseButton from './CloseButton';

interface Props {
  folders: Folder[];
  activeFolderId: string | null;
  onClose: () => void;
  onImported: () => void;
}

type Step = 'pick' | 'preview' | 'done';

export default function ImportBookmarksModal({ folders, activeFolderId, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('pick');
  const [bookmarks, setBookmarks] = useState<ParsedBookmark[]>([]);
  const [folderId, setFolderId] = useState(activeFolderId ?? folders[0]?.id ?? '');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function processFile(file: File) {
    if (!file.name.endsWith('.html') && !file.name.endsWith('.htm')) {
      setError('Please select an HTML bookmark export file (.html)');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const parsed = parseBookmarkHTML(text);
      if (parsed.length === 0) {
        setError('No bookmarks found in this file. Make sure it\'s a browser bookmark export.');
        return;
      }
      setBookmarks(parsed);
      setError('');
      setStep('preview');
    };
    reader.readAsText(file);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  async function handleImport() {
    if (!folderId) return;
    setImporting(true);
    try {
      const r = await apiFetch('/api/v1/bookmarks/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, bookmarks }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Import failed');
      setResult(data);
      setStep('done');
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.title}>Import bookmarks</div>
          <CloseButton onClick={onClose} />
        </div>

        {step === 'pick' && (
          <div className={styles.body}>
            <p className={styles.hint}>
              Export your bookmarks from Chrome, Firefox, Edge, Safari, or Brave as an HTML file,
              then drop it here.
            </p>
            <div
              className={`${styles.dropZone} ${dragOver ? styles.dropZoneActive : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={styles.dropIcon}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <div className={styles.dropLabel}>Drop bookmark file here</div>
              <div className={styles.dropSub}>or click to browse</div>
            </div>
            <input ref={fileRef} type="file" accept=".html,.htm" style={{ display: 'none' }} onChange={handleFile} />
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.exportHint}>
              <strong>How to export:</strong>
              <ul>
                <li><strong>Chrome / Edge / Brave:</strong> Bookmarks manager (⌘⇧O) → ⋮ → Export bookmarks</li>
                <li><strong>Firefox:</strong> Bookmarks → Manage bookmarks → Import & Backup → Export to HTML</li>
                <li><strong>Safari:</strong> File → Export Bookmarks</li>
              </ul>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <div className={styles.body}>
            <div className={styles.previewHeader}>
              <span className={styles.count}>{bookmarks.length} bookmarks found</span>
              <button className={styles.backLink} onClick={() => { setStep('pick'); setBookmarks([]); }}>
                ← Choose different file
              </button>
            </div>

            <div className={styles.previewList}>
              {bookmarks.slice(0, 12).map((b, i) => (
                <div key={i} className={styles.previewItem}>
                  <img src={faviconUrl(b.domain)} alt="" className={styles.previewFavicon}
                    onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                  <div className={styles.previewText}>
                    <span className={styles.previewName}>{b.name}</span>
                    <span className={styles.previewDomain}>{b.domain}</span>
                  </div>
                </div>
              ))}
              {bookmarks.length > 12 && (
                <div className={styles.previewMore}>+{bookmarks.length - 12} more</div>
              )}
            </div>

            <div className={styles.folderRow}>
              <label className={styles.folderLabel}>Import into</label>
              <select className={styles.folderSelect} value={folderId} onChange={e => setFolderId(e.target.value)}>
                {folders.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.footer}>
              <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
              <button className={styles.importBtn} onClick={handleImport} disabled={importing || !folderId}>
                {importing ? 'Importing…' : `Import ${bookmarks.length} bookmarks`}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && result && (
          <div className={styles.body}>
            <div className={styles.doneIcon}>✓</div>
            <div className={styles.doneTitle}>Import complete</div>
            <div className={styles.doneText}>
              Added <strong>{result.created}</strong> bookmark{result.created !== 1 ? 's' : ''}
              {result.skipped > 0 && <>, skipped <strong>{result.skipped}</strong> duplicate{result.skipped !== 1 ? 's' : ''}</>}
            </div>
            <div className={styles.footer}>
              <button className={styles.importBtn} onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
