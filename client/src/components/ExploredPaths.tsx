import { useEffect, useState } from 'react';
import styles from './ExploredPaths.module.css';
import { ExploredPath, getExploredPaths } from '../services/llm';
import { relTime } from '../utils/notifications';
import { VIS_META } from './VisibilityMeta';

// ── Explored paths ────────────────────────────────────────────────────────
// What was done with this article beyond replying to it, sitting between the
// text and the comment thread.
//
// Two things end up here and they are deliberately one list. An explore is a
// conversation somebody had with a model about the piece; a post is somebody
// writing about it at length. Both are more considered than a comment, both
// were previously invisible to everyone but their author, and to a reader
// arriving at the foot of an article they answer the same question - did anyone
// take this further, and is it worth following them.
//
// Renders nothing at all when the list is empty. A heading over "no explored
// paths yet" would put a permanent empty shelf on every article on the
// instance, most of which will never have one.

interface Props {
  articleUrl: string;
  /** Opens a path in the app shell rather than as a document load. */
  navigate?: (to: string) => void;
}

export default function ExploredPaths({ articleUrl, navigate }: Props) {
  const [paths, setPaths] = useState<ExploredPath[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Silent on failure. This is an extra shelf on a page whose main content
    // has already loaded - an error box here would report a problem the reader
    // cannot act on, about something they did not ask for.
    getExploredPaths(articleUrl)
      .then(r => { if (!cancelled) setPaths(r.paths); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [articleUrl]);

  if (paths.length === 0) return null;

  return (
    <section className={styles.wrap} aria-label="Explored paths">
      <h3 className={styles.heading}>
        Explored paths
        <span className={styles.count}>{paths.length}</span>
      </h3>

      <ul className={styles.list}>
        {paths.map(p => (
          <li key={`${p.kind}-${p.id}`}>
            <a
              className={styles.item}
              href={p.href}
              onClick={e => {
                // In-app where we can - these all land on pages the shell can
                // draw, and a document load would drop the reader out of the
                // article they are standing in.
                if (navigate && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                  e.preventDefault();
                  navigate(p.href);
                }
              }}
            >
              <span className={styles.kind} data-kind={p.kind}>
                {p.kind === 'explore' ? <ExploreGlyph /> : <PostGlyph />}
                {p.kind === 'explore' ? 'Explore' : 'Post'}
              </span>

              <span className={styles.main}>
                <span className={styles.title}>{p.title}</span>
                {p.snippet && <span className={styles.snippet}>{p.snippet}</span>}
                <span className={styles.meta}>
                  {/* Whose it is comes first: on a page about somebody else's
                      article, who took it further is the useful part. */}
                  <span className={styles.who}>
                    {p.own ? 'You' : p.author?.displayName || 'Someone'}
                  </span>
                  {p.turns != null && (
                    <>
                      <span className={styles.dot}>·</span>
                      {/* Exchanges rather than messages - a question and its
                          answer are one turn, and counting rows would make
                          every thread look twice as long as it is. */}
                      <span>{p.turns} exchange{p.turns === 1 ? '' : 's'}</span>
                    </>
                  )}
                  {p.at && (
                    <>
                      <span className={styles.dot}>·</span>
                      <span>{relTime(p.at)}</span>
                    </>
                  )}
                  {/* Only the narrower tier is marked. "Public" on a page you
                      are already reading says nothing; "Friends" tells the
                      author who else is seeing this, which is the thing worth
                      knowing. */}
                  {p.visibility === 'friends' && (
                    <>
                      <span className={styles.dot}>·</span>
                      <span className={styles.tier}>
                        {VIS_META.friends.icon}
                        {VIS_META.friends.tag}
                      </span>
                    </>
                  )}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExploreGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function PostGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <polyline points="14 4 14 10 20 10" />
    </svg>
  );
}
