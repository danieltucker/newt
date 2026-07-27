import { useRef } from 'react';
import styles from './TagChipInput.module.css';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  inputValue: string;
  onInputChange: (val: string) => void;
}

export default function TagChipInput({ tags, onChange, placeholder, inputValue, onInputChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const val = inputValue.trim().toLowerCase().replace(/,/g, '');
    if (val && !tags.includes(val)) onChange([...tags, val]);
    onInputChange('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Tab' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      onChange(tags.slice(0, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  }

  function removeTag(tag: string) {
    onChange(tags.filter(t => t !== tag));
  }

  return (
    <div className={styles.wrap} onClick={() => inputRef.current?.focus()}>
      {tags.map(t => (
        <span key={t} className={styles.chip}>
          {t}
          <button
            type="button"
            className={styles.remove}
            onClick={e => { e.stopPropagation(); removeTag(t); }}
            aria-label={`Remove tag ${t}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className={styles.input}
        value={inputValue}
        onChange={e => onInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={tags.length === 0 ? (placeholder ?? 'Tags - Tab or comma to add') : ''}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}
