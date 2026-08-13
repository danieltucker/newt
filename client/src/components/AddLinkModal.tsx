import { useState, useEffect, useRef } from 'react';
import styles from './AddLinkModal.module.css';
import { Folder } from '../types';
import { parseDomain, parseLink, deriveName, deriveColor, faviconUrl, PALETTE } from '../utils/color';
import { apiErrorText } from '../services/api';
import CloseButton from './CloseButton';

interface Props {
  folders: Folder[];
  defaultFolderId: string | null;
  defaultUrl?: string;
  onAdd: (payload: { folderId: string; domain: string; name: string; faviconUrl: string; color: string }) => Promise<void>;
  /** Resolves to the new folder so the link being added can be filed into it. */
  onCreateFolder: (name: string, color: string) => Promise<Folder>;
  onClose: () => void;
}

export default function AddLinkModal({ folders, defaultFolderId, defaultUrl, onAdd, onCreateFolder, onClose }: Props) {
  const [url, setUrl] = useState(defaultUrl ?? '');
  const [nameOverride, setNameOverride] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState(defaultFolderId || folders[0]?.id || '');
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Inline folder creation, rather than a second modal on top of this one: the
  // link being typed stays on screen and the new folder is selected on the spot.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderColor, setFolderColor] = useState(PALETTE[0]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderError, setFolderError] = useState('');

  const prevDomainRef = useRef<string | null>(null);

  // domain = the full link that gets saved / navigated to (may include a path,
  // e.g. github.com/danieltucker); host = just the site, for favicon/name/colour.
  const domain = parseLink(url);
  const host = parseDomain(url);
  const derivedName = host ? deriveName(host) : null;
  const color = host ? deriveColor(host) : null;
  const favicon = host ? faviconUrl(host) : null;

  // Auto-fill name when the host changes, unless the user has edited it
  useEffect(() => {
    setFaviconFailed(false);
    if (!host) return;
    if (!nameEdited && host !== prevDomainRef.current && derivedName) {
      setNameOverride(derivedName);
      prevDomainRef.current = host;
    }
  }, [host]);

  const displayName = nameOverride || derivedName || '';

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  async function handleAdd() {
    if (!domain || !color || !selectedFolderId) return;
    setLoading(true);
    setError('');
    try {
      await onAdd({
        folderId: selectedFolderId,
        domain,
        name: displayName || host || domain,
        faviconUrl: favicon || '',
        color,
      });
      onClose();
    } catch (e) {
      // The bookmark cap answers 409 with a sentence worth reading; without
      // this the dialog just sat there as though nothing had been pressed.
      setError(apiErrorText(e, "Couldn't add that link"));
    } finally {
      setLoading(false);
    }
  }

  function openNewFolder() {
    // Start on a colour no folder is using yet, so the swatches don't hand the
    // user a duplicate of the folder sitting right next to it.
    const used = new Set(folders.map(f => f.color.toLowerCase()));
    setFolderColor(PALETTE.find(c => !used.has(c.toLowerCase())) ?? PALETTE[0]);
    setFolderName('');
    setFolderError('');
    setNewFolderOpen(true);
  }

  async function handleCreateFolder() {
    const name = folderName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    setFolderError('');
    try {
      const folder = await onCreateFolder(name, folderColor);
      setSelectedFolderId(folder.id);
      setNewFolderOpen(false);
      setFolderName('');
    } catch {
      setFolderError("Couldn't create that folder");
    } finally {
      setCreatingFolder(false);
    }
  }

  const previewBg = color
    ? `color-mix(in oklab, ${color} 15%, var(--surface2))`
    : 'var(--surface2)';
  const previewBorder = color
    ? `color-mix(in oklab, ${color} 28%, transparent)`
    : 'var(--border)';

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.card} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Add a link</span>
          <CloseButton onClick={onClose} />
        </div>

        {/* Live preview */}
        <div className={styles.preview} style={{ background: previewBg, border: `1px solid ${previewBorder}` }}>
          <div className={styles.previewChip}>
            {domain ? (
              <>
                <span className={styles.previewMonogram} style={{ color: color! }}>
                  {displayName.charAt(0).toUpperCase() || domain.charAt(0).toUpperCase()}
                </span>
                {!faviconFailed && favicon && (
                  <img
                    className={styles.previewFavicon}
                    src={favicon}
                    alt=""
                    onError={() => setFaviconFailed(true)}
                  />
                )}
              </>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            )}
          </div>
          {domain ? (
            <div className={styles.previewText}>
              <div className={styles.previewName}>{displayName}</div>
              <div className={styles.previewDomain}>{domain}</div>
            </div>
          ) : (
            <span className={styles.previewEmpty}>Preview appears here</span>
          )}
        </div>

        {/* URL input */}
        <div className={styles.field}>
          <label className={styles.label}>Website URL</label>
          {/* Same as the reading list's add field: as `type="text"` a phone
              capitalises and autocorrects what it takes for prose, and an
              address is not prose. */}
          <input
            className={styles.urlInput}
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="figma.com"
            value={url}
            onChange={e => setUrl(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') onClose(); }}
          />
        </div>

        {/* Name input - shown once a domain is recognised */}
        {domain && (
          <div className={styles.field}>
            <label className={styles.label}>Display name</label>
            <input
              className={styles.urlInput}
              type="text"
              placeholder={derivedName || domain}
              value={nameOverride}
              onChange={e => { setNameOverride(e.target.value); setNameEdited(true); }}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') onClose(); }}
            />
          </div>
        )}

        {/* Folder chips */}
        <div className={styles.field}>
          <label className={styles.label}>Add to folder</label>
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
            {!newFolderOpen && (
              <button className={styles.newFolderChip} onClick={openNewFolder}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
                New folder
              </button>
            )}
          </div>
          {folders.length === 0 && !newFolderOpen && (
            <div className={styles.helper}>Every link lives in a folder — make one to file this in.</div>
          )}

          {newFolderOpen && (
            <div className={styles.newFolder}>
              <input
                className={styles.newFolderInput}
                type="text"
                placeholder="Folder name"
                maxLength={100}
                value={folderName}
                onChange={e => setFolderName(e.target.value)}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleCreateFolder(); }
                  // Escape backs out of the folder, not out of the link.
                  if (e.key === 'Escape') { e.stopPropagation(); setNewFolderOpen(false); }
                }}
              />
              <div className={styles.swatchRow}>
                {PALETTE.map(c => (
                  <button
                    key={c}
                    className={`${styles.swatch} ${c === folderColor ? styles.swatchSelected : ''}`}
                    style={{ background: c }}
                    aria-label={`Colour ${c}`}
                    aria-pressed={c === folderColor}
                    onClick={() => setFolderColor(c)}
                  />
                ))}
              </div>
              {folderError && <div className={styles.folderError}>{folderError}</div>}
              <div className={styles.newFolderActions}>
                <button className={styles.newFolderCancel} onClick={() => setNewFolderOpen(false)}>Cancel</button>
                <button
                  className={styles.newFolderCreate}
                  onClick={handleCreateFolder}
                  disabled={!folderName.trim() || creatingFolder}
                >
                  {creatingFolder ? 'Creating…' : 'Create folder'}
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <div className={styles.saveError} role="alert">{error}</div>}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={styles.addBtn} onClick={handleAdd} disabled={!domain || !selectedFolderId || loading}>
            {loading ? 'Adding…' : 'Add link'}
          </button>
        </div>
      </div>
    </div>
  );
}
