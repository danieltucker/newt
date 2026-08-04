import { useState } from 'react';
import styles from './NewFolderModal.module.css';
import ownStyles from './EditFolderModal.module.css';
import { Folder } from '../types';

const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

// Name, colour, delete. Feeds used to be edited here too, which is what made
// them so hard to find: managing what you read meant first picking the right
// bookmark folder. They live in the feed manager now - see FeedManagerModal.
interface Props {
  folder: Folder;
  onSave: (id: string, updates: { name: string; color: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

export default function EditFolderModal({ folder, onSave, onDelete, onClose }: Props) {
  const [name, setName]   = useState(folder.name);
  const [color, setColor] = useState(folder.color);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.card} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>Edit folder</div>

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
