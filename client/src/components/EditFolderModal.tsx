import { useState, useRef } from 'react';
import styles from './NewFolderModal.module.css';
import ownStyles from './EditFolderModal.module.css';
import { Folder, FolderFeed } from '../types';
import { feedLabel, feedHost } from '../utils/feedLabel';

const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

interface BookmarkFeed {
  name: string;
  domain: string;
  feedUrl: string;
}

interface Props {
  folder: Folder;
  folders: Folder[];
  bookmarkFeeds?: BookmarkFeed[];
  onSave: (id: string, updates: { name: string; color: string }) => Promise<void>;
  onAddFeed: (folderId: string, url: string, name?: string) => Promise<unknown>;
  onUpdateFeed: (feedId: string, updates: { url?: string; name?: string; folderId?: string }) => Promise<unknown>;
  onDeleteFeed: (feedId: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

// Pulls the readable message out of an api* rejection, whose Error.message is
// the raw JSON error body.
function errText(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    try { return (JSON.parse(e.message).error as string) || fallback; } catch { /* not JSON */ }
  }
  return fallback;
}

const XIcon = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M1 1l10 10M11 1L1 11"/>
  </svg>
);

const PencilIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

// One feed, either as a summary row or expanded into its editor. Feed edits save
// on their own - unlike the folder's name and colour they're separate resources,
// and a move writes to a folder this modal isn't editing.
function FeedRow({ feed, folders, currentFolderId, bookmarkFeeds, onUpdate, onDelete }: {
  feed: FolderFeed;
  folders: Folder[];
  currentFolderId: string;
  bookmarkFeeds: BookmarkFeed[];
  onUpdate: (feedId: string, updates: { url?: string; name?: string; folderId?: string }) => Promise<unknown>;
  onDelete: (feedId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feed.name);
  const [url, setUrl] = useState(feed.url);
  const [folderId, setFolderId] = useState(currentFolderId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function open() {
    setName(feed.name);
    setUrl(feed.url);
    setFolderId(currentFolderId);
    setError('');
    setEditing(true);
  }

  async function save() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) { setError('A feed URL is required'); return; }
    // Send only what actually changed, so an untouched field can't trip the
    // server's validation or its duplicate check.
    const updates: { url?: string; name?: string; folderId?: string } = {};
    if (trimmedUrl !== feed.url) updates.url = trimmedUrl;
    if (name.trim() !== feed.name) updates.name = name.trim();
    if (folderId !== currentFolderId) updates.folderId = folderId;
    if (Object.keys(updates).length === 0) { setEditing(false); return; }

    setBusy(true);
    setError('');
    try {
      await onUpdate(feed.id, updates);
      setEditing(false);
    } catch (e) {
      setError(errText(e, 'Could not save that change'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await onDelete(feed.id);
    } catch (e) {
      setError(errText(e, 'Could not remove that feed'));
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className={ownStyles.feedItem}>
        <span className={ownStyles.feedLabel}>{feedLabel(feed, bookmarkFeeds)}</span>
        <span className={ownStyles.feedHost}>{feedHost(feed.url)}</span>
        <button className={ownStyles.feedEdit} onClick={open} title="Edit feed"><PencilIcon /></button>
        <button className={ownStyles.feedRemove} onClick={remove} disabled={busy} title="Remove"><XIcon /></button>
      </div>
    );
  }

  return (
    <div className={ownStyles.feedEditor}>
      <label className={ownStyles.feedFieldLabel}>Name</label>
      <input
        className={ownStyles.feedInput}
        value={name}
        autoFocus
        placeholder={feedLabel({ name: '', url: feed.url }, bookmarkFeeds)}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
      />

      <label className={ownStyles.feedFieldLabel}>Feed URL</label>
      <input
        className={ownStyles.feedInput}
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
      />

      <label className={ownStyles.feedFieldLabel}>Folder</label>
      <select className={ownStyles.feedSelect} value={folderId} onChange={e => setFolderId(e.target.value)}>
        {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>

      {error && <div className={ownStyles.feedError}>{error}</div>}

      <div className={ownStyles.feedEditorActions}>
        <button className={ownStyles.feedCancel} onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
        <button className={ownStyles.feedAdd} onClick={save} disabled={busy || !url.trim()}>
          {busy ? 'Saving…' : 'Save feed'}
        </button>
      </div>
    </div>
  );
}

export default function EditFolderModal({
  folder, folders, bookmarkFeeds = [], onSave, onAddFeed, onUpdateFeed, onDeleteFeed, onDelete, onClose,
}: Props) {
  const [name, setName]         = useState(folder.name);
  const [color, setColor]       = useState(folder.color);
  const [feedInput, setFeedInput] = useState('');
  const [feedError, setFeedError] = useState('');
  const [adding, setAdding]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [confirming, setConfirming] = useState(false);
  const feedInputRef = useRef<HTMLInputElement>(null);

  // Read live from the folders list rather than the prop snapshot, so a feed
  // added, renamed or moved away shows up without reopening the modal.
  const feeds = folders.find(f => f.id === folder.id)?.feeds ?? folder.feeds;

  async function addFeed(url: string, feedName = '') {
    const trimmed = url.trim();
    if (!trimmed) return;
    setAdding(true);
    setFeedError('');
    try {
      await onAddFeed(folder.id, trimmed, feedName);
      setFeedInput('');
      feedInputRef.current?.focus();
    } catch (e) {
      setFeedError(errText(e, 'Could not add that feed'));
    } finally {
      setAdding(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await onSave(folder.id, { name: name.trim(), color });
      onClose();
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    setLoading(true);
    try {
      await onDelete(folder.id);
      onClose();
    } finally {
      setLoading(false);
    }
  }

  const subscribed = new Set(feeds.map(f => f.url));
  const unusedBookmarkFeeds = bookmarkFeeds.filter(b => !subscribed.has(b.feedUrl));

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${styles.card} ${ownStyles.wideCard}`} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>Edit folder</div>

        <div className={ownStyles.body}>
          <label className={styles.label}>Folder name</label>
          <input
            className={styles.input}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
          />

          <label className={styles.label}>Color</label>
          <div className={styles.colorRow}>
            {PALETTE.map(c => (
              <button
                key={c}
                className={`${styles.colorSwatch} ${c === color ? styles.selected : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>

          {/* ── RSS Feeds ────────────────────────────── */}
          <label className={styles.label}>RSS Feeds</label>
          <div className={ownStyles.feedNote}>Feed changes save as you make them.</div>

          {feeds.length > 0 && (
            <div className={ownStyles.feedList}>
              {feeds.map(f => (
                <FeedRow
                  key={f.id}
                  feed={f}
                  folders={folders}
                  currentFolderId={folder.id}
                  bookmarkFeeds={bookmarkFeeds}
                  onUpdate={onUpdateFeed}
                  onDelete={onDeleteFeed}
                />
              ))}
            </div>
          )}

          {unusedBookmarkFeeds.length > 0 && (
            <div className={ownStyles.suggestions}>
              <div className={ownStyles.sugLabel}>From bookmarks in this folder</div>
              {unusedBookmarkFeeds.map(b => (
                <button
                  key={b.feedUrl}
                  className={ownStyles.sugItem}
                  disabled={adding}
                  onClick={() => addFeed(b.feedUrl, b.name)}
                >
                  <span className={ownStyles.sugName}>{b.name}</span>
                  <span className={ownStyles.sugDomain}>{b.domain}</span>
                  <span className={ownStyles.sugAdd}>+</span>
                </button>
              ))}
            </div>
          )}

          {feedError && <div className={ownStyles.feedError}>{feedError}</div>}

          <form
            className={ownStyles.feedForm}
            onSubmit={e => { e.preventDefault(); addFeed(feedInput); }}
          >
            <input
              ref={feedInputRef}
              className={ownStyles.feedInput}
              value={feedInput}
              onChange={e => setFeedInput(e.target.value)}
              placeholder="https://example.com/feed"
            />
            <button className={ownStyles.feedAdd} type="submit" disabled={!feedInput.trim() || adding}>
              {adding ? 'Adding…' : 'Add'}
            </button>
          </form>
        </div>

        <div className={ownStyles.actionsRow}>
          {confirming ? (
            <div className={ownStyles.confirmRow}>
              <span className={ownStyles.confirmText}>Delete folder and all its bookmarks?</span>
              <button className={ownStyles.confirmYes} onClick={handleDelete} disabled={loading}>Delete</button>
              <button className={ownStyles.confirmNo} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button className={ownStyles.deleteBtn} onClick={() => setConfirming(true)}>Delete folder</button>
          )}
          <div className={styles.actions}>
            <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={styles.createBtn} onClick={handleSave} disabled={!name.trim() || loading}>
              {loading ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
