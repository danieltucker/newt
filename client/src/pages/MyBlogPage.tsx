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
}

export default function MyBlogPage({ accessToken, username, navigate }: Props) {
  const { posts, loading, error, remove } = useMyPosts(accessToken);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleDelete(post: BlogPostSummary) {
    setBusyId(post.id);
    try {
      await remove(post.id);
    } catch { /* the row stays; the user can retry */ }
    setBusyId(null);
    setConfirming(null);
  }

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.topbar}>
          <button className={styles.backBtn} onClick={() => navigate('/')}>← New Tab</button>
        </div>

        <header className={styles.header}>
          <div>
            <h1 className={styles.heading}>My blog</h1>
            <p className={styles.sub}>
              {posts.length === 0 ? 'Nothing written yet.' : `${posts.length} post${posts.length === 1 ? '' : 's'}`}
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
              return (
                <div key={p.id} className={styles.row}>
                  <button className={styles.rowMain} onClick={() => navigate(blogEditPathFor(p.id))}>
                    <div className={styles.rowTop}>
                      <span className={styles.rowTitle}>{p.title}</span>
                      <span className={`${styles.chip} ${p.visibility === 'private' ? styles.chipDraft : ''}`}>
                        {vis.tag}
                      </span>
                      {!p.commentsEnabled && <span className={styles.mutedChip}>Comments off</span>}
                    </div>
                    {p.excerpt && <div className={styles.excerpt}>{p.excerpt}</div>}
                    <div className={styles.rowMeta}>{relTime(p.publishedAt)}</div>
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
    </div>
  );
}
