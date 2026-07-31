import { useState } from 'react';
import styles from './SaveArticleModal.module.css';
import TagChipInput from './TagChipInput';
import CloseButton from './CloseButton';

interface Props {
  url: string;
  title: string;
  source: string;
  imageUrl?: string;
  initialTag?: string;
  initialReadTime?: string;
  onSave: (data: { url: string; title: string; source: string; readTime: string; tag: string; imageUrl: string }) => Promise<void>;
  onClose: () => void;
}

function parseTags(raw: string): string[] {
  return raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

export default function SaveArticleModal({ url, title, source, imageUrl = '', initialTag = '', initialReadTime = '', onSave, onClose }: Props) {
  const [titleVal, setTitleVal]   = useState(title);
  const [sourceVal, setSourceVal] = useState(source);
  const [tags, setTags]           = useState<string[]>(parseTags(initialTag));
  const [tagInput, setTagInput]   = useState('');
  const [readTime, setReadTime]   = useState(initialReadTime);
  const [saving, setSaving]       = useState(false);

  async function handleSave() {
    if (!titleVal.trim()) return;
    const finalTags = tagInput.trim()
      ? [...tags, tagInput.trim().toLowerCase()]
      : tags;
    setSaving(true);
    try {
      await onSave({ url, title: titleVal.trim(), source: sourceVal.trim(), readTime: readTime.trim(), tag: finalTags.join(','), imageUrl });
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave();
    if (e.key === 'Escape') onClose();
  }

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.card} onKeyDown={handleKeyDown}>
        <div className={styles.header}>
          <span className={styles.heading}>Save to reading list</span>
          <CloseButton onClick={onClose} />
        </div>

        <a href={url} target="_blank" rel="noopener noreferrer" className={styles.urlPreview} title={url}>
          {url.replace(/^https?:\/\//i, '')}
        </a>

        <div className={styles.fields}>
          <label className={styles.label}>Title</label>
          <input
            className={styles.input}
            value={titleVal}
            onChange={e => setTitleVal(e.target.value)}
            autoFocus
          />

          <label className={styles.label}>Source</label>
          <input
            className={styles.input}
            value={sourceVal}
            onChange={e => setSourceVal(e.target.value)}
          />

          <label className={styles.label}>Tags</label>
          <TagChipInput
            tags={tags}
            onChange={setTags}
            inputValue={tagInput}
            onInputChange={setTagInput}
          />

          <label className={styles.label}>Read time</label>
          <input
            className={`${styles.input} ${styles.inputNarrow}`}
            value={readTime}
            onChange={e => setReadTime(e.target.value)}
            placeholder="e.g. 5 min"
          />
        </div>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={saving || !titleVal.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
