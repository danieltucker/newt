import { useCallback, useEffect, useState } from 'react';
import styles from './ProfilePage.module.css';
import { apiFetch, apiGet, apiPost } from '../services/api';
import {
  ProfileUser, ProfileComment, ProfileArticle, FriendRelation,
  BlogPostSummary, ProfileActivityItem,
} from '../types';
import { relTime } from '../utils/notifications';
import { articlePathFor } from '../utils/articleUrl';
import { profilePathFor } from '../utils/profileUrl';
import { blogPathFor } from '../utils/blogUrl';
import { POST_VIS_META } from '../components/VisibilityMeta';

interface Props {
  username: string;
  accessToken: string | null;
  currentUsername: string | null;
  navigate: (to: string) => void;
}

// Activity is the landing tab: what this person has put out, posts and shared
// comments together — which is what a profile is for.
type Tab = 'activity' | 'posts' | 'comments' | 'history';
type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function memberSince(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en', { month: 'long', year: 'numeric' });
}

function Avatar({ user }: { user: Pick<ProfileUser, 'avatar' | 'displayName'> }) {
  if (user.avatar) return <img className={styles.avatar} src={user.avatar} alt="" />;
  return <span className={styles.avatarFallback}>{initialOf(user.displayName)}</span>;
}

export default function ProfilePage({ username, accessToken, currentUsername, navigate }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [profile, setProfile] = useState<ProfileUser | null>(null);
  const [tab, setTab] = useState<Tab>('activity');

  // Load the profile header. Re-runs if the viewer's auth changes (a friend logging
  // in should reveal friends-only content and the relation control).
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setProfile(null);
    apiFetch(`/api/v1/profiles/${encodeURIComponent(username)}`)
      .then(async res => {
        if (cancelled) return;
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) { setState('error'); return; }
        const data: ProfileUser = await res.json();
        setProfile(data);
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [username, accessToken]);

  useEffect(() => {
    if (profile) document.title = `${profile.displayName} · Profile`;
    return () => { document.title = 'New Tab'; };
  }, [profile]);

  const goArticle = useCallback((url: string) => navigate(articlePathFor(url)), [navigate]);
  const goPost = useCallback(
    (slug: string) => navigate(blogPathFor(username, slug)),
    [navigate, username],
  );

  if (state === 'loading') {
    return <div className={styles.page}><div className={styles.centered}>Loading…</div></div>;
  }
  if (state === 'notfound') {
    return (
      <div className={styles.page}>
        <div className={styles.centered}>
          <div className={styles.big}>This profile doesn’t exist</div>
          <button className={styles.ghostBtn} onClick={() => navigate('/')}>Go home</button>
        </div>
      </div>
    );
  }
  if (state === 'error' || !profile) {
    return (
      <div className={styles.page}>
        <div className={styles.centered}>
          <div className={styles.big}>Couldn’t load this profile</div>
          <button className={styles.ghostBtn} onClick={() => navigate('/')}>Go home</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.topbar}>
          <button className={styles.backBtn} onClick={() => navigate('/')}>
            {accessToken ? '← New Tab' : '← Sign in'}
          </button>
        </div>

        <ProfileHeader
          profile={profile}
          accessToken={accessToken}
          navigate={navigate}
          onRelationChange={rel => setProfile(p => (p ? { ...p, relation: rel } : p))}
        />

        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'activity'}
            className={`${styles.tab} ${tab === 'activity' ? styles.tabActive : ''}`}
            onClick={() => setTab('activity')}>
            Activity
          </button>
          <button role="tab" aria-selected={tab === 'posts'}
            className={`${styles.tab} ${tab === 'posts' ? styles.tabActive : ''}`}
            onClick={() => setTab('posts')}>
            Posts{profile.postCount > 0 && <span className={styles.tabCount}>{profile.postCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'comments'}
            className={`${styles.tab} ${tab === 'comments' ? styles.tabActive : ''}`}
            onClick={() => setTab('comments')}>
            Comments{profile.commentCount > 0 && <span className={styles.tabCount}>{profile.commentCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'history'}
            className={`${styles.tab} ${tab === 'history' ? styles.tabActive : ''}`}
            onClick={() => setTab('history')}>
            History
          </button>
        </div>

        {tab === 'activity' && (
          <ActivityTab username={profile.username} authKey={accessToken}
            onOpenArticle={goArticle} onOpenPost={goPost} />
        )}
        {tab === 'posts' && (
          <PostsTab username={profile.username} authKey={accessToken} onOpen={goPost} />
        )}
        {tab === 'comments' && (
          <CommentsTab username={profile.username} authKey={accessToken} onOpen={goArticle} />
        )}
        {tab === 'history' && (
          <HistoryTab username={profile.username} authKey={accessToken} onOpen={goArticle} />
        )}
      </div>
    </div>
  );
}

// ── Header ────────────────────────────────────────────────────────────────
function ProfileHeader({ profile, accessToken, navigate, onRelationChange }: {
  profile: ProfileUser;
  accessToken: string | null;
  navigate: (to: string) => void;
  onRelationChange: (rel: FriendRelation) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [feedCopied, setFeedCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function copyLink() {
    const url = `${window.location.origin}${profilePathFor(profile.username)}`;
    navigator.clipboard?.writeText(url).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => {},
    );
  }

  function copyFeed() {
    navigator.clipboard?.writeText(profile.blogFeedUrl).then(
      () => { setFeedCopied(true); setTimeout(() => setFeedCopied(false), 1600); },
      () => {},
    );
  }

  async function addFriend() {
    setBusy(true); setErr('');
    try {
      const res = await apiPost<{ ok: boolean; accepted?: boolean }>('/api/v1/friends/requests', { username: profile.username });
      onRelationChange(res.accepted ? 'friends' : 'outgoing');
    } catch {
      setErr('Couldn’t send request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.header}>
      <Avatar user={profile} />
      <div className={styles.identity}>
        <div className={styles.displayName}>{profile.displayName}</div>
        <div className={styles.handle}>@{profile.username}</div>
        <div className={styles.meta}>
          Member since {memberSince(profile.createdAt)} · {profile.commentCount} comment{profile.commentCount === 1 ? '' : 's'}
        </div>
        {err && <div className={styles.error}>{err}</div>}
      </div>
      <div className={styles.actions}>
        <button className={styles.ghostBtn} onClick={copyLink}>{copied ? 'Copied!' : 'Copy link'}</button>
        {/* The blog's RSS URL, for any reader — not just this app */}
        <button className={styles.ghostBtn} onClick={copyFeed}>
          {feedCopied ? 'Copied!' : 'Copy RSS'}
        </button>
        {profile.isSelf && (
          <button className={styles.primaryBtn} onClick={() => navigate('/blog')}>My blog</button>
        )}
        {!profile.isSelf && accessToken && (
          <FollowButton username={profile.username} />
        )}
        {profile.isSelf && <span className={styles.statusTag}>This is you</span>}
        {!profile.isSelf && accessToken && (
          profile.relation === 'friends' ? <span className={styles.statusTag}>Friends</span>
          : profile.relation === 'outgoing' ? <span className={styles.statusTag}>Requested</span>
          : profile.relation === 'incoming' ? <span className={styles.statusTag}>Wants to add you</span>
          : <button className={styles.primaryBtn} disabled={busy} onClick={addFriend}>Add friend</button>
        )}
        {!profile.isSelf && !accessToken && (
          <button className={styles.primaryBtn} onClick={() => navigate('/')}>Sign in to add</button>
        )}
      </div>
    </div>
  );
}

// ── Follow ───────────────────────────────────────────────────────────────────
// Subscribing to someone's blog is "bookmarking their profile": the server adds
// their feed to a folder you choose (so their posts appear in that folder's
// article list) and creates a sidebar tile for them, with the unread badge any
// other site gets. Only public posts travel this way — friends-only posts are
// read here on the profile, or through your personal feed.
function FollowButton({ username }: { username: string }) {
  const [following, setFollowing] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiGet<{ following: boolean }>(`/api/v1/blogs/${encodeURIComponent(username)}/follow`)
      .then(d => { if (!cancelled) setFollowing(d.following); })
      .catch(() => { if (!cancelled) setFollowing(false); });
    return () => { cancelled = true; };
  }, [username]);

  async function openPicker() {
    setErr('');
    try {
      const list = await apiGet<{ id: string; name: string }[]>('/api/v1/folders');
      if (list.length === 0) { setErr('Make a folder first'); return; }
      // With one folder there is nothing to choose — just use it.
      if (list.length === 1) { await follow(list[0].id); return; }
      setFolders(list);
      setPicking(true);
    } catch {
      setErr('Couldn’t load folders');
    }
  }

  async function follow(folderId: string) {
    setBusy(true); setErr('');
    try {
      await apiPost(`/api/v1/blogs/${encodeURIComponent(username)}/follow`, { folderId });
      setFollowing(true);
      setPicking(false);
    } catch {
      setErr('Couldn’t follow');
    } finally {
      setBusy(false);
    }
  }

  async function unfollow() {
    setBusy(true); setErr('');
    try {
      await apiFetch(`/api/v1/blogs/${encodeURIComponent(username)}/follow`, { method: 'DELETE' });
      setFollowing(false);
    } catch {
      setErr('Couldn’t unfollow');
    } finally {
      setBusy(false);
    }
  }

  if (following === null) return null;

  return (
    <>
      {picking ? (
        <div className={styles.folderPick}>
          <span className={styles.folderPickLabel}>Add to folder</span>
          {folders.map(f => (
            <button key={f.id} className={styles.folderOption} disabled={busy}
              onClick={() => follow(f.id)}>
              {f.name}
            </button>
          ))}
          <button className={styles.ghostBtn} onClick={() => setPicking(false)}>Cancel</button>
        </div>
      ) : following ? (
        <button className={styles.ghostBtn} disabled={busy} onClick={unfollow}>
          Following ✓
        </button>
      ) : (
        <button className={styles.ghostBtn} disabled={busy} onClick={openPicker}>
          Follow blog
        </button>
      )}
      {err && <div className={styles.error}>{err}</div>}
    </>
  );
}

// ── One post, as a card ──────────────────────────────────────────────────────
function PostCard({ post, onOpen }: { post: BlogPostSummary; onOpen: (slug: string) => void }) {
  return (
    <button className={styles.postCard} onClick={() => onOpen(post.slug)}>
      <div className={styles.commentTop}>
        <span className={styles.kindTag}>Post</span>
        {post.visibility !== 'public' && (
          <span className={styles.chip}>{POST_VIS_META[post.visibility].tag}</span>
        )}
      </div>
      <div className={styles.postTitle}>{post.title}</div>
      {post.excerpt && <div className={styles.postExcerpt}>{post.excerpt}</div>}
      <div className={styles.commentTime}>{relTime(post.publishedAt)}</div>
    </button>
  );
}

// ── Activity tab ─────────────────────────────────────────────────────────────
// The profile's main page: blog posts and shared comments in one timeline.
function ActivityTab({ username, authKey, onOpenArticle, onOpenPost }: {
  username: string;
  authKey: string | null;
  onOpenArticle: (url: string) => void;
  onOpenPost: (slug: string) => void;
}) {
  const [items, setItems] = useState<ProfileActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ items: ProfileActivityItem[] }>(`/api/v1/profiles/${encodeURIComponent(username)}/activity`)
      .then(d => { if (!cancelled) setItems(d.items); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // authKey in deps: signing in can reveal friends-only content
  }, [username, authKey]);

  if (loading) return <div className={styles.centered}>Loading…</div>;
  if (items.length === 0) return <div className={styles.centered}>Nothing shared yet.</div>;

  return (
    <div className={styles.list}>
      {items.map(item => item.kind === 'post'
        ? <PostCard key={`p${item.post.id}`} post={item.post} onOpen={onOpenPost} />
        : <CommentCard key={`c${item.comment.id}`} comment={item.comment} onOpen={onOpenArticle} />)}
    </div>
  );
}

// ── Posts tab ────────────────────────────────────────────────────────────────
function PostsTab({ username, authKey, onOpen }: {
  username: string;
  authKey: string | null;
  onOpen: (slug: string) => void;
}) {
  const [posts, setPosts] = useState<BlogPostSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const base = `/api/v1/blogs/${encodeURIComponent(username)}/posts`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ posts: BlogPostSummary[]; nextCursor: string | null }>(base)
      .then(d => { if (!cancelled) { setPosts(d.posts); setCursor(d.nextCursor); } })
      .catch(() => { if (!cancelled) setPosts([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [base, authKey]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const d = await apiGet<{ posts: BlogPostSummary[]; nextCursor: string | null }>(
        `${base}?cursor=${encodeURIComponent(cursor)}`);
      setPosts(prev => [...prev, ...d.posts]);
      setCursor(d.nextCursor);
    } catch { /* leave as-is */ }
    setLoadingMore(false);
  }

  if (loading) return <div className={styles.centered}>Loading…</div>;
  if (posts.length === 0) return <div className={styles.centered}>No posts yet.</div>;

  return (
    <div className={styles.list}>
      {posts.map(p => <PostCard key={p.id} post={p} onOpen={onOpen} />)}
      {cursor && (
        <button className={styles.moreBtn} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ── One comment, as a card ───────────────────────────────────────────────────
function CommentCard({ comment: c, onOpen }: {
  comment: ProfileComment;
  onOpen: (url: string) => void;
}) {
  return (
    <button className={styles.commentCard} onClick={() => onOpen(c.articleUrl)}>
      <div className={styles.commentTop}>
        <span className={styles.articleTitle}>{c.articleTitle || hostOf(c.articleUrl)}</span>
        <span className={styles.dot}>·</span>
        <span className={styles.host}>{hostOf(c.articleUrl)}</span>
        {c.visibility === 'friends' && <span className={styles.chip}>Friends</span>}
      </div>
      {c.title && <div className={styles.commentTitle}>{c.title}</div>}
      <div className={styles.commentBody} dangerouslySetInnerHTML={{ __html: c.body }} />
      <div className={styles.commentTime}>{relTime(c.createdAt)}</div>
    </button>
  );
}

// ── Comments tab ────────────────────────────────────────────────────────────
function CommentsTab({ username, authKey, onOpen }: {
  username: string;
  authKey: string | null;
  onOpen: (url: string) => void;
}) {
  const [comments, setComments] = useState<ProfileComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const base = `/api/v1/profiles/${encodeURIComponent(username)}/comments`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ comments: ProfileComment[]; nextCursor: string | null }>(base)
      .then(d => { if (!cancelled) { setComments(d.comments); setCursor(d.nextCursor); } })
      .catch(() => { if (!cancelled) setComments([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // authKey in deps: refetch when the viewer's auth changes (reveals friends-only)
  }, [base, authKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const d = await apiGet<{ comments: ProfileComment[]; nextCursor: string | null }>(`${base}?cursor=${encodeURIComponent(cursor)}`);
      setComments(prev => [...prev, ...d.comments]);
      setCursor(d.nextCursor);
    } catch { /* leave as-is */ }
    setLoadingMore(false);
  }

  if (loading) return <div className={styles.centered}>Loading…</div>;
  if (comments.length === 0) return <div className={styles.centered}>No comments to show.</div>;

  return (
    <div className={styles.list}>
      {comments.map(c => <CommentCard key={c.id} comment={c} onOpen={onOpen} />)}
      {cursor && (
        <button className={styles.moreBtn} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ── History tab ──────────────────────────────────────────────────────────────
function HistoryTab({ username, authKey, onOpen }: {
  username: string;
  authKey: string | null;
  onOpen: (url: string) => void;
}) {
  const [articles, setArticles] = useState<ProfileArticle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ articles: ProfileArticle[] }>(`/api/v1/profiles/${encodeURIComponent(username)}/articles`)
      .then(d => { if (!cancelled) setArticles(d.articles); })
      .catch(() => { if (!cancelled) setArticles([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [username, authKey]);

  if (loading) return <div className={styles.centered}>Loading…</div>;
  if (articles.length === 0) return <div className={styles.centered}>No articles yet.</div>;

  return (
    <div className={styles.list}>
      {articles.map(a => (
        <button key={a.articleUrl} className={styles.historyRow} onClick={() => onOpen(a.articleUrl)}>
          <div className={styles.historyText}>
            <div className={styles.articleTitle}>{a.articleTitle || hostOf(a.articleUrl)}</div>
            <div className={styles.host}>{hostOf(a.articleUrl)}</div>
          </div>
          <div className={styles.historyMeta}>
            <span className={styles.countPill}>{a.commentCount} comment{a.commentCount === 1 ? '' : 's'}</span>
            <span className={styles.historyTime}>{relTime(a.lastCommentedAt)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
