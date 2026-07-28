import { useEffect, useState } from 'react';
import { apiFetch, apiGet, apiPost } from '../services/api';
import styles from './FollowBlogButton.module.css';

// Subscribing to someone's blog is "bookmarking their profile": the server adds
// their feed to a folder you choose (so their posts appear in that folder's
// article list) and creates a sidebar tile for them, with the unread badge any
// other site gets. Only public posts travel this way - friends-only posts are
// read on the profile, or through your personal feed.
//
// Lives here rather than inside ProfilePage because a reader who lands straight
// on a post is the person most likely to want the author's feed, and that page
// needs the identical three-state control (unknown → follow → following).

interface Props {
  username: string;
  // The profile page renders this inline among its other header actions; the
  // post page gives it a filled treatment, since subscribing is the main thing
  // a reader can do there.
  variant?: 'ghost' | 'primary';
}

export default function FollowBlogButton({ username, variant = 'ghost' }: Props) {
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
      // With one folder there is nothing to choose - just use it.
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

  // Render nothing until the status is known, rather than flashing "Follow" at
  // someone who already subscribes.
  if (following === null) return null;

  const followClass = variant === 'primary' ? styles.primaryBtn : styles.ghostBtn;

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
        <button className={styles.ghostBtn} disabled={busy} onClick={unfollow}
          title="Stop following this author’s posts">
          Following ✓
        </button>
      ) : (
        <button className={followClass} disabled={busy} onClick={openPicker}
          title="Follow this author’s posts in one of your RSS folders">
          Follow posts
        </button>
      )}
      {err && <div className={styles.error}>{err}</div>}
    </>
  );
}
