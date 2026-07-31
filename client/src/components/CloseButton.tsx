import styles from './CloseButton.module.css';

// The one way out of a modal. Every dialog had grown its own ✕ - a circle here,
// a square there, a bare glyph somewhere else - so the control you reach for
// most often was the one that looked different every time. This is the article
// reader's version, which is the shape the rest now follow.
//
// It is always an icon, never a text glyph: "✕" in a font renders at whatever
// weight and baseline that font happens to give it, which is what made the old
// buttons look mismatched even where their boxes agreed.

interface Props {
  onClick: () => void;
  /** Accessible name and tooltip. Say what closing does when it isn't obvious. */
  label?: string;
  /** For the rare host that needs to place it (absolute corners, grid areas). */
  className?: string;
}

export default function CloseButton({ onClick, label = 'Close', className = '' }: Props) {
  return (
    <button
      type="button"
      className={`${styles.close} ${className}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
        strokeWidth="1.9" strokeLinecap="round" aria-hidden>
        <path d="M1 1l10 10M11 1L1 11" />
      </svg>
    </button>
  );
}
