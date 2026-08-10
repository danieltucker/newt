import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './ProfilePage.module.css';
import { apiFetch, apiGet, apiPost } from '../services/api';
import {
  ProfileUser, ProfileComment, FriendRelation, ProfileLink,
  BlogPost, BlogPostSummary, ProfileActivityItem,
} from '../types';
import { linkIcon, linkLabel } from '../utils/profileLinks';
import { relTime } from '../utils/notifications';
import { threadPathFor } from '../utils/articleUrl';
import { profilePathFor } from '../utils/profileUrl';
import { blogPathFor } from '../utils/blogUrl';
import { POST_VIS_META } from '../components/VisibilityMeta';
import PostBody from '../components/PostBody';
import PostTags from '../components/PostTags';
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
  // Drops the full-height background and the "← Newt" bar, because the shell
  // already supplies both - the header, search and consoles stay on screen.
  embedded?: boolean;
  // Embedded in the app shell, the shell already owns the reading list - take
  // its copy rather than opening a second one that drifts from it. Standalone,
  // this is absent and the Library tab provisions its own.
  library?: ReadingListBinding;
  /** Open an article the way the shell does. Standalone falls back to a tab. */
  onOpenArticle?: (url: string) => void;
  /**
   * Open an article's comment thread in the shell's reader, landing on one
   * comment. Supplied only when embedded: the shell owns that reader and, more
   * to the point, it is the only place a client-side navigation to /a/<id> is
   * *not* how you get there. Standalone this is absent and the cards navigate,
   * which is what a logged-out visitor on a shared profile link needs.
   */
  onOpenThread?: (url: string, commentId?: string) => void;
  /** Raw ?tab= value from the URL. Unrecognised values fall back to Posts. */
  initialTab?: string | null;
  /** Raw ?tag= value from the URL - narrows the Posts tab. A tag the author has
   *  never used simply matches nothing, which is the honest answer. */
  initialTag?: string | null;
  /** Open Settings on the Account section, where the photo, cover and links are
   *  edited. Absent standalone, where there is no settings panel to open - so the
   *  avatar's Edit affordance appears only inside the app shell. */
  onEditProfile?: () => void;
}

// Posts is the landing tab. 'history' is the merged stream - posts and shared
// comments together, newest first - and was called 'content' until the older
// comments-grouped-by-article tab that owned the name was dropped.
//
// 'friends' and 'library' are self-only: both are scoped to the authed user, so
// there is no such thing as someone else's to show. The Library in particular is
// private by design - it is never fetched for another user, not merely hidden.
type Tab = 'posts' | 'history' | 'comments' | 'friends' | 'library';
type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

const TABS: Tab[] = ['posts', 'history', 'comments', 'friends', 'library'];
const DEFAULT_TAB: Tab = 'posts';

// A ?tab= value is whatever was in the URL, so it is checked against the real
// list rather than cast. Self-only tabs need no special case here: the button
// and the panel are both already gated on isSelf, so landing on ?tab=library
// for someone else's profile just shows Posts.
//
// ?tab=content is accepted as an alias: it was this tab's name before the
// rename, so any link already saved keeps landing where it meant to.
function tabFromParam(raw: string | null | undefined): Tab {
  if (raw === 'content') return 'history';
  return TABS.includes(raw as Tab) ? (raw as Tab) : DEFAULT_TAB;
}

// Mirrors the server's normalizeTags for the single-tag case: a link may have
// been typed or copied with a '#', in any case, and it has to find the posts
// stored under the bare lowercase word. '' means no filter.
function normalizeTagParam(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^#+/, '').trim().toLowerCase();
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

export default function ProfilePage({ username, accessToken, currentUsername, navigate, embedded, library, onOpenArticle, onOpenThread, initialTab, initialTag, onEditProfile }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [profile, setProfile] = useState<ProfileUser | null>(null);
  const [tab, setTab] = useState<Tab>(() => tabFromParam(initialTab));
  // Normalised the way the server stores tags, so a link carrying "#News" and a
  // chip carrying "news" are the same filter. '' is "no filter", a real state.
  const [tag, setTag] = useState(() => normalizeTagParam(initialTag));
  // Bumped to re-run the header fetch without clearing what's on screen - see
  // the profile-updated listener below.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Following a ?tab= link while already on a profile changes the prop but not
  // the mounted state, so the tab has to follow it.
  useEffect(() => { setTab(tabFromParam(initialTab)); }, [initialTab, username]);
  useEffect(() => { setTag(normalizeTagParam(initialTag)); }, [initialTag, username]);

  // Picking a tag rewrites the URL rather than only the state, so the filtered
  // view is a place: shareable, and something the back button can leave.
  const selectTag = useCallback((next: string) => {
    setTag(next);
    setTab('posts');
    navigate(profilePathFor(username, { tag: next || undefined }));
  }, [navigate, username]);

  // A different profile is a different page: drop the old header rather than
  // showing it under the new name while the fetch below is in flight. Declared
  // ahead of that fetch so it has already cleared state by the time it runs.
  useEffect(() => { setProfile(null); setState('loading'); }, [username]);

  // Load the profile header. Re-runs if the viewer's auth changes (a friend logging
  // in should reveal friends-only content and the relation control).
  useEffect(() => {
    let cancelled = false;
    // Only the first load blanks the page. A refresh triggered by an edit keeps
    // the old header up until the new one lands, so saving a cover doesn't flash
    // the profile through "Loading…".
    setState(s => (s === 'ready' ? s : 'loading'));
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
  }, [username, accessToken, reloadNonce]);

  // Settings announces a saved account (photo, cover, links) on the window, the
  // way the article reader announces closing. Editing happens in a modal over
  // this page, so without this the profile underneath would keep showing the old
  // banner until something else navigated.
  useEffect(() => {
    function onUpdated() { setReloadNonce(n => n + 1); }
    window.addEventListener('profile-updated', onUpdated);
    return () => window.removeEventListener('profile-updated', onUpdated);
  }, []);

  useEffect(() => {
    if (profile) document.title = `${profile.displayName} · Profile`;
    return () => { document.title = 'Newt'; };
  }, [profile]);

  // A comment card leads to the conversation it came from - the article's
  // reader, scrolled to that comment. Inside the shell the reader is an overlay
  // the shell owns, so it is opened directly; standalone there is no shell and
  // /a/<id>?c=<comment> is a page of its own.
  const goComment = useCallback(
    (url: string, commentId: string) => {
      if (onOpenThread) onOpenThread(url, commentId);
      else navigate(threadPathFor(url, commentId));
    },
    [navigate, onOpenThread],
  );
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
            {accessToken ? '← Newt' : '← Sign in'}
          </button>
        </div>
      )}

      <ProfileHeader
        profile={profile}
        accessToken={accessToken}
        navigate={navigate}
        onEditProfile={onEditProfile}
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
          <ProfileTabs
            tabs={[
              { id: 'posts', label: 'Posts', count: profile.postCount },
              { id: 'history', label: 'History' },
              { id: 'comments', label: 'Comments', count: profile.commentCount },
              // Self-only - see the Tab type
              ...(profile.isSelf ? [
                { id: 'friends' as Tab, label: 'Friends' },
                // "Library" named a feature; this names what is in it. The
                // ?tab=library URL keeps the old id so saved links still work.
                { id: 'library' as Tab, label: 'Saved articles' },
              ] : []),
            ]}
            active={tab}
            onSelect={setTab}
          />

          {tab === 'posts' && (
            <PostsTab
              username={profile.username}
              authKey={accessToken}
              onOpen={goPost}
              tag={tag}
              onSelectTag={selectTag}
            />
          )}
          {tab === 'history' && (
            <HistoryTab username={profile.username} authKey={accessToken}
              onOpenComment={goComment} onOpenPost={goPost} />
          )}
          {tab === 'comments' && (
            <CommentsTab username={profile.username} authKey={accessToken} onOpen={goComment} />
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
        </>
      )}
    </Shell>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
// One bar under the row, and it moves. It rests under the selected tab in the
// accent colour; point at any other tab and it slides there and goes grey, which
// says "this is where you'd land" without pretending you have already landed.
// Letting go puts it back where it belongs.
//
// The bar is positioned rather than being each button's own border, because a
// border can't travel between two elements - measuring is what makes the
// movement possible at all.
interface TabSpec { id: Tab; label: string; count?: number }

function ProfileTabs({ tabs, active, onSelect }: {
  tabs: TabSpec[];
  active: Tab;
  onSelect: (t: Tab) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Tab | null>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);

  // Whichever tab the bar should currently be under: the one being pointed at,
  // or the selected one when nothing is.
  const target = preview ?? active;

  // Layout effect, not a plain one: the bar has to be measured and placed in the
  // same frame the row paints, or it starts at 0 and slides in from the left the
  // first time a profile loads.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    function measure() {
      const el = list?.querySelector<HTMLElement>(`[data-tab="${target}"]`);
      if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
    }
    measure();
    // The row wraps and re-measures on a narrow screen, and the counts arrive
    // after the first paint - both move the buttons under a bar already placed.
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [target, tabs.length]);

  return (
    <div
      className={styles.tabs}
      role="tablist"
      ref={listRef}
      onMouseLeave={() => setPreview(null)}
    >
      {tabs.map(t => (
        <button
          key={t.id}
          data-tab={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={`${styles.tab} ${active === t.id ? styles.tabActive : ''}`}
          onClick={() => onSelect(t.id)}
          onMouseEnter={() => setPreview(t.id)}
          // Keyboard parity: tabbing through the row moves the bar too.
          onFocus={() => setPreview(t.id)}
          onBlur={() => setPreview(null)}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className={styles.tabCount}>{t.count}</span>
          )}
        </button>
      ))}
      {bar && (
        <span
          className={`${styles.tabBar} ${target === active ? '' : styles.tabBarPreview}`}
          style={{ left: bar.left, width: bar.width }}
          aria-hidden
        />
      )}
    </div>
  );
}

// ── Library tab ───────────────────────────────────────────────────────────────
// Takes the shell's reading list when embedded so a Restore here shows up on the
// new tab page immediately. Standalone there is no shell, so it loads its own.
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

// The row of small site marks under the handle - Bluesky, GitHub, a personal
// site. Icons are favicons taken from each link's own host (see linkIcon), so
// any site works and nothing here needs updating when one rebrands; a host with
// no favicon falls back to its first letter rather than a broken image.
function ProfileLinks({ links }: { links: ProfileLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className={styles.links}>
      {links.map(link => (
        <ProfileLinkChip key={link.url} link={link} />
      ))}
    </div>
  );
}

function ProfileLinkChip({ link }: { link: ProfileLink }) {
  const [failed, setFailed] = useState(false);
  const label = linkLabel(link);
  const icon = linkIcon(link);
  return (
    <a
      className={styles.linkChip}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} - ${link.url}`}
      aria-label={label}
    >
      {icon && !failed
        ? <img className={styles.linkIcon} src={icon} alt="" onError={() => setFailed(true)} />
        : <span className={styles.linkInitial} aria-hidden>{label.charAt(0).toUpperCase()}</span>}
    </a>
  );
}

// ── Header ────────────────────────────────────────────────────────────────
function ProfileHeader({ profile, accessToken, navigate, onEditProfile, onRelationChange, onBlockedChange }: {
  profile: ProfileUser;
  accessToken: string | null;
  navigate: (to: string) => void;
  onEditProfile?: () => void;
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

  // Only the owner gets the Edit affordance, and only where there is a settings
  // panel to open - standalone (a logged-out visitor on a shared link) there
  // isn't one, so the prop is absent and the avatar is a plain image.
  const canEdit = profile.isSelf && !!onEditProfile;

  return (
    <div className={styles.header}>
      {/* The cover runs from the top of the card down to the top of the display
          name, with the avatar standing on it. It is an uploaded image if the
          owner set one, otherwise a gradient they picked, otherwise one tinted
          from their own accent seed - so two profiles never look like the same
          page with a different name on it. */}
      <div
        className={styles.cover}
        style={coverStyle(profile.username, profile.coverTheme, profile.coverImage)}
      >
        <div className={styles.coverScrim} aria-hidden />
        <div className={styles.avatarSlot}>
          {canEdit ? (
            <button
              type="button"
              className={styles.avatarEdit}
              onClick={onEditProfile}
              title="Edit your photo, cover and links"
            >
              <Avatar user={profile} />
              <span className={styles.avatarEditVeil} aria-hidden>Edit</span>
              <span className={styles.srOnly}>Edit your photo, cover and links</span>
            </button>
          ) : (
            <Avatar user={profile} />
          )}
        </div>
      </div>

      <div className={styles.headerBody}>
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
            <ProfileLinks links={profile.profileLinks} />
          </div>

          {/* One primary action, everything else behind the overflow - the
              stacked column of four equal-weight buttons was the ugly part. */}
          <div className={styles.actions}>
            {profile.isSelf ? (
              <button className={styles.primaryBtn} onClick={() => navigate('/blog')}>My posts</button>
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
      {/* Display only - the card is itself a button, so a tag in here that led
          somewhere else would be a second destination inside the first. */}
      <PostTags tags={post.tags} className={styles.postCardTags} />
      <div className={styles.commentTime}>{relTime(post.publishedAt)}</div>
    </button>
  );
}

// ── History tab ──────────────────────────────────────────────────────────────
// The merged stream: posts and shared comments interleaved, newest first. Named
// "Content" until the older comments-grouped-by-article tab that held the name
// was removed.
// The profile's main page: everything this person made or shared - blog posts
// and shared comments - in one timeline. The API route is still /activity.
function HistoryTab({ username, authKey, onOpenComment, onOpenPost }: {
  username: string;
  authKey: string | null;
  onOpenComment: (url: string, commentId: string) => void;
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
        : <CommentCard key={`c${item.comment.id}`} comment={item.comment} onOpen={onOpenComment} />)}
    </div>
  );
}

// ── One post, in full ────────────────────────────────────────────────────────
// The Posts tab is the author's index: their writing, newest first, each piece
// whole rather than reduced to a title and a line of stripped text. A post is
// formatted work - headings, quotes, images, reference cards - and an excerpt
// throws all of that away, which left this tab looking like a list of links to
// the thing you were already looking at.
//
// Long posts are clamped to a screen's worth so the tab stays scannable; the
// permalink is where you go to read one properly and to reply to it.
function PostArticle({ post, onOpen, tag, onSelectTag }: {
  post: BlogPost;
  onOpen: (slug: string) => void;
  tag: string;
  onSelectTag: (tag: string) => void;
}) {
  return (
    <article className={styles.postFull}>
      {post.heroImage && <img className={styles.postFullHero} src={post.heroImage} alt="" />}

      <div className={styles.commentTop}>
        <span className={styles.kindTag}>Post</span>
        {post.visibility !== 'public' && (
          <span className={styles.chip}>{POST_VIS_META[post.visibility].tag}</span>
        )}
        <span className={styles.commentTime}>{relTime(post.publishedAt)}</span>
      </div>

      {/* The title is the way in, so it is the link - the body below carries
          its own markup and must not be wrapped in a button. */}
      <button className={styles.postFullTitle} onClick={() => onOpen(post.slug)}>
        {post.title}
      </button>

      {/* Live here rather than only on the reader: this tab *is* the author's
          index, so filtering it is the thing a tag is for. */}
      <PostTags
        tags={post.tags}
        active={tag}
        onSelect={onSelectTag}
        className={styles.postFullTags}
      />

      <PostBody html={post.body} clamp onExpand={() => onOpen(post.slug)} />
    </article>
  );
}

// ── Posts tab ────────────────────────────────────────────────────────────────
function PostsTab({ username, authKey, onOpen, tag, onSelectTag }: {
  username: string;
  authKey: string | null;
  onOpen: (slug: string) => void;
  /** The tag being filtered on, '' for none. */
  tag: string;
  onSelectTag: (tag: string) => void;
}) {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // The tag filter goes to the server rather than sifting the loaded page: this
  // list is paged, so filtering what happens to be loaded would report "no
  // posts" for a tag whose posts are two pages down. Both parameters are built
  // through one URL so the cursor can't land on the wrong side of the '?'.
  const listUrl = useCallback((nextCursor?: string) => {
    const query = new URLSearchParams();
    if (tag) query.set('tag', tag);
    if (nextCursor) query.set('cursor', nextCursor);
    const search = query.toString();
    return `/api/v1/blogs/${encodeURIComponent(username)}/posts${search ? `?${search}` : ''}`;
  }, [username, tag]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // A tag change is a different list, not more of this one - the old cursor
    // points into the unfiltered sequence and would page it in underneath.
    setCursor(null);
    apiGet<{ posts: BlogPost[]; nextCursor: string | null }>(listUrl())
      .then(d => { if (!cancelled) { setPosts(d.posts); setCursor(d.nextCursor); } })
      .catch(() => { if (!cancelled) setPosts([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [listUrl, authKey]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const d = await apiGet<{ posts: BlogPost[]; nextCursor: string | null }>(listUrl(cursor));
      setPosts(prev => [...prev, ...d.posts]);
      setCursor(d.nextCursor);
    } catch { /* leave as-is */ }
    setLoadingMore(false);
  }

  // The filter has to be visible and reversible from here: arriving on a
  // ?tag= link, an empty result would otherwise read as "this author has
  // written nothing" rather than "nothing under this tag".
  const banner = tag ? (
    <div className={styles.tagFilter}>
      <span className={styles.tagFilterLabel}>Tagged <strong>#{tag}</strong></span>
      <button className={styles.tagFilterClear} onClick={() => onSelectTag('')}>
        Show all posts
      </button>
    </div>
  ) : null;

  if (loading) return <>{banner}<div className={styles.centered}>Loading…</div></>;
  if (posts.length === 0) {
    return (
      <>
        {banner}
        <div className={styles.centered}>{tag ? 'No posts with that tag.' : 'No posts yet.'}</div>
      </>
    );
  }

  return (
    <div className={styles.list}>
      {banner}
      {posts.map(p => (
        <PostArticle key={p.id} post={p} onOpen={onOpen} tag={tag} onSelectTag={onSelectTag} />
      ))}
      {cursor && (
        <button className={styles.moreBtn} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// ── One comment, as a card ───────────────────────────────────────────────────
// The whole card is a link into the conversation this comment came from, and it
// says so three ways: the article's title behaves like a link (it takes the
// accent and underlines when the card is pointed at or focused), the comment
// itself sits behind a quote rule so it reads as "this reply, on that article"
// rather than one slab of text under a heading, and the foot names what a click
// will do. The hint stays visible when nothing is hovering, because a touch
// screen never hovers and the affordance can't be hover-only.
function CommentCard({ comment: c, onOpen }: {
  comment: ProfileComment;
  onOpen: (url: string, commentId: string) => void;
}) {
  const host = hostOf(c.articleUrl);
  return (
    <button className={styles.commentCard} onClick={() => onOpen(c.articleUrl, c.id)}>
      <div className={styles.commentSource}>
        <span className={styles.sourceLabel}>on</span>
        <span className={styles.articleTitle}>{c.articleTitle || host}</span>
        <span className={styles.dot} aria-hidden>·</span>
        <span className={styles.host}>{host}</span>
        {c.visibility === 'friends' && <span className={styles.chip}>Friends</span>}
      </div>

      <div className={styles.commentQuote}>
        {c.title && <div className={styles.commentTitle}>{c.title}</div>}
        <div className={`${styles.commentBody} note-embed-read`} dangerouslySetInnerHTML={{ __html: c.body }} />
      </div>

      <div className={styles.commentFoot}>
        <span className={styles.commentTime}>{relTime(c.createdAt)}</span>
        <span className={styles.openHint}>
          Read the thread
          <span className={styles.openHintArrow} aria-hidden>→</span>
        </span>
      </div>
    </button>
  );
}

// ── Comments tab ────────────────────────────────────────────────────────────
function CommentsTab({ username, authKey, onOpen }: {
  username: string;
  authKey: string | null;
  onOpen: (url: string, commentId: string) => void;
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

