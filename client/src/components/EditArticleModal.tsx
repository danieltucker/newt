import { useState, useEffect } from 'react';
import styles from './EditArticleModal.module.css';
import { ReadingListItem } from '../types';
import TagChipInput from './TagChipInput';

interface Props {
  item: ReadingListItem;
  onSave: (id: string, patch: Partial<Pick<ReadingListItem, 'title' | 'tag' | 'notes'>>) => Promise<void>;
  onClose: () => void;
}

function parseTags(tag: string): string[] {
  return tag.split(',').map(t => t.trim()).filter(Boolean);
}

export default function EditArticleModal({ item, onSave, onClose }: Props) {
  const [title, setTitle] = useState(item.title);
  const [tags, setTags] = useState<string[]>(parseTags(item.tag));
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);

  // Sync if item changes
  useEffect(() => {
    setTitle(item.title);
    setTags(parseTags(item.tag));
  }, [item.id]);

  async function handleSave() {
    const finalTags = tagInput.trim()
      ? [...tags, tagInput.trim().toLowerCase()]
      : tags;
    setSaving(true);
    try {
      // notes is left out entirely so the server keeps whatever is stored -
      // comments own that content now
      await onSave(item.id, {
        title: title.trim() || item.title,
        tag: finalTags.join(','),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={handleKeyDown}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <span className={styles.heading}>Edit article</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <a href={item.url} className={styles.urlPreview} target="_blank" rel="noopener noreferrer">
          {item.url}
        </a>

        <div className={styles.field}>
          <label className={styles.label}>Title</label>
          <input
            className={styles.input}
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
            autoFocus
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Tags</label>
          <TagChipInput
            tags={tags}
            onChange={setTags}
            inputValue={tagInput}
            onInputChange={setTagInput}
          />
        </div>

        {/* Notes became comments - write them on the card's comment thread,
            where they can be threaded, titled and optionally shared. */}

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
