import { useEffect, useRef } from 'react';
import styles from './NotificationsModal.module.css';
import { useFriends } from '../hooks/useFriends';
import { AppNotification, PublicUser } from '../types';
import { notifActor, notifAction, relTime } from '../utils/notifications';

// The bell's panel: one column, newest first. Friend *management* (who you know,
// who you've asked, who to add) moved onto your profile's Friends tab - what's
// left here is only the things that happened while you were away.
//
// Incoming friend requests stay, because they're the one notification you can
// act on without leaving: answering them here is the whole point of the badge.

interface Props {
  accessToken: string | null;
  notifications: AppNotification[];
  notifLoading: boolean;
  onLoadNotifications: () => void;
  onMarkAllRead: () => void;
  onClose: () => void;
  onViewProfile?: (username: string) => void;
  // Open a report in the admin panel's moderation queue. Absent for anyone who
  // isn't an admin - they never receive a report alert in the first place.
  onOpenReport?: (reportId: string) => void;
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

function Avatar({ user, onView }: { user: PublicUser | null; onView?: (username: string) => void }) {
  const img = user?.avatar
    ? <img className={styles.avatar} src={user.avatar} alt="" />
    : <span className={styles.avatarFallback}>{initialOf(user?.displayName ?? '?')}</span>;
  if (!user || !onView) return img;
  return (
    <button type="button" className={styles.personBtn} onClick={() => onView(user.username)} title={`View @${user.username}`}>
      {img}
    </button>
  );
}

// "<name> replied to your comment", with the name as a link to their profile.
// The name is only a link when there's an actor to route to - a report notice
// carries none, and a deleted account leaves the fallback text.
function ActorLine({ notification: n, onView }: {
  notification: AppNotification;
  onView?: (username: string) => void;
}) {
  const who = notifActor(n);
  const action = notifAction(n.type);
  const linkable = n.actor && onView;
  return (
    <>
      {linkable
        ? (
          <button
            type="button"
            className={styles.nameBtn}
            onClick={() => onView!(n.actor!.username)}
            title={`View @${n.actor!.username}`}
          >
            <strong>{who}</strong>
          </button>
        )
        : <strong>{who}</strong>}
      {action && ` ${action}`}
    </>
  );
}

export default function NotificationsModal({
  accessToken, notifications, notifLoading, onLoadNotifications, onMarkAllRead, onClose, onViewProfile, onOpenReport,
}: Props) {
  const { requests, load, accept, decline } = useFriends(accessToken);

  // Load the feed and the actionable requests on open; mark the feed seen.
  const markedRef = useRef(false);
  useEffect(() => {
    load();
    onLoadNotifications();
    if (!markedRef.current) { markedRef.current = true; setTimeout(onMarkAllRead, 400); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const incoming = requests.incoming;
  // Requests are rendered actionably above; don't also list them as plain text.
  const feed = notifications.filter(n => n.type !== 'friend_request');
  const empty = incoming.length === 0 && feed.length === 0;

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.card} onClick={e => e.stopPropagation()} role="dialog" aria-label="Notifications">
        <div className={styles.head}>
          <div className={styles.title}>Notifications</div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.body}>
          {empty ? (
            <div className={styles.empty}>{notifLoading ? 'Loading…' : 'Nothing new right now.'}</div>
          ) : (
            <div className={styles.list}>
              {incoming.map(r => (
                <div key={r.id} className={styles.rowActionable}>
                  <Avatar user={r.user} onView={onViewProfile} />
                  <div className={styles.rowText}>
                    <div>
                      {onViewProfile
                        ? (
                          <button
                            type="button"
                            className={styles.nameBtn}
                            onClick={() => onViewProfile(r.user.username)}
                            title={`View @${r.user.username}`}
                          >
                            <strong>{r.user.displayName}</strong>
                          </button>
                        )
                        : <strong>{r.user.displayName}</strong>}
                      {' wants to be friends'}
                    </div>
                    <div className={styles.sub}>@{r.user.username} · {relTime(r.createdAt)}</div>
                  </div>
                  <div className={styles.rowBtns}>
                    <button className={styles.primaryBtn} onClick={() => accept(r.id)}>Accept</button>
                    <button className={styles.ghostBtn} onClick={() => decline(r.id)}>Decline</button>
                  </div>
                </div>
              ))}

              {feed.map(n => {
                const isComment = n.type === 'comment_reply' || n.type === 'friend_comment';
                // A report alert belongs in the moderation queue, not at the
                // reported content: the moderator needs the report - its
                // category, the reporter's note, the Uphold/Dismiss controls -
                // and the content is one click away from there. Everything else
                // links out to the article the comment sits on.
                const report = n.type === 'report_new' && n.reportId && onOpenReport ? n.reportId : null;
                return (
                  <div key={n.id} className={`${styles.row} ${n.read ? '' : styles.rowUnread}`}>
                    <Avatar user={n.actor} onView={onViewProfile} />
                    <div className={styles.rowText}>
                      {/* The name in the sentence is the obvious thing to click,
                          and it was the only unlinked mention of a person left
                          in the app - the avatar beside it already routed. */}
                      <div><ActorLine notification={n} onView={onViewProfile} /></div>
                      {report ? (
                        <button
                          className={styles.articleLink}
                          onClick={() => { onOpenReport!(report); onClose(); }}
                        >
                          {n.articleTitle || 'Open report'} →
                        </button>
                      ) : isComment && n.articleUrl ? (
                        <a className={styles.articleLink} href={n.articleUrl} target="_blank" rel="noopener noreferrer">
                          {n.articleTitle || 'Open article'}
                        </a>
                      ) : null}
                      <div className={styles.sub}>{relTime(n.createdAt)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
