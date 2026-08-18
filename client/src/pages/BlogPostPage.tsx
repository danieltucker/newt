import { ReactNode, useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { postEmbed } from '../utils/noteEmbed';
import { BlogPost, CommentPrefs } from '../types';
import { profilePathFor } from '../utils/profileUrl';
import { blogEditPathFor } from '../utils/blogUrl';
import { tagPathFor } from '../utils/hubUrl';
import { startRepost } from '../utils/composerSeed';
import { POST_VIS_META } from '../components/VisibilityMeta';
import PostBody from '../components/PostBody';
import PostTags from '../components/PostTags';
import Lightbox, { LightboxImage } from '../components/Lightbox';
import CommentsPanel from '../components/CommentsPanel';
import FollowBlogButton from '../components/FollowBlogButton';
import PersonaBadge from '../components/PersonaBadge';
import ReportModal from '../components/ReportModal';
import SiteFooter from '../components/SiteFooter';
import styles from './BlogPostPage.module.css';

// A single blog post at /u/<username>/<slug>. Public posts open for logged-out
// visitors, the same way a shared /a/<id> article link does; anything narrower
// is resolved server-side per viewer and answers 404 when it isn't theirs to
// read (so the page can't be used to discover that a draft exists).
//
// The comment thread hangs off post.url - the same canonical key the server
// stored - so a comment left here and one left on the post's card in an RSS
// folder are the same conversation.

interface Props {
  username: string;
  slug: string;
  accessToken: string | null;
  navigate: (to: string) => void;
  // Rendered inside the app shell (NewTabPage) rather than as its own page -
  // see ShellView. Drops the full-height background and the "← Newt" bar,
  // which the shell already provides.
  embedded?: boolean;
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

// Standalone, this page owns the viewport; embedded, the shell already supplies
// the background and padding, so only the centred column remains.
// The footer rides along here rather than in the body: this runs for the
// loading and error states too, and every one of them is a page that ends.
// Embedded, the shell already has a footer of its own further down.
function Shell({ embedded, children }: { embedded?: boolean; children: ReactNode }) {
  const inner = <div className={styles.wrap}>{children}</div>;
  return embedded ? inner : (
    <div className={styles.page}>
      {inner}
      <SiteFooter />
    </div>
  );
}

export default function BlogPostPage({ username, slug, accessToken, navigate, embedded }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [post, setPost] = useState<BlogPost | null>(null);
  const [reporting, setReporting] = useState(false);
  // The cover only. Images inside the body are PostBody's own business.
  const [zoomedHero, setZoomedHero] = useState<LightboxImage | null>(null);

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
    return () => { document.title = 'Newt'; };
  }, [post]);

  if (state === 'loading') {
    return <Shell embedded={embedded}><div className={styles.centered}>Loading…</div></Shell>;
  }
  if (state !== 'ready' || !post) {
    const missing = state === 'notfound';
    return (
      <Shell embedded={embedded}>
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
      </Shell>
    );
  }

  const author = post.author;
  const vis = POST_VIS_META[post.visibility];

  return (
    <Shell embedded={embedded}>
      <div className={styles.topbar}>
        {/* The shell supplies its own way back, so this is the standalone
            page's only exit. */}
        {!embedded && (
          <button className={styles.backBtn} onClick={() => navigate('/')}>
            {accessToken ? '← Newt' : '← Sign in'}
          </button>
        )}
        {post.isSelf && (
          <button className={styles.ghostBtn} onClick={() => navigate(blogEditPathFor(post.id))}>
            Edit post
          </button>
        )}
        {/* A reader who landed straight on a post is the one most likely to
            want the author's feed, so the subscribe control lives here too -
            not only on the profile. Signed-in non-authors only: following
            writes to the viewer's own folders. */}
        {!post.isSelf && accessToken && author && (
          <FollowBlogButton username={author.username} variant="primary" />
        )}
        {/* Quoting a post into one of your own. Signed-in non-authors only:
            it writes to the viewer's blog, and reposting yourself is what
            editing the original is for. */}
        {!post.isSelf && accessToken && (
          <button
            className={styles.ghostBtn}
            title="Write a post quoting this one"
            onClick={() => startRepost({
              title: post.title,
              embed: postEmbed({
                url: post.url,
                title: post.title,
                slug: post.slug,
                heroImage: post.heroImage,
                publishedAt: post.publishedAt,
                excerpt: post.excerpt,
                author,
              }),
            })}
          >
            Repost
          </button>
        )}
        {/* Reporting needs an account to attribute the report to, so it is
            offered only to signed-in readers of somebody else's post. */}
        {!post.isSelf && accessToken && (
          <button className={styles.reportBtn} onClick={() => setReporting(true)}>
            Report
          </button>
        )}
      </div>

      <article className={styles.article}>
        {/* Server-validated to a site-relative /api/v1/images/<id> path, so
            this can never point off-origin - see normalizeHeroImage.

            Opens full size like any image in the body, and with more reason
            than most: the banner is a 2:1 crop, so some of what the author
            chose is not on screen at all until you open it. */}
        {post.heroImage && (
          <img
            className={styles.hero}
            src={post.heroImage}
            alt=""
            role="button"
            tabIndex={0}
            aria-label="View cover image full size"
            onClick={() => setZoomedHero({ src: post.heroImage })}
            onKeyDown={e => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              setZoomedHero({ src: post.heroImage });
            }}
          />
        )}

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
          {/* Outside the author button, not inside it: the badge is a statement
              about the account, not part of the link to it. */}
          {author?.isPersona && <PersonaBadge />}
          <span className={styles.dot}>·</span>
          <span className={styles.date}>{longDate(post.publishedAt)}</span>
          {/* Only worth showing when it isn't the default - a public post
              needs no badge saying so. */}
          {post.visibility !== 'public' && (
            <span className={styles.chip} title={vis.hint}>{vis.tag}</span>
          )}
        </div>

        {/* Under the byline, above the piece: a reader wants to know what this
            is about before reading it, not after.

            They lead to /t/<tag> - everyone's posts under that word - rather
            than to this author's, which is where they used to go. A tag reads as
            a subject, and a subject is a bigger place than one person's archive;
            the narrower view still exists on the author's profile (see
            profilePathFor's ?tag=), reached from there rather than from here.
            This is also the destination the crawlable copy of this page emits,
            and the two must not disagree. */}
        <PostTags
          tags={post.tags}
          className={styles.tags}
          onSelect={tag => navigate(tagPathFor(tag))}
        />

        <PostBody html={post.body} />
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

      <Lightbox image={zoomedHero} onClose={() => setZoomedHero(null)} />

      {reporting && (
        <ReportModal
          targetType="blogPost"
          targetId={post.id}
          subjectName={author?.displayName ?? 'this author'}
          onClose={() => setReporting(false)}
        />
      )}
    </Shell>
  );
}
