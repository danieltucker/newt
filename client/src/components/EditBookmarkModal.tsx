import { useState, useEffect, useRef } from 'react';
import styles from './AddLinkModal.module.css';
import ownStyles from './EditBookmarkModal.module.css';
import { Folder, Bookmark } from '../types';
import { parseDomain, parseLink, deriveName, deriveColor, faviconUrl } from '../utils/color';

const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

interface Props {
  bookmark: Bookmark;
  folders: Folder[];
  onSave: (id: string, updates: { domain: string; name: string; faviconUrl: string; color: string; folderId: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

export default function EditBookmarkModal({ bookmark, folders, onSave, onDelete, onClose }: Props) {
  const [url, setUrl] = useState(bookmark.domain);
  // nameOverride always drives both the input and the preview
  const [nameOverride, setNameOverride] = useState(bookmark.name);
  const [nameEdited, setNameEdited] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState(bookmark.folderId);
  const [colorOverride, setColorOverride] = useState<string | null>(null);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Track the domain that was current when the modal opened (or last auto-derived)
  const prevDomainRef = useRef(parseDomain(bookmark.domain) || bookmark.domain);

  // domain = the full link that gets saved / navigated to (may include a path,
  // e.g. github.com/danieltucker); host = just the site, for favicon/name/colour.
  const domain = parseLink(url);
  const host = parseDomain(url);
  const autoColor = host ? deriveColor(host) : bookmark.color;
  const color = colorOverride ?? bookmark.color;
  const favicon = host ? faviconUrl(host) : null;

  // Auto-derive name only when the host changes - editing just the path leaves
  // the name alone.
  useEffect(() => {
    setFaviconFailed(false);
    if (!host) return;
    if (!nameEdited && host !== prevDomainRef.current) {
      setNameOverride(deriveName(host));
      prevDomainRef.current = host;
    }
  }, [host]);

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  async function handleSave() {
    if (!domain) return;
    setLoading(true);
    try {
      await onSave(bookmark.id, {
        domain,
        name: nameOverride.trim() || host || domain,
        faviconUrl: favicon || '',
        color: colorOverride ?? autoColor,
        folderId: selectedFolderId,
      });
      onClose();
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    setLoading(true);
    try {
      await onDelete(bookmark.id);
      onClose();
    } finally {
      setLoading(false);
    }
  }

  const previewBg = `color-mix(in oklab, ${color} 15%, var(--surface2))`;
  const previewBorder = `color-mix(in oklab, ${color} 28%, transparent)`;

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.card} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Edit link</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.preview} style={{ background: previewBg, border: `1px solid ${previewBorder}` }}>
          <div className={styles.previewChip}>
            <span className={styles.previewMonogram} style={{ color }}>
              {nameOverride?.charAt(0).toUpperCase() || domain?.charAt(0).toUpperCase() || '?'}
            </span>
            {!faviconFailed && favicon && (
              <img className={styles.previewFavicon} src={favicon} alt="" onError={() => setFaviconFailed(true)} />
            )}
          </div>
          <div className={styles.previewText}>
            <div className={styles.previewName}>{nameOverride || domain || 'Preview'}</div>
            {domain && <div className={styles.previewDomain}>{domain}</div>}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Website URL</label>
          <input
            className={styles.urlInput}
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Display name</label>
          <input
            className={`${styles.urlInput} ${ownStyles.nameInput}`}
            type="text"
            value={nameOverride}
            placeholder={domain || bookmark.name}
            onChange={e => { setNameOverride(e.target.value); setNameEdited(true); }}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Color</label>
          <div className={ownStyles.colorRow}>
            <button
              className={`${ownStyles.colorSwatch} ${!colorOverride ? ownStyles.colorSwatchAuto : ''}`}
              style={{ background: autoColor }}
              onClick={() => setColorOverride(null)}
              title="Auto (derived from favicon)"
            >
              {!colorOverride && <span className={ownStyles.autoCheck}>✓</span>}
            </button>
            {PALETTE.map(c => (
              <button
                key={c}
                className={`${ownStyles.colorSwatch} ${colorOverride === c ? ownStyles.colorSwatchSelected : ''}`}
                style={{ background: c }}
                onClick={() => setColorOverride(c)}
              />
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Folder</label>
          <div className={styles.folderChips}>
            {folders.map(f => {
              const isSelected = f.id === selectedFolderId;
              return (
                <button
                  key={f.id}
                  className={`${styles.chip} ${isSelected ? styles.selected : ''}`}
                  style={isSelected ? {
                    background: `color-mix(in oklab, ${f.color} 20%, var(--surface))`,
                    borderColor: f.color,
                  } : {}}
                  onClick={() => setSelectedFolderId(f.id)}
                >
                  <span className={styles.colorDot} style={{ background: f.color }} />
                  {f.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className={ownStyles.actionsRow}>
          {confirming ? (
            <div className={ownStyles.confirmRow}>
              <span className={ownStyles.confirmText}>Delete this bookmark?</span>
              <button className={ownStyles.confirmYes} onClick={handleDelete} disabled={loading}>Yes, delete</button>
              <button className={ownStyles.confirmNo} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button className={ownStyles.deleteBtn} onClick={() => setConfirming(true)}>Delete</button>
          )}
          <div className={styles.actions} style={{ margin: 0 }}>
            <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={styles.addBtn} onClick={handleSave} disabled={!domain || loading}>
              {loading ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
