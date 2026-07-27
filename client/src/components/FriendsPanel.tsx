import { useState, useEffect, useCallback, ReactNode } from 'react';
import styles from './FriendsPanel.module.css';
import { useFriends } from '../hooks/useFriends';
import { useBlocks } from '../hooks/useBlocks';
import { FriendSearchResult, PublicUser } from '../types';

// The Friends tab on your own profile - who you know, who you've asked, and
// where you go to find someone new. This used to be two tabs inside the People
// modal; it belongs on the profile, next to everything else that describes you.
//
// Self-only by design: /api/v1/friends is scoped to the authed user, so there
// is no way (and no decision made) to show someone else's list.

interface Props {
  accessToken: string | null;
  onViewProfile?: (username: string) => void;
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

function Avatar({ user }: { user: PublicUser | null }) {
  if (user?.avatar) return <img className={styles.avatar} src={user.avatar} alt="" />;
  return <span className={styles.avatarFallback}>{initialOf(user?.displayName ?? '?')}</span>;
}

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

export default function FriendsPanel({ accessToken, onViewProfile }: Props) {
  const { friends, requests, loading, load, search, sendRequest, decline, unfriend } = useFriends(accessToken);
  // The blocked list lives here rather than in Settings: it is the same
  // question as the friends list ("who am I connected to, and how"), just the
  // negative answer, and blocking is reached from the same profiles.
  const { blocked, load: loadBlocks, unblock } = useBlocks(accessToken);
  const [adding, setAdding] = useState(false);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadBlocks(); }, [loadBlocks]);

  const outgoing = requests.outgoing;

  if (loading && friends.length === 0 && outgoing.length === 0) {
    return <div className={styles.empty}>Loading…</div>;
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <div className={styles.count}>
          {friends.length === 0 ? 'No friends yet' : `${friends.length} friend${friends.length === 1 ? '' : 's'}`}
        </div>
        <button className={styles.primaryBtn} onClick={() => setAdding(a => !a)}>
          {adding ? 'Done' : 'Find people'}
        </button>
      </div>

      {adding && <AddPeople search={search} onSend={sendRequest} onViewProfile={onViewProfile} />}

      {friends.length === 0 && outgoing.length === 0 && !adding && (
        <div className={styles.empty}>Use “Find people” to send your first friend request.</div>
      )}

      {friends.length > 0 && (
        <div className={styles.list}>
          {friends.map(f => (
            <div key={f.id} className={styles.row}>
              <PersonHead user={f} sub={`@${f.username}`} onView={onViewProfile} />
              <div className={styles.rowBtns}>
                <button className={styles.ghostBtn} onClick={() => unfriend(f.id)}>Unfriend</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <>
          <div className={styles.sectionLabel}>Sent requests</div>
          <div className={styles.list}>
            {outgoing.map(r => (
              <div key={r.id} className={styles.row}>
                <PersonHead user={r.user} sub={`@${r.user.username} · pending`} onView={onViewProfile} />
                <div className={styles.rowBtns}>
                  <button className={styles.ghostBtn} onClick={() => decline(r.id)}>Cancel</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Only shown once there's something in it - an empty "Blocked" heading
          on every profile would be a permanent reminder of nothing. */}
      {blocked.length > 0 && (
        <>
          <div className={styles.sectionLabel}>Blocked</div>
          <div className={styles.blockedNote}>
            You can’t see each other’s posts or comments, and neither of you can send the other a
            friend request. They aren’t told they’ve been blocked.
          </div>
          <div className={styles.list}>
            {blocked.map(b => (
              <div key={b.id} className={`${styles.row} ${styles.rowBlocked}`}>
                {/* No profile link: their profile is a stub for you now, and
                    offering the trip there implies there's something to read. */}
                <PersonHead user={b} sub={`@${b.username} · blocked ${relDate(b.blockedAt)}`} />
                <div className={styles.rowBtns}>
                  <button className={styles.ghostBtn} onClick={() => unblock(b.id)}>Unblock</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Short absolute date - "blocked 12 Mar". Deliberately not relative: how long
// ago you blocked someone is not the kind of thing that wants a live counter.
function relDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Find people ─────────────────────────────────────────────────────────────
function AddPeople({ search, onSend, onViewProfile }: {
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
    setResults(await search(query));
    setSearching(false);
  }, [search]);

  // Debounce as the user types
  useEffect(() => {
    const id = setTimeout(() => runSearch(q), 300);
    return () => clearTimeout(id);
  }, [q, runSearch]);

  async function handleSend(username: string) {
    setMsg('');
    const res = await onSend(username);
    if (res.ok) setSent(prev => new Set(prev).add(username.toLowerCase()));
    else setMsg(res.error ?? 'Could not send request');
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
      {q.trim().length < 2 && <div className={styles.hint}>Type at least 2 characters.</div>}
      {q.trim().length >= 2 && !searching && results.length === 0 && (
        <div className={styles.hint}>No users found.</div>
      )}
      {results.length > 0 && (
        <div className={styles.list}>
          {results.map(u => {
            const relation = sent.has(u.username.toLowerCase()) ? 'outgoing' : u.relation;
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
      )}
    </div>
  );
}
