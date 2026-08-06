import useSlidingThumb from '../hooks/useSlidingThumb';
import styles from './LayoutSwitch.module.css';

export type LayoutOption<T extends string> = {
  value: T;
  title: string;
  icon: React.ReactNode;
};

export function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M1.5 3h11M1.5 7h11M1.5 11h11" />
    </svg>
  );
}

export function CardsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1" y="1" width="5.2" height="5.2" rx="1.2" />
      <rect x="7.8" y="1" width="5.2" height="5.2" rx="1.2" />
      <rect x="1" y="7.8" width="5.2" height="5.2" rx="1.2" />
      <rect x="7.8" y="7.8" width="5.2" height="5.2" rx="1.2" />
    </svg>
  );
}

export function MagazineIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <rect x="1" y="1" width="7.4" height="6" rx="1.2" />
      <path d="M10.8 1.5h2.2M10.8 4h2.2M10.8 6.5h2.2" strokeWidth="1.6" />
      <rect x="1" y="9.4" width="12" height="3.6" rx="1.2" />
    </svg>
  );
}

interface Props<T extends string> {
  value: T;
  options: LayoutOption<T>[];
  onChange: (value: T) => void;
  label?: string;
}

export default function LayoutSwitch<T extends string>({ value, options, onChange, label = 'Layout' }: Props<T>) {
  const { trackRef, setItem, thumbProps } = useSlidingThumb(value);

  return (
    <div className={styles.switch} role="group" aria-label={label} ref={trackRef}>
      {/* The selection itself, as one box that moves between the segments
          rather than a fill that jumps from one to the next. */}
      <span className={styles.thumb} {...thumbProps} />
      {options.map(o => (
        <button
          key={o.value}
          ref={setItem(o.value)}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          className={`${styles.btn} ${value === o.value ? styles.active : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
