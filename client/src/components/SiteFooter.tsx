import NewtMark from './NewtMark';
import styles from './SiteFooter.module.css';

// The footer, on every page that has a bottom.
//
// Themed off the mark rather than decorated at random: the hairline above it is
// the logo's own gradient stretched flat, and a set of tracks walks in from the
// left on hover, as though the newt in the corner had just arrived. Rough-skinned
// newts really are native to this corner of Washington, which is the joke the
// tooltip is in on - the logo and "Designed in Bellingham" are the same fact.
const TRACK_COUNT = 5;

// One newt print: a small palm with four toes, alternating left and right down
// the trail so it reads as walking rather than hopping.
function Track({ index }: { index: number }) {
  const flip = index % 2 === 1;
  return (
    <svg
      className={styles.track}
      style={{ animationDelay: `${index * 90}ms`, transform: `rotate(${flip ? 14 : -14}deg)` }}
      width="9" height="9" viewBox="0 0 12 12" aria-hidden
    >
      <ellipse cx="6" cy="8" rx="2.1" ry="2.6" />
      <circle cx="2.6" cy="4.6" r="1.05" />
      <circle cx="5"   cy="2.6" r="1.05" />
      <circle cx="7.6" cy="2.8" r="1.05" />
      <circle cx="9.6" cy="5"   r="1.05" />
    </svg>
  );
}

export default function SiteFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`${styles.footer} ${className}`}>
      <div className={styles.rule} aria-hidden />

      <div className={styles.inner}>
        <div className={styles.brand} title="Rough-skinned newts are native to this corner of Washington">
          <span className={styles.tracks} aria-hidden>
            {Array.from({ length: TRACK_COUNT }, (_, i) => (
              <Track key={i} index={i} />
            ))}
          </span>
          <NewtMark className={styles.mark} />
          <span className={styles.wordmark}>newt</span>
        </div>

        <p className={styles.credit}>
          Designed in <span className={styles.place}>Bellingham</span>
          <span className={styles.dot} aria-hidden>·</span>
          hosted by{' '}
          <a
            className={styles.link}
            href="https://bellinghamhosting.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            bellinghamhosting.com
          </a>
        </p>

        <a
          className={styles.version}
          href="https://github.com/danieltucker/newTab"
          target="_blank"
          rel="noopener noreferrer"
        >
          v{__APP_VERSION__}
        </a>
      </div>
    </footer>
  );
}
