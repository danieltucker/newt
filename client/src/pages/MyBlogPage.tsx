import { useState } from 'react';
import { useMyPosts } from '../hooks/useBlog';
import { POST_VIS_META } from '../components/VisibilityMeta';
import { BlogPostSummary } from '../types';
import { blogPathFor, blogEditPathFor } from '../utils/blogUrl';
import { relTime } from '../utils/notifications';
import styles from './MyBlogPage.module.css';

// The author's own view of their blog: every post including drafts, newest
// first. Public listings live on the profile page instead.

interface Props {
  accessToken: string;
  username: string;
  navigate: (to: string) => void;
  // Rendered inside the app shell (NewTabPage) rather than as its own page -
  // see ShellView. Drops the full-height background and the "← New Tab" bar.
  embedded?: boolean;
}

export default function MyBlogPage({ accessToken, username, navigate, embedded }: Props) {
  const { posts, loading, error, remove } = useMyPosts(accessToken);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 'private' is the draft state - see POST_VIS_META.
  const drafts = posts.filter(p => p.visibility === 'private').length;
  const published = posts.length - drafts;

  async function handleDelete(post: BlogPostSummary) {
    setBusyId(post.id);
    try {
      await remove(post.id);
    } catch { /* the row stays; the user can retry */ }
    setBusyId(null);
    setConfirming(null);
  }

  const body = (
    <div className={styles.wrap}>
      {/* The shell has its own way back; this bar is the standalone page's. */}
      {!embedded && (
        <div className={styles.topbar}>
          <button className={styles.backBtn} onClick={() => navigate('/')}>← New Tab</button>
        </div>
      )}

      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>My posts</h1>
          <p className={styles.sub}>
            {posts.length === 0 ? 'Nothing written yet.' : (
              <>
                {published} published
                {/* Counted separately because this is the only page that shows
                    drafts at all - they are kept off the profile entirely. */}
                {drafts > 0 && (
                  <> · <span className={styles.subDraft}>{drafts} draft{drafts === 1 ? '' : 's'}</span></>
                )}
              </>
            )}
          </p>
        </div>
        <button className={styles.primaryBtn} onClick={() => navigate('/blog/new')}>New post</button>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <div className={styles.centered}>Loading…</div>
      ) : posts.length === 0 ? (
        <div className={styles.centered}>
          <div className={styles.big}>Write your first post</div>
          <p className={styles.hint}>
            Posts start as drafts that only you can read. Publish when you’re ready.
          </p>
          <button className={styles.primaryBtn} onClick={() => navigate('/blog/new')}>New post</button>
        </div>
      ) : (
        <div className={styles.list}>
          {posts.map(p => {
            const vis = POST_VIS_META[p.visibility];
            const isDraft = p.visibility === 'private';
            return (
              <div key={p.id} className={`${styles.row} ${isDraft ? styles.rowDraft : ''}`}>
                {p.heroImage && <img className={styles.rowThumb} src={p.heroImage} alt="" />}
                <button className={styles.rowMain} onClick={() => navigate(blogEditPathFor(p.id))}>
                  <div className={styles.rowTop}>
                    <span className={styles.rowTitle}>{p.title}</span>
                    {/* A draft is the one state worth spotting from across the
                        list: it is the reason this page exists, and it is the
                        only thing here that nobody else can see. It gets the
                        icon, the amber and the row's dashed edge; the published
                        tiers stay quiet. */}
                    <span className={`${styles.chip} ${isDraft ? styles.chipDraft : ''}`}>
                      {isDraft && vis.icon}
                      {vis.tag}
                    </span>
                    {!p.commentsEnabled && <span className={styles.mutedChip}>Comments off</span>}
                  </div>
                  {p.excerpt && <div className={styles.excerpt}>{p.excerpt}</div>}
                  <div className={styles.rowMeta}>
                    {isDraft
                      ? <>Not published · edited {relTime(p.updatedAt)}</>
                      : relTime(p.publishedAt)}
                  </div>
                </button>

                <div className={styles.rowActions}>
                  {p.visibility !== 'private' && (
                    <button
                      className={styles.ghostBtn}
                      onClick={() => navigate(blogPathFor(username, p.slug))}
                    >
                      View
                    </button>
                  )}
                  {confirming === p.id ? (
                    <>
                      <button
                        className={styles.dangerBtn}
                        disabled={busyId === p.id}
                        onClick={() => handleDelete(p)}
                      >
                        {busyId === p.id ? 'Deleting…' : 'Confirm'}
                      </button>
                      <button className={styles.ghostBtn} onClick={() => setConfirming(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className={styles.ghostBtn} onClick={() => setConfirming(p.id)}>Delete</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return embedded ? body : <div className={styles.page}>{body}</div>;
}
