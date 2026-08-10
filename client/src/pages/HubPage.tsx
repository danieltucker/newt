import { useState, useEffect } from 'react';
import { apiGet } from '../services/api';
import { BlogPostSummary } from '../types';
import { relTime } from '../utils/notifications';
import { blogPathFor } from '../utils/blogUrl';
import { profilePathFor } from '../utils/profileUrl';
import { tagPathFor, RECENT_PATH } from '../utils/hubUrl';
import PostTags from '../components/PostTags';
import styles from './HubPage.module.css';

// The two cross-author pages: /t/<tag> and /recent.
//
// One component for both because they are the same page - a heading and a list
// of posts by people you may not follow - and the differences are a title, an
// endpoint and a subtitle. Two files would have been two places to fix the card.
//
// Both are also server-rendered for crawlers, in server/src/routes/html.ts. That
// copy and this one have to agree about *which* posts appear, which is why both
// read the same tagPostsWhere / eligibleAuthorIds on the server rather than each
// applying their own filter: a page where a visitor and Google see different
// lists is the definition of cloaking, however innocently it happens.

type HubKind = { kind: 'tag'; tag: string } | { kind: 'recent' };

interface Props {
  hub: HubKind;
  /** Sign-in state only changes the footer link; the content is the same either way. */
  signedIn: boolean;
  navigate: (to: string) => void;
}

interface TagResponse {
  tag: string;
  total: number;
  page: number;
  hasMore: boolean;
  posts: BlogPostSummary[];
}

export default function HubPage({ hub, signedIn, navigate }: Props) {
  const [posts, setPosts] = useState<BlogPostSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const endpoint = hub.kind === 'tag'
    ? `/api/v1/blogs/tags/${encodeURIComponent(hub.tag)}/posts`
    : '/api/v1/blogs/recent';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    apiGet<TagResponse | { posts: BlogPostSummary[] }>(endpoint)
      .then(d => {
        if (cancelled) return;
        setPosts(d.posts);
        setTotal('total' in d ? d.total : d.posts.length);
      })
      .catch(() => { if (!cancelled) { setPosts([]); setFailed(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint]);

  const heading = hub.kind === 'tag' ? `#${hub.tag}` : 'Recent posts';
  const subtitle = hub.kind === 'tag'
    ? (total === null ? '' : `${total} ${total === 1 ? 'post' : 'posts'}`)
    : 'The latest public posts written on Newt.';

  // A tag is followable in the app's own reader, which is most of what makes it
  // a place rather than a label. Only for tags - "recent" is not a feed anyone
  // should subscribe to, and there is no route serving one.
  const feedUrl = hub.kind === 'tag' ? `${tagPathFor(hub.tag)}/feed.xml` : null;

  function go(to: string) {
    return (e: React.MouseEvent) => {
      // Left-click only, and never with a modifier: cmd/ctrl-click and
      // middle-click must keep opening a new tab, which is the whole reason
      // these are real anchors rather than buttons.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    };
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" onClick={go('/')}>Newt</a>
        <nav className={styles.nav}>
          <a href={RECENT_PATH} onClick={go(RECENT_PATH)}>Recent</a>
          {signedIn
            ? <a href="/" onClick={go('/')}>Your tab</a>
            : <a href="/signup" onClick={go('/signup')}>Sign up</a>}
        </nav>
      </header>

      <main className={styles.main}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{heading}</h1>
          {feedUrl && (
            // A plain link, not a router navigation: this address is served by
            // the server as XML and is meant to be copied into a reader.
            <a className={styles.feedLink} href={feedUrl}>RSS</a>
          )}
        </div>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}

        {loading && <p className={styles.centered}>Loading…</p>}

        {!loading && failed && (
          <p className={styles.centered}>Couldn’t load these posts. Try again in a moment.</p>
        )}

        {!loading && !failed && posts.length === 0 && (
          <p className={styles.centered}>
            {hub.kind === 'tag'
              ? 'No posts carry this tag yet.'
              : 'Nothing here yet.'}
          </p>
        )}

        <ul className={styles.list}>
          {posts.map(post => {
            const author = post.author;
            const href = author ? blogPathFor(author.username, post.slug) : '#';
            return (
              <li key={post.id} className={styles.card}>
                {post.heroImage && (
                  <a href={href} onClick={go(href)} className={styles.heroLink} tabIndex={-1} aria-hidden>
                    <img className={styles.hero} src={post.heroImage} alt="" loading="lazy" />
                  </a>
                )}
                <h2 className={styles.postTitle}>
                  <a href={href} onClick={go(href)}>{post.title}</a>
                </h2>
                {post.excerpt && <p className={styles.excerpt}>{post.excerpt}</p>}
                <p className={styles.byline}>
                  {author && (
                    <a
                      className={styles.author}
                      href={profilePathFor(author.username)}
                      onClick={go(profilePathFor(author.username))}
                    >
                      {author.displayName}
                    </a>
                  )}
                  <span className={styles.dot} aria-hidden>·</span>
                  <time dateTime={post.publishedAt}>{relTime(post.publishedAt)}</time>
                </p>
                <PostTags
                  tags={post.tags}
                  className={styles.tags}
                  active={hub.kind === 'tag' ? hub.tag : undefined}
                  onSelect={tag => navigate(tagPathFor(tag))}
                />
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
