import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './SitePage.module.css';
import { apiGet, apiErrorText } from '../services/api';
import { SiteOverview, SiteArticle, ReadingListItem } from '../types';
import { faviconUrl } from '../utils/color';
import { relTime } from '../utils/notifications';
import { threadPathFor } from '../utils/articleUrl';
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from '../components/LayoutSwitch';

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

export type SiteLayout = 'list' | 'cards' | 'magazine';

const LAYOUT_OPTIONS = [
  { value: 'list' as const,     title: 'List',     icon: <ListIcon /> },
  { value: 'cards' as const,    title: 'Cards',    icon: <CardsIcon /> },
  { value: 'magazine' as const, title: 'Magazine', icon: <MagazineIcon /> },
];

interface Props {
  domain: string;
  navigate: (to: string) => void;
  /** Open an article's reader (and its comment thread) over the shell. */
  onOpenThread: (url: string) => void;
  /** How the two lists below draw themselves. Its own setting rather than the
   *  feed's: this page is one publisher, and a river you skim and a back
   *  catalogue you browse don't want the same shape. */
  layout?: SiteLayout;
  onLayoutChange?: (layout: SiteLayout) => void;
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

// One article, flattened. Both lists on this page - what the feed brought and
// what you kept - are the same handful of fields once you stop caring which
// table they came out of, and the three layouts below only ever wanted this.
// Keeping the shapes apart would have meant writing every layout twice.
interface Entry {
  key: string;
  title: string;
  /** The publisher's copy. */
  href: string;
  snippet: string | null;
  imageUrl: string | null;
  meta: string[];
  /** The reader, over the shell - the other destination every row offers. */
  threadHref: string;
  unread: boolean;
}

function feedEntry(a: SiteArticle): Entry {
  return {
    key: a.id,
    title: a.title,
    href: a.link,
    snippet: a.snippet,
    imageUrl: a.imageUrl,
    meta: [
      a.pubDate ? relTime(a.pubDate) : '',
      readTimeLabel(a.readTime),
      a.dismissed ? 'dismissed' : '',
    ].filter(Boolean),
    threadHref: threadPathFor(a.link),
    unread: !a.read,
  };
}

function savedEntry(item: ReadingListItem): Entry {
  return {
    key: item.id,
    title: item.title || hostOf(item.url),
    href: item.url,
    snippet: null,
    imageUrl: item.imageUrl || null,
    meta: [
      relTime(item.savedAt),
      item.readTime,
      // A reading-list item and one filed on a shelf are different states, and
      // flattening them would leave you unable to tell what you'd already dealt
      // with.
      item.inLibrary ? 'in your saved articles' : 'on your reading list',
    ].filter(Boolean),
    threadHref: threadPathFor(item.url),
    unread: false,
  };
}

// Magazine variants. Deliberately thinner than the feed's: a site page is one
// publisher, so there is no mix of sources to break up and the only thing worth
// varying is which pieces get to be big. The first article with art leads, the
// rest fall back to whether they have a picture at all.
type MagVariant = 'feature' | 'standard' | 'text';

function magazineVariants(entries: Entry[]): MagVariant[] {
  let led = false;
  return entries.map(e => {
    if (!e.imageUrl) return 'text';
    if (!led) { led = true; return 'feature'; }
    return 'standard';
  });
}

export default function SitePage({ domain, navigate, onOpenThread, onFollowSite, layout = 'list', onLayoutChange }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [site, setSite] = useState<SiteOverview | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeError, setSubscribeError] = useState('');

  const feedEntries = useMemo(() => (site?.articles ?? []).map(feedEntry), [site]);
  const savedEntries = useMemo(() => (site?.saved ?? []).map(savedEntry), [site]);

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

  const loadMore = useCallback(async () => {
    if (!site || !site.hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await apiGet<SiteOverview>(
        `/api/v1/sites/${encodeURIComponent(domain)}?offset=${site.articles.length}`,
      );
      setSite(prev => {
        if (!prev) return next;
        return {
          ...prev,
          articles: [...prev.articles, ...next.articles],
          // A page that came back empty ends the list whatever the server says
          // about `hasMore`. Without this an empty-but-hasMore answer would be
          // an infinite loop now that the sentinel below fetches by itself:
          // nothing is appended, the offset never moves, and it asks again.
          hasMore: next.articles.length > 0 && next.hasMore,
        };
      });
    } catch { /* leave what's on screen */ }
    setLoadingMore(false);
  }, [site, loadingMore, domain]);

  // Load the next page when the end of the list comes into view. The button
  // below stays as the manual fallback (and as the thing that says there *is*
  // more) - the same arrangement the feed river uses.
  //
  // Paging was reachable only from that button before, and the button sits
  // between the two sections rather than at the foot of the page, so on a site
  // with anything saved from it the bottom of the page was the saved list and
  // the way to see more articles was somewhere up above it.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !site?.hasMore || loadingMore) return;
    if (!('IntersectionObserver' in window)) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) loadMore();
    }, { rootMargin: '400px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [site?.hasMore, loadingMore, loadMore]);

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
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>From the feed</h2>
            {/* One switch for the page, parked on whichever section comes
                first. Two of them - one per list - would be two controls that
                have to agree about the same thing. */}
            {onLayoutChange && (
              <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Site layout" />
            )}
          </div>
          <EntryList entries={feedEntries} layout={layout} onOpenThread={onOpenThread} />
          <div ref={sentinelRef} aria-hidden />
          {/* How much of the site you are actually looking at. The page has
              always printed a total in the stats above, so a list that stopped
              at twenty with nothing to explain it read as the total being
              wrong rather than the list being one page of it. */}
          <div className={styles.moreMeta}>
            Showing {site.articles.length} of {counts.articles} article{counts.articles === 1 ? '' : 's'}
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
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>You saved</h2>
            {onLayoutChange && site.articles.length === 0 && (
              <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Site layout" />
            )}
          </div>
          <EntryList entries={savedEntries} layout={layout} onOpenThread={onOpenThread} />
        </section>
      )}
    </div>
  );
}

// The three shapes. They differ in what they draw around a title, not in what
// they know: a row, a card with its cover, or an editorial grid where the lead
// piece gets the width.
function EntryList({ entries, layout, onOpenThread }: {
  entries: Entry[];
  layout: SiteLayout;
  onOpenThread: (url: string) => void;
}) {
  const variants = useMemo(
    () => (layout === 'magazine' ? magazineVariants(entries) : null),
    [layout, entries],
  );

  if (layout === 'list') {
    return (
      <div className={styles.list}>
        {entries.map(e => <EntryRow key={e.key} entry={e} onOpenThread={onOpenThread} />)}
      </div>
    );
  }

  return (
    <div className={layout === 'magazine' ? styles.gridMagazine : styles.gridCards}>
      {entries.map((e, i) => (
        <EntryCard
          key={e.key}
          entry={e}
          variant={variants?.[i]}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  );
}

// One article, as a row: the default, because this is a list of one publisher's
// output, where the covers would all be the same shape and the titles are the
// only thing that distinguishes one line from the next.
//
// The title opens the source, and a second link opens the reader - the same
// split every card in the app makes, for the same reason: the story is at the
// publisher, the conversation is here.
function EntryRow({ entry, onOpenThread }: { entry: Entry; onOpenThread: (url: string) => void }) {
  return (
    <div className={`${styles.row} ${entry.unread ? styles.rowUnread : ''}`}>
      <a className={styles.rowTitle} href={entry.href} target="_blank" rel="noopener noreferrer">
        {entry.title}
      </a>
      {entry.snippet && <p className={styles.rowSnippet}>{entry.snippet}</p>}
      <EntryMeta entry={entry} onOpenThread={onOpenThread} />
    </div>
  );
}

// The card the other two layouts are made of. `variant` is only set in
// magazine - in cards every tile is the same size, which is the point of it.
function EntryCard({ entry, variant, onOpenThread }: {
  entry: Entry;
  variant?: MagVariant;
  onOpenThread: (url: string) => void;
}) {
  const showImage = !!entry.imageUrl && variant !== 'text';
  const cls = [
    styles.card,
    entry.unread ? styles.cardUnread : '',
    variant === 'feature' ? styles.cardFeature : '',
    variant === 'text' ? styles.cardText : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      {showImage && (
        /* Out of the tab order on purpose: it leads exactly where the title two
           lines below does, and a second link with no text of its own is noise
           to anyone not using a mouse. */
        <a
          className={styles.cardHero}
          href={entry.href}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={-1}
          aria-hidden="true"
        >
          <img
            src={entry.imageUrl!}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={e => { const img = e.currentTarget; (img.parentElement ?? img).style.display = 'none'; }}
          />
        </a>
      )}
      <div className={styles.cardBody}>
        <a className={styles.cardTitle} href={entry.href} target="_blank" rel="noopener noreferrer">
          {entry.title}
        </a>
        {entry.snippet && <p className={styles.cardSnippet}>{entry.snippet}</p>}
        <EntryMeta entry={entry} onOpenThread={onOpenThread} />
      </div>
    </div>
  );
}

// Shared by all three layouts so the dates, the read time and the way into the
// reader can't drift apart between them.
function EntryMeta({ entry, onOpenThread }: { entry: Entry; onOpenThread: (url: string) => void }) {
  return (
    <div className={styles.rowMeta}>
      {entry.meta.map((m, i) => (
        <span key={m}>{i > 0 && <span className={styles.dot}>·</span>}{m}</span>
      ))}
      <a
        className={styles.rowRead}
        href={entry.threadHref}
        onClick={e => { e.preventDefault(); onOpenThread(entry.href); }}
      >
        Read here
      </a>
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
