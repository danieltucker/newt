import { useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import styles from './FriendsModal.module.css';
import { useFriends } from '../hooks/useFriends';
import { AppNotification, FriendSearchResult, PublicUser } from '../types';
import { notifText, relTime } from '../utils/notifications';

type Tab = 'activity' | 'friends' | 'add';

interface Props {
  accessToken: string | null;
  notifications: AppNotification[];
  notifLoading: boolean;
  onLoadNotifications: () => void;
  onMarkAllRead: () => void;
  onClose: () => void;
  onViewProfile?: (username: string) => void;
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

function Avatar({ user }: { user: PublicUser | null }) {
  if (user?.avatar) return <img className={styles.avatar} src={user.avatar} alt="" />;
  return <span className={styles.avatarFallback}>{initialOf(user?.displayName ?? '?')}</span>;
}

// A person's avatar + name (with optional sub-line). When onView is given, the
// avatar and name link to that user's public profile.
function PersonHead({ user, sub, onView }: {
  user: PublicUser;
  sub?: ReactNode;
  onView?: (username: string) => void;
}) {
  const view = onView ? () => onView(user.username) : undefined;
  return (
    <>
      {view
        ? <button type="button" className={styles.personBtn} onClick={view} title={`View @${user.username}`}><Avatar user={user} /></button>
        : <Avatar user={user} />}
      <div className={styles.rowText}>
        <div>
          {view
            ? <button type="button" className={styles.personBtn} onClick={view}><strong>{user.displayName}</strong></button>
            : <strong>{user.displayName}</strong>}
        </div>
        {sub != null && <div className={styles.sub}>{sub}</div>}
      </div>
    </>
  );
}

export default function FriendsModal({
  accessToken, notifications, notifLoading, onLoadNotifications, onMarkAllRead, onClose, onViewProfile,
}: Props) {
  const [tab, setTab] = useState<Tab>('activity');
  const { friends, requests, loading, load, search, sendRequest, accept, decline, unfriend } = useFriends(accessToken);

  // Load friends + requests and the notification feed on open; mark the feed seen.
  const markedRef = useRef(false);
  useEffect(() => {
    load();
    onLoadNotifications();
    if (!markedRef.current) { markedRef.current = true; setTimeout(onMarkAllRead, 400); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const incomingCount = requests.incoming.length;

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.card} onClick={e => e.stopPropagation()}>
        <div className={styles.head}>
          <div className={styles.title}>People</div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'activity'}
            className={`${styles.tab} ${tab === 'activity' ? styles.tabActive : ''}`}
            onClick={() => setTab('activity')}>
            Activity{incomingCount > 0 && <span className={styles.tabBadge}>{incomingCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'friends'}
            className={`${styles.tab} ${tab === 'friends' ? styles.tabActive : ''}`}
            onClick={() => setTab('friends')}>
            Friends{friends.length > 0 && <span className={styles.tabCount}>{friends.length}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'add'}
            className={`${styles.tab} ${tab === 'add' ? styles.tabActive : ''}`}
            onClick={() => setTab('add')}>
            Add
          </button>
        </div>

        <div className={styles.body}>
          {tab === 'activity' && (
            <ActivityTab
              incoming={requests.incoming}
              notifications={notifications}
              loading={notifLoading}
              onAccept={accept}
              onDecline={decline}
            />
          )}
          {tab === 'friends' && (
            <FriendsTab
              friends={friends}
              outgoing={requests.outgoing}
              loading={loading}
              onUnfriend={unfriend}
              onCancel={decline}
              onViewProfile={onViewProfile}
            />
          )}
          {tab === 'add' && (
            <AddTab search={search} onSend={sendRequest} onViewProfile={onViewProfile} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────
function ActivityTab({ incoming, notifications, loading, onAccept, onDecline }: {
  incoming: { id: string; user: PublicUser; createdAt: string }[];
  notifications: AppNotification[];
  loading: boolean;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  // The actionable requests live in `incoming`; the feed shows everything else.
  const feed = notifications.filter(n => n.type !== 'friend_request');

  if (incoming.length === 0 && feed.length === 0) {
    return <div className={styles.empty}>{loading ? 'Loading…' : 'Nothing new right now.'}</div>;
  }

  return (
    <div className={styles.list}>
      {incoming.map(r => (
        <div key={r.id} className={styles.rowActionable}>
          <Avatar user={r.user} />
          <div className={styles.rowText}>
            <div><strong>{r.user.displayName}</strong> wants to be friends</div>
            <div className={styles.sub}>@{r.user.username} · {relTime(r.createdAt)}</div>
          </div>
          <div className={styles.rowBtns}>
            <button className={styles.primaryBtn} onClick={() => onAccept(r.id)}>Accept</button>
            <button className={styles.ghostBtn} onClick={() => onDecline(r.id)}>Decline</button>
          </div>
        </div>
      ))}
      {feed.map(n => {
        const text = notifText(n);
        const isComment = n.type === 'comment_reply' || n.type === 'friend_comment';
        return (
          <div key={n.id} className={`${styles.row} ${n.read ? '' : styles.rowUnread}`}>
            <Avatar user={n.actor} />
            <div className={styles.rowText}>
              <div>{text}</div>
              {isComment && n.articleUrl && (
                <a className={styles.articleLink} href={n.articleUrl} target="_blank" rel="noopener noreferrer">
                  {n.articleTitle || 'Open article'}
                </a>
              )}
              <div className={styles.sub}>{relTime(n.createdAt)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Friends ─────────────────────────────────────────────────────────────────
function FriendsTab({ friends, outgoing, loading, onUnfriend, onCancel, onViewProfile }: {
  friends: PublicUser[];
  outgoing: { id: string; user: PublicUser; createdAt: string }[];
  loading: boolean;
  onUnfriend: (userId: string) => void;
  onCancel: (id: string) => void;
  onViewProfile?: (username: string) => void;
}) {
  if (loading && friends.length === 0 && outgoing.length === 0) {
    return <div className={styles.empty}>Loading…</div>;
  }
  if (friends.length === 0 && outgoing.length === 0) {
    return <div className={styles.empty}>No friends yet — add someone from the Add tab.</div>;
  }
  return (
    <div className={styles.list}>
      {friends.map(f => (
        <div key={f.id} className={styles.row}>
          <PersonHead user={f} sub={`@${f.username}`} onView={onViewProfile} />
          <div className={styles.rowBtns}>
            <button className={styles.ghostBtn} onClick={() => onUnfriend(f.id)}>Unfriend</button>
          </div>
        </div>
      ))}
      {outgoing.length > 0 && <div className={styles.sectionLabel}>Sent requests</div>}
      {outgoing.map(r => (
        <div key={r.id} className={styles.row}>
          <PersonHead user={r.user} sub={`@${r.user.username} · pending`} onView={onViewProfile} />
          <div className={styles.rowBtns}>
            <button className={styles.ghostBtn} onClick={() => onCancel(r.id)}>Cancel</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Add ─────────────────────────────────────────────────────────────────────
function AddTab({ search, onSend, onViewProfile }: {
  search: (q: string) => Promise<FriendSearchResult[]>;
  onSend: (username: string) => Promise<{ ok: boolean; error?: string }>;
  onViewProfile?: (username: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FriendSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState<Set<string>>(new Set());

  const runSearch = useCallback(async (query: string) => {
    if (query.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    const r = await search(query);
    setResults(r);
    setSearching(false);
  }, [search]);

  // Debounce the search as the user types
  useEffect(() => {
    const id = setTimeout(() => runSearch(q), 300);
    return () => clearTimeout(id);
  }, [q, runSearch]);

  async function handleSend(username: string) {
    setMsg('');
    const res = await onSend(username);
    if (res.ok) {
      setSent(prev => new Set(prev).add(username.toLowerCase()));
    } else {
      setMsg(res.error ?? 'Could not send request');
    }
  }

  return (
    <div className={styles.addWrap}>
      <input
        className={styles.searchInput}
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search by username…"
        autoFocus
      />
      {msg && <div className={styles.error}>{msg}</div>}
      <div className={styles.list}>
        {q.trim().length < 2 && <div className={styles.empty}>Type at least 2 characters.</div>}
        {q.trim().length >= 2 && !searching && results.length === 0 && (
          <div className={styles.empty}>No users found.</div>
        )}
        {results.map(u => {
          const justSent = sent.has(u.username.toLowerCase());
          const relation = justSent ? 'outgoing' : u.relation;
          return (
            <div key={u.id} className={styles.row}>
              <PersonHead user={u} sub={`@${u.username}`} onView={onViewProfile} />
              <div className={styles.rowBtns}>
                {relation === 'friends' && <span className={styles.statusTag}>Friends</span>}
                {relation === 'outgoing' && <span className={styles.statusTag}>Requested</span>}
                {relation === 'incoming' && <span className={styles.statusTag}>Wants to add you</span>}
                {relation === 'none' && (
                  <button className={styles.primaryBtn} onClick={() => handleSend(u.username)}>Add friend</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
