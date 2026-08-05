import { useCallback, useEffect, useState } from 'react';
import styles from './SitePage.module.css';
import { apiGet, apiErrorText } from '../services/api';
import { SiteOverview, SiteArticle, ReadingListItem } from '../types';
import { faviconUrl } from '../utils/color';
import { relTime } from '../utils/notifications';
import { threadPathFor } from '../utils/articleUrl';

// One publisher, gathered up. Reached from any byline in the app: the domain
// printed on a feed card, the source on a reading-list card, a bookmark tile.
//
// The feed is deliberately one river and the reading list is sorted by when you
// saved things, which between them meant "what has this site been publishing,
// and what have I kept from it" was a question no surface could answer. This is
// that surface, and the domain is the key because it is the only identifier a
// subscription, a bookmark and a saved article all already carry.
//
// It renders inside the app shell (see NewTabPage's ShellView) - the rail, the
// search bar and the consoles all stay where they are.

interface Props {
  domain: string;
  navigate: (to: string) => void;
  /** Open an article's reader (and its comment thread) over the shell. */
  onOpenThread: (url: string) => void;
  /**
   * Subscribe to this site's feed. Goes through the shell rather than being
   * posted from here, because the shell holds the subscription list the feed
   * panel, the manager and the category filter all read - a POST made behind
   * its back leaves every one of them a feed short until the next reload.
   * Resolves when the subscription exists; rejects with a message to show.
   */
  onFollowSite: (siteUrl: string) => Promise<void>;
}

type LoadState = 'loading' | 'ready' | 'error';

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function readTimeLabel(mins: number | null | undefined): string {
  if (!mins) return '';
  return mins === 1 ? '1 min read' : `${mins} min read`;
}

export default function SitePage({ domain, navigate, onOpenThread, onFollowSite }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [site, setSite] = useState<SiteOverview | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeError, setSubscribeError] = useState('');

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const data = await apiGet<SiteOverview>(`/api/v1/sites/${encodeURIComponent(domain)}`);
      if (!signal.cancelled) { setSite(data); setState('ready'); }
    } catch {
      if (!signal.cancelled) setState('error');
    }
  }, [domain]);

  useEffect(() => {
    const signal = { cancelled: false };
    setState('loading');
    setSite(null);
    setSubscribeError('');
    load(signal);
    return () => { signal.cancelled = true; };
  }, [load]);

  useEffect(() => {
    if (site) document.title = `${site.name} · Newt`;
    return () => { document.title = 'Newt'; };
  }, [site]);

  async function loadMore() {
    if (!site || !site.hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await apiGet<SiteOverview>(
        `/api/v1/sites/${encodeURIComponent(domain)}?offset=${site.articles.length}`,
      );
      setSite(prev => (prev
        ? { ...prev, articles: [...prev.articles, ...next.articles], hasMore: next.hasMore }
        : next));
    } catch { /* leave what's on screen */ }
    setLoadingMore(false);
  }

  // Subscribing from here is the point of showing the site to someone who isn't
  // subscribed: the page has just told them what the feed would bring. The URL
  // handed over is the site's front page - the server does its own discovery, so
  // it doesn't need to be a feed address.
  async function subscribe() {
    if (!site) return;
    setSubscribing(true);
    setSubscribeError('');
    try {
      await onFollowSite(site.homeUrl);
      // Re-read rather than patch: following a site is what turns this page
      // from "nothing here" into a list of articles, and the server has just
      // fetched the feed to answer the POST.
      await load({ cancelled: false });
    } catch (err) {
      setSubscribeError(apiErrorText(err, 'Couldn’t find a feed for this site'));
    } finally {
      setSubscribing(false);
    }
  }

  if (state === 'loading') return <div className={styles.centered}>Loading…</div>;
  if (state === 'error' || !site) {
    return (
      <div className={styles.centered}>
        <div className={styles.big}>Couldn’t load {domain}</div>
        <button className={styles.ghostBtn} onClick={() => navigate('/')}>Go home</button>
      </div>
    );
  }

  const { counts } = site;
  const nothingHere = site.articles.length === 0 && site.saved.length === 0;

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <img
          className={styles.favicon}
          src={faviconUrl(site.domain)}
          alt=""
          onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
        />
        <div className={styles.identity}>
          <h1 className={styles.name}>{site.name}</h1>
          <a
            className={styles.domain}
            href={site.homeUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`Visit ${site.domain}`}
          >
            {site.domain}
            <ExternalIcon />
          </a>
        </div>

        <div className={styles.headerActions}>
          <a className={styles.primaryBtn} href={site.homeUrl} target="_blank" rel="noopener noreferrer">
            Visit site
          </a>
          {site.subscriptions.length === 0 && (
            <button className={styles.ghostBtn} disabled={subscribing} onClick={subscribe}>
              {subscribing ? 'Looking for a feed…' : 'Follow this site'}
            </button>
          )}
        </div>
      </header>

      {subscribeError && <div className={styles.error}>{subscribeError}</div>}

      {/* Where this site already sits in the account: which feed category deals
          its articles, which bookmark folder holds its tile. Both are links back
          to the thing they name - this page is a junction, not a dead end. */}
      <div className={styles.badges}>
        {site.subscriptions.map(sub => (
          <span key={sub.id} className={styles.badge}>
            <FeedIcon />
            <span>Followed</span>
            {sub.folder && <span className={styles.badgeSub}>in {sub.folder.name}</span>}
            {sub.failing && <span className={styles.badgeWarn}>not loading</span>}
          </span>
        ))}
        {site.bookmark && (
          <span className={styles.badge}>
            <StarIcon />
            <span>Bookmarked</span>
            {site.bookmark.folder && (
              <span className={styles.badgeSub}>in {site.bookmark.folder.name}</span>
            )}
          </span>
        )}
      </div>

      <div className={styles.stats}>
        <span className={styles.stat}><b>{counts.articles}</b> article{counts.articles === 1 ? '' : 's'}</span>
        {counts.unread > 0 && <span className={styles.stat}><b>{counts.unread}</b> unread</span>}
        <span className={styles.stat}><b>{counts.saved}</b> on your reading list</span>
        {counts.library > 0 && <span className={styles.stat}><b>{counts.library}</b> saved</span>}
      </div>

      {nothingHere && (
        <div className={styles.centered}>
          <div className={styles.big}>Nothing from {site.domain} yet</div>
          <p className={styles.emptyHint}>
            You don’t follow this site and haven’t saved anything from it. Following it puts its
            articles in your feed.
          </p>
        </div>
      )}

      {site.articles.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>From the feed</h2>
          <div className={styles.list}>
            {site.articles.map(a => (
              <ArticleRow key={a.id} article={a} onOpenThread={onOpenThread} />
            ))}
          </div>
          {site.hasMore && (
            <button className={styles.moreBtn} disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}

      {site.saved.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>You saved</h2>
          <div className={styles.list}>
            {site.saved.map(item => (
              <SavedRow key={item.id} item={item} onOpenThread={onOpenThread} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// One article, as a row rather than a card: this is a list of one publisher's
// output, where the covers would all be the same shape and the titles are the
// only thing that distinguishes one line from the next.
//
// The title opens the source, and a second link opens the reader - the same
// split every card in the app makes, for the same reason: the story is at the
// publisher, the conversation is here.
function ArticleRow({ article, onOpenThread }: {
  article: SiteArticle;
  onOpenThread: (url: string) => void;
}) {
  const meta = [
    article.pubDate ? relTime(article.pubDate) : '',
    readTimeLabel(article.readTime),
    article.dismissed ? 'dismissed' : '',
  ].filter(Boolean);

  return (
    <div className={`${styles.row} ${article.read ? '' : styles.rowUnread}`}>
      <a className={styles.rowTitle} href={article.link} target="_blank" rel="noopener noreferrer">
        {article.title}
      </a>
      {article.snippet && <p className={styles.rowSnippet}>{article.snippet}</p>}
      <div className={styles.rowMeta}>
        {meta.map((m, i) => (
          <span key={m}>{i > 0 && <span className={styles.dot}>·</span>}{m}</span>
        ))}
        <a
          className={styles.rowRead}
          href={threadPathFor(article.link)}
          onClick={e => { e.preventDefault(); onOpenThread(article.link); }}
        >
          Read here
        </a>
      </div>
    </div>
  );
}

// A saved article. Same row, plus where it currently lives - a reading-list item
// and one filed on a Library shelf are different states and the page would be
// confusing if it flattened them.
function SavedRow({ item, onOpenThread }: {
  item: ReadingListItem;
  onOpenThread: (url: string) => void;
}) {
  const meta = [
    relTime(item.savedAt),
    item.readTime,
    item.inLibrary ? 'in your saved articles' : 'on your reading list',
  ].filter(Boolean);

  return (
    <div className={styles.row}>
      <a className={styles.rowTitle} href={item.url} target="_blank" rel="noopener noreferrer">
        {item.title || hostOf(item.url)}
      </a>
      <div className={styles.rowMeta}>
        {meta.map((m, i) => (
          <span key={m}>{i > 0 && <span className={styles.dot}>·</span>}{m}</span>
        ))}
        <a
          className={styles.rowRead}
          href={threadPathFor(item.url)}
          onClick={e => { e.preventDefault(); onOpenThread(item.url); }}
        >
          Read here
        </a>
      </div>
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function FeedIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M4 11a9 9 0 0 1 9 9" /><path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
    </svg>
  );
}
