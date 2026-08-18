import { ReactNode, useEffect, useRef, useState } from 'react';
import { apiGet } from '../services/api';
import { CommentPrefs } from '../types';
import { faviconUrl } from '../utils/color';
import { articlePathFor } from '../utils/articleUrl';
import { articleEmbed } from '../utils/noteEmbed';
import { startRepost } from '../utils/composerSeed';
import CommentsPanel from './CommentsPanel';
import PersonaArticleActions from './PersonaArticleActions';
import ExploredPaths from './ExploredPaths';
import CloseButton from './CloseButton';
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
  /**
   * Caller-supplied controls (Save, Dismiss, Archive…) - each list owns its own
   * verbs. They render in the action bar at the foot of the article, beside
   * Repost and above the comments, not in the toolbar.
   */
  actions?: ReactNode;
  /**
   * Opens an Explore thread about this article. Undefined when the account has
   * no model connected, which is how the button stays absent rather than
   * appearing and then failing.
   */
  onExplore?: (url: string, title: string) => void;
  onClose: () => void;
  onViewProfile?: (username: string) => void;
  // Logged-out reader: comments are read-only (view a public thread, can't post).
  readOnly?: boolean;
  // Opened from one particular comment (a card on a profile): the thread scrolls
  // to it and flashes it rather than leaving the reader at the top of the page.
  focusCommentId?: string | null;
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
  prefs, onCountChange, legacyNote, onLegacyNoteMigrated, actions, onExplore, onClose, onViewProfile, readOnly,
  focusCommentId,
}: Props) {
  const [article, setArticle] = useState<DetailArticle | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped to remount the comment thread after a persona comments from the
  // admin row. See the `key` on CommentsPanel below.
  const [threadKey, setThreadKey] = useState(0);
  // A lead image that 404s drops out of the layout entirely rather than being
  // hidden in place: it is wrapped in a link now, and an image hidden inside a
  // link leaves the link behind as an invisible clickable gap above the title.
  const [heroFailed, setHeroFailed] = useState(false);

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
  const domain = domainOf(url);
  // A shared link opens with no metadata of its own - the reader is given the
  // URL and nothing else - so when the URL isn't a stored feed item there is no
  // title to show. Falling back to the domain keeps the headline (and the link
  // on it) from rendering as an empty, unclickable line. Only once the lookup
  // has settled: during it the real title may still be on its way.
  const displayTitle = article?.title || title || (loading ? '' : domain);
  const displaySource = article?.source || source || '';
  const favicon = domain ? faviconUrl(domain) : '';
  const dateText = longDate(article?.pubDate ?? pubDate);
  const readText = article?.readTime != null
    ? `${article.readTime} min read`
    : (readTime || '');

  // The stored article can arrive with a different image than the card opened
  // with, and the new one deserves its own chance to load.
  useEffect(() => { setHeroFailed(false); }, [heroImage]);

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
            <CloseButton onClick={onClose} />
          </div>
        </header>

        <div className={styles.scroll}>
          <article className={styles.article}>
            {/* The image and the headline are the two things a reader arriving
                on a shared link reaches for when they want the piece itself,
                and until now neither did anything: the only route to the
                source was "Open original" up in the toolbar, which is chrome,
                and chrome is the part people scroll past. Both now go where
                the toolbar button goes. */}
            {heroImage && !heroFailed && (
              <a
                className={styles.heroLink}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                /* Not the title: the headline below is a link to the same place
                   and already reads it out, and hearing it twice is worse than
                   hearing what this one is. */
                aria-label={`Read this at ${domain || 'the source'}`}
              >
                <img
                  className={styles.hero}
                  src={heroImage}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={() => setHeroFailed(true)}
                />
              </a>
            )}

            {cats.length > 0 && (
              <div className={styles.cats}>
                {cats.slice(0, 6).map(c => <span key={c} className={styles.cat}>{c}</span>)}
              </div>
            )}

            {/* Only linked once there is something to read out - during the
                lookup a shared link has no title yet, and an anchor with no
                text is a link with no name. */}
            <h1 className={styles.title}>
              {displayTitle && (
                <a className={styles.titleLink} href={url} target="_blank" rel="noopener noreferrer">
                  {displayTitle}
                </a>
              )}
            </h1>

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

          {/* What to *do* with the article sits at its foot, not up in the
              chrome. Saving and reposting are things you decide once you've
              read the thing, and the toolbar put them at the top of a page you
              were about to scroll away from - next to a Close button, which is
              the one neighbour a save should never have. Down here they share a
              row with the conversation, which is the other thing you do when
              you've finished reading. */}
          {(actions || !readOnly) && (
            <div className={styles.actionBar}>
              {actions}
              {/* Reposting writes a post as this reader, so it needs an account -
                  the same reason the comment composer is read-only signed out.
                  It carries whatever the reader resolved rather than what the
                  card was opened with, so the card quotes the better title. */}
              {!readOnly && (
                <button
                  type="button"
                  className={styles.repostBtn}
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
              {/* Sits beside Repost because it is the same kind of decision:
                  something you do *after* reading, to take the article further.
                  Absent entirely when no model is connected — an AI button that
                  only ever opens a settings screen is an advert, not a feature. */}
              {!readOnly && onExplore && (
                <button
                  type="button"
                  className={styles.repostBtn}
                  title="Go deeper on this article with your model"
                  onClick={() => onExplore(url, displayTitle)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
                  </svg>
                  Explore
                </button>
              )}
            </div>
          )}

          {/* Admin only, and self-hiding: it draws nothing unless the viewer has
              personas to summon. Its own row under the action bar rather than a
              pill inside it — see PersonaArticleActions.module.css. */}
          {!readOnly && (
            <div className={styles.actionBar}>
              <PersonaArticleActions
                url={url}
                title={displayTitle}
                onCommented={() => setThreadKey(k => k + 1)}
              />
            </div>
          )}

          {/* Between the article and the conversation about it, which is where
              it belongs: these are things somebody made *from* the piece, so
              they follow the piece - and they are not comments, so they do not
              belong inside the thread. Draws nothing when there are none.

              Wrapped because every section in this scroller states the column
              it sits in; see .pathsWrap. The wrapper is gutters only, so an
              article with no paths still costs nothing. */}
          <div className={styles.pathsWrap}>
            <ExploredPaths articleUrl={url} />
          </div>

          <div className={styles.commentsWrap}>
            <CommentsPanel
              // Bumped when a persona comments from the row above, which remounts
              // the thread so the new comment appears. A remount rather than a
              // callback into the panel because the panel owns its fetching and
              // there is nothing to preserve: the composer is closed at the
              // moment an admin uses that control.
              key={threadKey}
              articleUrl={url}
              articleTitle={displayTitle}
              prefs={prefs}
              onCountChange={onCountChange}
              legacyNote={legacyNote}
              onLegacyNoteMigrated={onLegacyNoteMigrated}
              onViewProfile={onViewProfile}
              readOnly={readOnly}
              focusCommentId={focusCommentId}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
