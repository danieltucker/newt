import { ReactNode, useEffect, useRef, useState } from 'react';
import { apiGet } from '../services/api';
import { CommentPrefs } from '../types';
import { faviconUrl } from '../utils/color';
import { articlePathFor } from '../utils/articleUrl';
import { articleEmbed } from '../utils/noteEmbed';
import { startRepost } from '../utils/composerSeed';
import CommentsPanel from './CommentsPanel';
import styles from './ArticleDetailModal.module.css';

// The article reader. Opened from a card's comment strip, it shows the full
// text the feed shipped - images, categories and all - with the comment thread
// underneath, where there is finally room to read and write.
//
// Content is fetched by canonical URL rather than passed in, so a reading-list
// entry saved months ago resolves to the same stored article as the live feed
// card. When the URL isn't a stored feed item the modal still opens on the
// metadata it was given, so the comments always work.

interface DetailArticle {
  id: string;
  title: string;
  link: string;
  source: string;
  pubDate: string | null;
  readTime: number | null;
  snippet: string | null;
  content: string | null;
  imageUrl: string | null;
  categories: string[];
}

interface Props {
  url: string;
  title: string;
  source?: string;
  imageUrl?: string | null;
  categories?: string[];
  readTime?: string | null;
  pubDate?: string | null;
  prefs: CommentPrefs;
  onCountChange?: (url: string, next: number) => void;
  legacyNote?: string;
  onLegacyNoteMigrated?: () => void;
  /** Caller-supplied buttons (Save, Dismiss, Archive…) - each list owns its own verbs */
  actions?: ReactNode;
  onClose: () => void;
  onViewProfile?: (username: string) => void;
  // Logged-out reader: comments are read-only (view a public thread, can't post).
  readOnly?: boolean;
}

// History bookkeeping for the reader's /a/<id> URL. Module-level (only one reader
// is ever open at a time) so that React StrictMode's mount→unmount→mount probe in
// dev doesn't push/pop twice: the throwaway unmount schedules its cleanup on a
// timeout, and the immediate re-mount cancels it before it can run.
let readerActive = false;   // our /a/<id> entry is currently on the history stack
let readerPushed = false;   // we pushed it (vs. the page was opened *at* that URL)
let pendingHistoryCleanup: ReturnType<typeof setTimeout> | null = null;

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function ArticleDetailModal({
  url, title, source, imageUrl, categories, readTime, pubDate,
  prefs, onCountChange, legacyNote, onLegacyNoteMigrated, actions, onClose, onViewProfile, readOnly,
}: Props) {
  const [article, setArticle] = useState<DetailArticle | null>(null);
  const [loading, setLoading] = useState(true);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes; the page behind must not scroll while the reader is up
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Reflect the open article in the browser URL (/a/<id>) so it's shareable and
  // the back button closes the reader. We push an entry on open (unless we were
  // opened *from* that URL - a shared deep link) and undo it on close.
  useEffect(() => {
    const targetPath = articlePathFor(url);

    // A pending cleanup means this is a StrictMode re-mount - cancel it so we
    // don't tear down the history entry we're about to keep using.
    if (pendingHistoryCleanup !== null) {
      clearTimeout(pendingHistoryCleanup);
      pendingHistoryCleanup = null;
    }
    if (!readerActive) {
      readerActive = true;
      readerPushed = window.location.pathname !== targetPath;
      if (readerPushed) window.history.pushState({ articleReader: true }, '', targetPath);
    }

    const onPop = () => { readerActive = false; readerPushed = false; onCloseRef.current(); };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      pendingHistoryCleanup = setTimeout(() => {
        pendingHistoryCleanup = null;
        // Closed via UI (Escape/backdrop/close) while still on our URL - undo it.
        // Closed via Back navigation already moved us away, so this no-ops.
        if (readerActive && window.location.pathname === targetPath) {
          if (readerPushed) window.history.back();
          else window.history.replaceState(null, '', '/');
        }
        readerActive = false;
        readerPushed = false;
      }, 0);
    };
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ article: DetailArticle | null }>(`/api/v1/articles?url=${encodeURIComponent(url)}`)
      .then(d => { if (!cancelled) { setArticle(d.article); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url]);

  // Stored article wins where it has data; fall back to whatever the card knew
  const heroImage = article?.imageUrl ?? imageUrl ?? null;
  const cats = article?.categories?.length ? article.categories : (categories ?? []);
  const displayTitle = article?.title || title;
  const displaySource = article?.source || source || '';
  const domain = domainOf(url);
  const favicon = domain ? faviconUrl(domain) : '';
  const dateText = longDate(article?.pubDate ?? pubDate);
  const readText = article?.readTime != null
    ? `${article.readTime} min read`
    : (readTime || '');

  return (
    <div
      className={styles.backdrop}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={displayTitle}>
        <header className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            {favicon && (
              <img className={styles.toolbarFavicon} src={favicon} alt=""
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            )}
            <span className={styles.toolbarSource}>{displaySource || domain}</span>
          </div>
          <div className={styles.toolbarRight}>
            {actions}
            {/* Reposting writes a post as this reader, so it needs an account -
                the same reason the comment composer is read-only signed out.
                It carries whatever the reader resolved rather than what the
                card was opened with, so the card quotes the better title. */}
            {!readOnly && (
              <button
                title="Write a post quoting this article"
                onClick={() => startRepost({
                  title: displayTitle,
                  embed: articleEmbed({
                    url,
                    title: displayTitle,
                    source: displaySource || domain,
                    imageUrl: heroImage,
                    readTime: readText,
                  }),
                })}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
                Repost
              </button>
            )}
            <a
              className={styles.openBtn}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open original
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                strokeWidth="1.9" strokeLinecap="round">
                <path d="M1 1l10 10M11 1L1 11" />
              </svg>
            </button>
          </div>
        </header>

        <div className={styles.scroll}>
          <article className={styles.article}>
            {heroImage && (
              <img
                className={styles.hero}
                src={heroImage}
                alt=""
                referrerPolicy="no-referrer"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            )}

            {cats.length > 0 && (
              <div className={styles.cats}>
                {cats.slice(0, 6).map(c => <span key={c} className={styles.cat}>{c}</span>)}
              </div>
            )}

            <h1 className={styles.title}>{displayTitle}</h1>

            <div className={styles.meta}>
              {displaySource && <span>{displaySource}</span>}
              {dateText && <><span className={styles.metaDot}>·</span><span>{dateText}</span></>}
              {readText && <><span className={styles.metaDot}>·</span><span>{readText}</span></>}
            </div>

            {loading ? (
              <div className={styles.skeleton}>
                <span className={styles.skelLine} />
                <span className={styles.skelLine} />
                <span className={`${styles.skelLine} ${styles.skelShort}`} />
              </div>
            ) : article?.content ? (
              /* Sanitized server-side on ingest - see sanitizeFeedHtml */
              <div className={styles.prose} dangerouslySetInnerHTML={{ __html: article.content }} />
            ) : (
              <div className={styles.noContent}>
                {(article?.snippet || '') && <p className={styles.snippet}>{article?.snippet}</p>}
                <p className={styles.noContentHint}>
                  This feed doesn’t include the full article text.
                </p>
                <a className={styles.noContentBtn} href={url} target="_blank" rel="noopener noreferrer">
                  Read it at {domain || 'the source'}
                </a>
              </div>
            )}
          </article>

          <div className={styles.commentsWrap}>
            <CommentsPanel
              articleUrl={url}
              articleTitle={displayTitle}
              prefs={prefs}
              onCountChange={onCountChange}
              legacyNote={legacyNote}
              onLegacyNoteMigrated={onLegacyNoteMigrated}
              onViewProfile={onViewProfile}
              readOnly={readOnly}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
