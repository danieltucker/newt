import styles from './PostTags.module.css';

// The tags an author put on a post, wherever a post is shown: the reader, the
// profile's Posts tab, the author's own manage list.
//
// Stored bare and displayed with a '#' (see normalizeTags on the server) - the
// hash is how a tag is spelled on screen, not part of its name, which is what
// keeps "#news" and "news" from becoming two different tags.
//
// Not TagChip: that control's whole job is the star that makes a tag a
// *favourite*, which is a reader's relationship with a topic in their feed. A
// post's tags are the author's own labels and there is nothing to favourite -
// they either lead somewhere (the author's posts under that tag) or they say
// what the post is about and nothing more.
export default function PostTags({ tags, onSelect, active, className = '' }: {
  tags: string[];
  /** Makes the tags links to the author's other posts. Omit for display only. */
  onSelect?: (tag: string) => void;
  /** The tag currently being filtered on, drawn as pressed. */
  active?: string;
  className?: string;
}) {
  if (tags.length === 0) return null;

  return (
    <div className={`${styles.row} ${className}`}>
      {tags.map(tag => {
        const on = active === tag;
        // A row of identical-looking chips where only some do something is
        // worse than either alternative, so the whole row is one or the other.
        if (!onSelect) {
          return <span key={tag} className={styles.tag}>#{tag}</span>;
        }
        return (
          <button
            key={tag}
            type="button"
            className={`${styles.tag} ${styles.tagBtn} ${on ? styles.tagOn : ''}`}
            aria-pressed={on}
            title={on ? `Showing posts tagged “${tag}” - click to clear` : `Show posts tagged “${tag}”`}
            // Tags sit inside cards that are themselves clickable.
            onClick={e => { e.preventDefault(); e.stopPropagation(); onSelect(on ? '' : tag); }}
          >
            #{tag}
          </button>
        );
      })}
    </div>
  );
}
