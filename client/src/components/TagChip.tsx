import styles from './TagChip.module.css';

// A tag on an article, with the star that makes it a favorite.
//
// Favoriting lives on the tag itself rather than in a settings box: nobody goes
// looking for a text field to type "Apple" into, and starring a real tag means
// the stored label is one that actually occurs in the wild. On-card tags were
// inert before this, so a click had no meaning to take away.
//
// The surface owns the chip's look and passes it in - the feed and the reading
// list style their tags differently and shouldn't be forced to agree.
export default function TagChip({ tag, starred, coveredBy, onToggle, className = '' }: {
  tag: string;
  /** Some favorite covers this tag - the star is filled. */
  starred: boolean;
  /** The covering favorite, when it isn't the tag itself. Explains the star. */
  coveredBy?: string;
  onToggle: (tag: string) => void;
  className?: string;
}) {
  const title = starred
    ? coveredBy && coveredBy.toLowerCase() !== tag.toLowerCase()
      ? `Matched by your favorite “${coveredBy}” - click to remove it`
      : `Remove “${tag}” from favorites`
    : `Favorite “${tag}” - articles tagged this way get flagged`;

  return (
    <button
      type="button"
      className={`${styles.chip} ${starred ? styles.chipStarred : ''} ${className}`}
      onClick={e => { e.preventDefault(); e.stopPropagation(); onToggle(tag); }}
      title={title}
      aria-pressed={starred}
    >
      {/* Collapsed until hovered - see the stylesheet. The behaviour is opt-in
          per surface: the reading list's filter chips collapse the button
          around the star instead, so the star itself stays drawn. */}
      <StarIcon filled={starred} className={styles.starCollapse} />
      <span className={styles.label}>{tag}</span>
    </button>
  );
}

// Filled when favorited, hollow otherwise. Pass `styles.starCollapse` (or let a
// parent collapse the control around it) to keep the hollow one out of the way
// until hover - an unstarred outline on every tag of every card would be more
// chrome than the tags themselves.
export function StarIcon({ filled, className = '' }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={`${styles.star} ${filled ? styles.starOn : ''} ${className}`}
      width="10" height="10" viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5-5.8-3.05L6.2 20.5l1.1-6.5-4.7-4.6 6.5-.95z" />
    </svg>
  );
}
