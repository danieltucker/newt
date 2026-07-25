import { useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { BlogPost, CommentPrefs } from '../types';
import { profilePathFor } from '../utils/profileUrl';
import { blogEditPathFor } from '../utils/blogUrl';
import { POST_VIS_META } from '../components/VisibilityMeta';
import CommentsPanel from '../components/CommentsPanel';
import styles from './BlogPostPage.module.css';

// A single blog post at /u/<username>/<slug>. Public posts open for logged-out
// visitors, the same way a shared /a/<id> article link does; anything narrower
// is resolved server-side per viewer and answers 404 when it isn't theirs to
// read (so the page can't be used to discover that a draft exists).
//
// The comment thread hangs off post.url — the same canonical key the server
// stored — so a comment left here and one left on the post's card in an RSS
// folder are the same conversation.

interface Props {
  username: string;
  slug: string;
  accessToken: string | null;
  navigate: (to: string) => void;
}

type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

// Anonymous defaults, matching PublicArticlePage: show public comments, newest
// first. Signed-in viewers get their real prefs from the app shell instead.
const ANON_PREFS: CommentPrefs = {
  showPublic: true,
  defaultVisibility: 'public',
  sort: 'newest',
  autoExpand: true,
};

function longDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' });
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export default function BlogPostPage({ username, slug, accessToken, navigate }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [post, setPost] = useState<BlogPost | null>(null);

  // Refetch when auth changes: signing in can reveal a friends-only post that
  // 404'd a moment ago.
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setPost(null);
    apiFetch(`/api/v1/blogs/${encodeURIComponent(username)}/post/${encodeURIComponent(slug)}`)
      .then(async res => {
        if (cancelled) return;
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        setPost(await res.json());
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [username, slug, accessToken]);

  useEffect(() => {
    if (post) document.title = post.title;
    return () => { document.title = 'New Tab'; };
  }, [post]);

  if (state === 'loading') {
    return <div className={styles.page}><div className={styles.centered}>Loading…</div></div>;
  }
  if (state !== 'ready' || !post) {
    const missing = state === 'notfound';
    return (
      <div className={styles.page}>
        <div className={styles.centered}>
          <div className={styles.big}>
            {missing ? 'This post isn’t available' : 'Couldn’t load this post'}
          </div>
          {missing && !accessToken && (
            <p className={styles.hint}>It may be private, or shared only with the author’s friends.</p>
          )}
          <button className={styles.ghostBtn} onClick={() => navigate('/')}>
            {accessToken ? 'Go home' : 'Sign in'}
          </button>
        </div>
      </div>
    );
  }

  const author = post.author;
  const vis = POST_VIS_META[post.visibility];

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.topbar}>
          <button className={styles.backBtn} onClick={() => navigate('/')}>
            {accessToken ? '← New Tab' : '← Sign in'}
          </button>
          {post.isSelf && (
            <button className={styles.ghostBtn} onClick={() => navigate(blogEditPathFor(post.id))}>
              Edit post
            </button>
          )}
        </div>

        <article className={styles.article}>
          <h1 className={styles.title}>{post.title}</h1>

          <div className={styles.byline}>
            {author && (
              <button
                className={styles.authorBtn}
                onClick={() => navigate(profilePathFor(author.username))}
              >
                {author.avatar
                  ? <img className={styles.avatar} src={author.avatar} alt="" />
                  : <span className={styles.avatarFallback}>{initialOf(author.displayName)}</span>}
                <span className={styles.authorName}>{author.displayName}</span>
              </button>
            )}
            <span className={styles.dot}>·</span>
            <span className={styles.date}>{longDate(post.publishedAt)}</span>
            {/* Only worth showing when it isn't the default — a public post
                needs no badge saying so. */}
            {post.visibility !== 'public' && (
              <span className={styles.chip} title={vis.hint}>{vis.tag}</span>
            )}
          </div>

          {/* Sanitized server-side on write — see sanitizeBlogHtml */}
          <div className={styles.body} dangerouslySetInnerHTML={{ __html: post.body }} />
        </article>

        {post.commentsEnabled ? (
          <div className={styles.commentsWrap}>
            <CommentsPanel
              articleUrl={post.url}
              articleTitle={post.title}
              prefs={ANON_PREFS}
              readOnly={!accessToken}
              onViewProfile={name => navigate(profilePathFor(name))}
            />
          </div>
        ) : (
          <div className={styles.commentsOff}>Comments are turned off for this post.</div>
        )}
      </div>
    </div>
  );
}
