import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
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
import SiteFooter from '../components/SiteFooter';
import FollowBlogButton from '../components/FollowBlogButton';
import FriendsPanel from '../components/FriendsPanel';
import LibraryPanel from '../components/LibraryPanel';
import ReportModal from '../components/ReportModal';
import { useBlocks } from '../hooks/useBlocks';
import { useReadingList, ReadingListBinding } from '../hooks/useReadingList';
import { coverStyle } from '../utils/coverGradient';

interface Props {
  username: string;
  accessToken: string | null;
  currentUsername: string | null;
  navigate: (to: string) => void;
  // Rendered inside the app shell (NewTabPage) rather than as its own page.
  // Drops the full-height background and the "← New Tab" bar, because the shell
  // already supplies both - the header, search and consoles stay on screen.
  embedded?: boolean;
  // Embedded in the app shell, the shell already owns the reading list - take
  // its copy rather than opening a second one that drifts from it. Standalone,
  // this is absent and the Library tab provisions its own.
  library?: ReadingListBinding;
  /** Open an article the way the shell does. Standalone falls back to a tab. */
  onOpenArticle?: (url: string) => void;
  /** Raw ?tab= value from the URL. Unrecognised values fall back to Content. */
  initialTab?: string | null;
}

// Content is the landing tab: what this person has created or shared, posts and
// shared comments together - which is what a profile is for. 'friends' and
// 'library' are self-only: both are scoped to the authed user, so there is no
// such thing as someone else's to show. The Library in particular is private by
// design - it is never fetched for another user, not merely hidden.
type Tab = 'content' | 'posts' | 'comments' | 'friends' | 'library' | 'history';
type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

const TABS: Tab[] = ['content', 'posts', 'comments', 'friends', 'library', 'history'];

// A ?tab= value is whatever was in the URL, so it is checked against the real
// list rather than cast. Self-only tabs need no special case here: the button
// and the panel are both already gated on isSelf, so landing on ?tab=library
// for someone else's profile just shows Content.
function tabFromParam(raw: string | null | undefined): Tab {
  return TABS.includes(raw as Tab) ? (raw as Tab) : 'content';
}

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

// Standalone, this page owns the viewport: full-height background and its own
// padding. Embedded in the app shell, all of that is already on screen, so only
// the centred column remains.
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

export default function ProfilePage({ username, accessToken, currentUsername, navigate, embedded, library, onOpenArticle, initialTab }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [profile, setProfile] = useState<ProfileUser | null>(null);
  const [tab, setTab] = useState<Tab>(() => tabFromParam(initialTab));

  // Following a ?tab= link while already on a profile changes the prop but not
  // the mounted state, so the tab has to follow it.
  useEffect(() => { setTab(tabFromParam(initialTab)); }, [initialTab, username]);

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
    return <Shell embedded={embedded}><div className={styles.centered}>Loading…</div></Shell>;
  }
  if (state === 'notfound') {
    return (
      <Shell embedded={embedded}>
        <div className={styles.centered}>
          <div className={styles.big}>This profile doesn’t exist</div>
          <button className={styles.ghostBtn} onClick={() => navigate('/')}>Go home</button>
        </div>
      </Shell>
    );
  }
  if (state === 'error' || !profile) {
    return (
      <Shell embedded={embedded}>
        <div className={styles.centered}>
          <div className={styles.big}>Couldn’t load this profile</div>
          <button className={styles.ghostBtn} onClick={() => navigate('/')}>Go home</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell embedded={embedded}>
      {/* The shell has its own way back (the logo, the search bar, the whole
          new tab underneath), so this bar is only for the standalone page. */}
      {!embedded && (
        <div className={styles.topbar}>
          <button className={styles.backBtn} onClick={() => navigate('/')}>
            {accessToken ? '← New Tab' : '← Sign in'}
          </button>
        </div>
      )}

      <ProfileHeader
        profile={profile}
        accessToken={accessToken}
        navigate={navigate}
        onRelationChange={rel => setProfile(p => (p ? { ...p, relation: rel } : p))}
        onBlockedChange={blocked => setProfile(p => (p ? { ...p, blocked, relation: 'none' } : p))}
      />

      {/* A profile you blocked is a stub: identity, and the way back. Loading
          the tabs would be pointless - every content endpoint answers empty for
          this pair - and it would read as if the block hadn't taken. */}
      {profile.blocked ? (
        <div className={styles.centered}>
          <div className={styles.big}>You blocked @{profile.username}</div>
          <p className={styles.blockedExplainer}>
            You can’t see each other’s posts or comments, and neither of you can send the other a
            friend request. Unblock them to undo this - your old friendship isn’t restored.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.tabs} role="tablist">
            <button role="tab" aria-selected={tab === 'content'}
              className={`${styles.tab} ${tab === 'content' ? styles.tabActive : ''}`}
              onClick={() => setTab('content')}>
              Content
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
            {/* Self-only - see the Tab type */}
            {profile.isSelf && (
              <button role="tab" aria-selected={tab === 'friends'}
                className={`${styles.tab} ${tab === 'friends' ? styles.tabActive : ''}`}
                onClick={() => setTab('friends')}>
                Friends
              </button>
            )}
            {profile.isSelf && (
              <button role="tab" aria-selected={tab === 'library'}
                className={`${styles.tab} ${tab === 'library' ? styles.tabActive : ''}`}
                onClick={() => setTab('library')}>
                Library
              </button>
            )}
            <button role="tab" aria-selected={tab === 'history'}
              className={`${styles.tab} ${tab === 'history' ? styles.tabActive : ''}`}
              onClick={() => setTab('history')}>
              History
            </button>
          </div>

          {tab === 'content' && (
            <ContentTab username={profile.username} authKey={accessToken}
              onOpenArticle={goArticle} onOpenPost={goPost} />
          )}
          {tab === 'posts' && (
            <PostsTab username={profile.username} authKey={accessToken} onOpen={goPost} />
          )}
          {tab === 'comments' && (
            <CommentsTab username={profile.username} authKey={accessToken} onOpen={goArticle} />
          )}
          {tab === 'friends' && profile.isSelf && (
            <FriendsPanel
              accessToken={accessToken}
              onViewProfile={name => navigate(profilePathFor(name))}
            />
          )}
          {tab === 'library' && profile.isSelf && (
            <LibraryTab
              accessToken={accessToken}
              binding={library}
              onOpenArticle={onOpenArticle ?? (url => window.open(url, '_blank', 'noopener,noreferrer'))}
            />
          )}
          {tab === 'history' && (
            <HistoryTab username={profile.username} authKey={accessToken} onOpen={goArticle} />
          )}
        </>
      )}
    </Shell>
  );
}

// ── Library tab ───────────────────────────────────────────────────────────────
// Takes the shell's reading list when embedded so a Restore here shows up on the
// New Tab page immediately. Standalone there is no shell, so it loads its own.
function LibraryTab({ accessToken, binding, onOpenArticle }: {
  accessToken: string | null;
  binding?: ReadingListBinding;
  onOpenArticle: (url: string) => void;
}) {
  // Hooks can't be called conditionally, so the fallback always runs - passing
  // a null token when a binding exists keeps it from firing a duplicate fetch.
  const own = useReadingList(binding ? null : accessToken);
  const list = binding ?? own;

  return (
    <LibraryPanel
      items={list.items}
      accessToken={accessToken}
      onMoveToFolder={list.moveToFolder}
      onRestore={id => list.setInLibrary(id, false)}
      onDelete={list.removeItem}
      onFoldersDeleted={list.clearFolder}
      onOpenArticle={onOpenArticle}
    />
  );
}

// ── Header ────────────────────────────────────────────────────────────────
function ProfileHeader({ profile, accessToken, navigate, onRelationChange, onBlockedChange }: {
  profile: ProfileUser;
  accessToken: string | null;
  navigate: (to: string) => void;
  onRelationChange: (rel: FriendRelation) => void;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [feedCopied, setFeedCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [reporting, setReporting] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const { block, unblock } = useBlocks(accessToken);

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

  async function doBlock() {
    setBusy(true); setErr(''); setConfirmingBlock(false);
    const res = await block(profile.username);
    if (res.ok) onBlockedChange(true);
    else setErr(res.error ?? 'Couldn’t block this person');
    setBusy(false);
  }

  async function doUnblock() {
    setBusy(true); setErr('');
    const res = await unblock(profile.id);
    if (res.ok) onBlockedChange(false);
    else setErr(res.error ?? 'Couldn’t unblock this person');
    setBusy(false);
  }

  return (
    <div className={styles.header}>
      {/* A cover strip, tinted from the profile's own accent seed so two
          profiles don't look like the same page with a different name on it. */}
      <div className={styles.cover} style={coverStyle(profile.username)} aria-hidden />

      <div className={styles.headerBody}>
        <div className={styles.avatarSlot}>
          <Avatar user={profile} />
        </div>

        <div className={styles.identityRow}>
          <div className={styles.identity}>
            <div className={styles.displayName}>{profile.displayName}</div>
            <div className={styles.handleRow}>
              <span className={styles.handle}>@{profile.username}</span>
              {profile.isSelf && <span className={styles.youTag}>You</span>}
              {!profile.isSelf && relationTag(profile.relation, accessToken) && (
                <span className={styles.relTag}>{relationTag(profile.relation, accessToken)}</span>
              )}
            </div>
          </div>

          {/* One primary action, everything else behind the overflow - the
              stacked column of four equal-weight buttons was the ugly part. */}
          <div className={styles.actions}>
            {profile.isSelf ? (
              <button className={styles.primaryBtn} onClick={() => navigate('/blog')}>My blog</button>
            ) : profile.blocked ? (
              // The only action left on a stub profile, and the reason the stub
              // exists at all rather than a 404.
              <button className={styles.primaryBtn} disabled={busy} onClick={doUnblock}>
                {busy ? 'Unblocking…' : 'Unblock'}
              </button>
            ) : accessToken ? (
              <>
                <FollowBlogButton username={profile.username} />
                {profile.relation === 'none' && (
                  <button className={styles.primaryBtn} disabled={busy} onClick={addFriend}>
                    Add friend
                  </button>
                )}
              </>
            ) : (
              <button className={styles.primaryBtn} onClick={() => navigate('/')}>Sign in to add</button>
            )}

            <OverflowMenu
              copied={copied}
              feedCopied={feedCopied}
              onCopyLink={copyLink}
              onCopyFeed={copyFeed}
              // Safety actions belong only on someone else's live profile, and
              // only for a signed-in viewer: there is nobody to report to, and
              // no account to hang a block on, otherwise.
              canModerate={!profile.isSelf && !profile.blocked && !!accessToken}
              onReport={() => setReporting(true)}
              onBlock={() => setConfirmingBlock(true)}
            />
          </div>
        </div>

        <div className={styles.stats}>
          <span className={styles.stat}>
            <b>{profile.postCount}</b> post{profile.postCount === 1 ? '' : 's'}
          </span>
          <span className={styles.stat}>
            <b>{profile.commentCount}</b> comment{profile.commentCount === 1 ? '' : 's'}
          </span>
          <span className={styles.stat}>since {memberSince(profile.createdAt)}</span>
        </div>

        {/* Blocking tears down a friendship and hides both people from each
            other, so it asks once - inline rather than in a window.confirm,
            which gives no room to say what it actually does. */}
        {confirmingBlock && (
          <div className={styles.confirmBar} role="alertdialog" aria-label={`Block @${profile.username}`}>
            <span className={styles.confirmText}>
              Block @{profile.username}? You’ll stop seeing each other entirely, and any friendship
              between you ends. They aren’t told.
            </span>
            <button className={styles.dangerBtn} disabled={busy} onClick={doBlock}>
              {busy ? 'Blocking…' : 'Block'}
            </button>
            <button className={styles.ghostBtn} onClick={() => setConfirmingBlock(false)}>Cancel</button>
          </div>
        )}

        {err && <div className={styles.error}>{err}</div>}
      </div>

      {reporting && (
        <ReportModal
          targetType="user"
          targetId={profile.id}
          subjectName={`@${profile.username}`}
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  );
}

// The relation between you and this person, as a short tag beside their handle.
// Returns null when there's nothing to say (no relation, or you're signed out).
function relationTag(relation: FriendRelation, accessToken: string | null): string | null {
  if (!accessToken) return null;
  switch (relation) {
    case 'friends': return 'Friends';
    case 'outgoing': return 'Requested';
    case 'incoming': return 'Wants to add you';
    default: return null;
  }
}

// Secondary actions - the ones you reach for once, not every visit. Report and
// Block sit at the bottom behind a divider: reached deliberately, never by a
// slip of the mouse aimed at Copy link.
function OverflowMenu({ copied, feedCopied, onCopyLink, onCopyFeed, canModerate, onReport, onBlock }: {
  copied: boolean;
  feedCopied: boolean;
  onCopyLink: () => void;
  onCopyFeed: () => void;
  canModerate: boolean;
  onReport: () => void;
  onBlock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.overflowWrap} ref={wrapRef}>
      <button
        className={styles.overflowBtn}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div className={styles.overflowMenu} role="menu">
          <button role="menuitem" className={styles.overflowItem} onClick={onCopyLink}>
            {copied ? 'Copied!' : 'Copy link'}
          </button>
          {/* The blog's RSS URL, for any reader - not just this app */}
          <button role="menuitem" className={styles.overflowItem} onClick={onCopyFeed}>
            {feedCopied ? 'Copied!' : 'Copy RSS'}
          </button>
          {canModerate && (
            <>
              <div className={styles.overflowDivider} role="separator" />
              <button
                role="menuitem"
                className={styles.overflowItem}
                onClick={() => { setOpen(false); onReport(); }}
              >
                Report this account
              </button>
              <button
                role="menuitem"
                className={`${styles.overflowItem} ${styles.overflowDanger}`}
                onClick={() => { setOpen(false); onBlock(); }}
              >
                Block
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── One post, as a card ──────────────────────────────────────────────────────
function PostCard({ post, onOpen }: { post: BlogPostSummary; onOpen: (slug: string) => void }) {
  return (
    <button className={styles.postCard} onClick={() => onOpen(post.slug)}>
      {post.heroImage && <img className={styles.postHero} src={post.heroImage} alt="" />}
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

// ── Content tab ──────────────────────────────────────────────────────────────
// The profile's main page: everything this person made or shared - blog posts
// and shared comments - in one timeline. The API route is still /activity.
function ContentTab({ username, authKey, onOpenArticle, onOpenPost }: {
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
      <div className={`${styles.commentBody} note-embed-read`} dangerouslySetInnerHTML={{ __html: c.body }} />
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
