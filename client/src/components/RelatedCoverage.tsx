import { useEffect, useState } from 'react';
import { RelatedArticle, getRelatedArticles } from '../services/llm';
import styles from './RelatedCoverage.module.css';

/**
 * Other sites' coverage of the same story.
 *
 * Sits above Explored paths on an article, and the ordering is deliberate: this
 * answers "what else was written about this", the section below it answers
 * "what did people here do with it". Outward first, because a reader who has
 * just finished the piece is more likely to want the other account of the event
 * than a transcript about this one.
 *
 * **Draws nothing when there is nothing.** Most articles have no pair — the
 * task that builds these is written to return nothing rather than reach — so an
 * empty heading would be on almost every page, and a section that is usually
 * empty teaches people not to look at it.
 */

interface Props {
  articleUrl: string;
}

/** The host, as the reader thinks of it. Already normalised by the server. */
function hostLabel(host: string): string {
  return host || 'elsewhere';
}

export default function RelatedCoverage({ articleUrl }: Props) {
  const [items, setItems] = useState<RelatedArticle[]>([]);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    void getRelatedArticles(articleUrl)
      .then(res => { if (!cancelled) setItems(res.related); })
      // Silent: this is a supplementary section on a page whose main content
      // has already painted, and an error banner for it would be louder than
      // the feature is important.
      .catch(() => { /* leave it empty */ });
    return () => { cancelled = true; };
  }, [articleUrl]);

  if (items.length === 0) return null;

  return (
    <section className={styles.wrap} aria-label="Related coverage">
      <h3 className={styles.heading}>
        Also covered by
        {/* Said once for the section rather than per row. These pairs are a
            model's judgement, and a reader following one to another outlet
            should know that is what picked it. */}
        <span className={styles.note}>matched automatically</span>
      </h3>

      <ul className={styles.list}>
        {items.map(item => (
          <li key={item.url} className={styles.item}>
            {/* A new tab, always: this leaves the app for somebody else's site,
                and the reader is part-way through an article here. */}
            <a
              className={styles.link}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.title}
            </a>
            <span className={styles.meta}>
              <span className={styles.host}>{hostLabel(item.host)}</span>
              {item.reason && (
                <>
                  <span className={styles.dot}>·</span>
                  <span className={styles.reason}>{item.reason}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
