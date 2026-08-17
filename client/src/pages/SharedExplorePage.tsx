import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import styles from './SharedExplorePage.module.css';
import { SharedExplore, SharedExploreMessage, getSharedExplore } from '../services/llm';
import { articlePathFor } from '../utils/articleUrl';
import { profilePathFor } from '../utils/profileUrl';
import { faviconUrl } from '../utils/color';
import { relTime } from '../utils/notifications';

// A shared explore thread, read-only.
//
// Standalone rather than inside the app shell, and for the same reason a public
// post is: whoever follows this link may have no account, and a page that
// surrounds a conversation with someone else's bookmarks and notes would be
// showing them furniture that isn't theirs.
//
// Read-only in the strong sense - there is no composer, and the route behind it
// (/api/v1/explores/:id) cannot call a model at all. Continuing somebody else's
// research would spend *their* credit on *your* question.
//
// It shows the whole transcript, both halves of every exchange. That is what
// the author agreed to when they shared it - the publish dialog shows them
// exactly this - and a page that quietly hid the questions would make the
// answers unreadable.

interface Props {
  threadId: string;
  navigate: (to: string) => void;
}

type Load = 'loading' | 'ready' | 'missing';

export default function SharedExplorePage({ threadId, navigate }: Props) {
  const [state, setState] = useState<Load>('loading');
  const [thread, setThread] = useState<SharedExplore | null>(null);
  const [messages, setMessages] = useState<SharedExploreMessage[]>([]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    getSharedExplore(threadId).then(
      r => {
        if (cancelled) return;
        setThread(r.thread);
        setMessages(r.messages);
        setState('ready');
      },
      () => { if (!cancelled) setState('missing'); },
    );
    return () => { cancelled = true; };
  }, [threadId]);

  useEffect(() => {
    if (thread) document.title = `${thread.title} · Newt`;
    return () => { document.title = 'Newt'; };
  }, [thread]);

  if (state === 'loading') return <div className={styles.centered}>Loading…</div>;

  // One message for "no such thread" and for "not shared with you", because the
  // server deliberately does not tell them apart - see the 404 note in
  // routes/explores.ts.
  if (state === 'missing' || !thread) {
    return (
      <div className={styles.centered}>
        <div className={styles.big}>This conversation isn’t available</div>
        <p className={styles.muted}>
          It may have been made private again, or deleted. If someone sent you this link,
          ask them to check it is still shared.
        </p>
        <button className={styles.ghostBtn} onClick={() => navigate('/')}>Go to Newt</button>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.kicker}>
          Explored with Newt
          {thread.visibility === 'friends' && <span className={styles.tier}>Friends only</span>}
        </div>
        <h1 className={styles.title}>{thread.title}</h1>
        <div className={styles.byline}>
          {thread.author && (
            <>
              {/* Built the same way every other profile link is: usernames
                  aren't charset-restricted, so the segment must be encoded. */}
              <a className={styles.author} href={profilePathFor(thread.author.username)}>
                {thread.author.displayName}
              </a>
              <span className={styles.dot}>·</span>
            </>
          )}
          <span>{messages.length} message{messages.length === 1 ? '' : 's'}</span>
          {thread.sharedAt && (
            <>
              <span className={styles.dot}>·</span>
              <span>shared {relTime(thread.sharedAt)}</span>
            </>
          )}
        </div>

        {/* The article it came from, and the way back to its comments. A
            conversation about a piece is worth much less without a door to the
            piece itself. */}
        {thread.sourceUrl && (
          <a className={styles.source} href={articlePathFor(thread.sourceUrl)}>
            <img
              className={styles.sourceIcon}
              src={faviconUrl(hostOf(thread.sourceUrl))}
              alt=""
              onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
            />
            <span className={styles.sourceText}>
              <span className={styles.sourceLabel}>Started from</span>
              <span className={styles.sourceTitle}>{thread.sourceTitle || thread.sourceUrl}</span>
            </span>
          </a>
        )}
      </header>

      <ol className={styles.thread}>
        {messages.map(m => (
          <li key={m.id} className={m.role === 'user' ? styles.user : styles.assistant}>
            <div className={styles.who}>{m.role === 'user' ? 'Question' : 'Answer'}</div>
            <div className={styles.body}>
              {/* Same renderer the owner's view uses. No raw HTML plugin: the
                  body is markdown a model wrote, and it is never trusted as
                  markup anywhere in this app. */}
              <ReactMarkdown>{m.body}</ReactMarkdown>
            </div>
          </li>
        ))}
      </ol>

      <footer className={styles.foot}>
        {/* An invitation rather than a wall. The whole conversation is above -
            this is what someone does *next*, not what they must do to read. */}
        <p className={styles.muted}>
          This is one person’s conversation about an article, shared from their Newt.
        </p>
        <button className={styles.ghostBtn} onClick={() => navigate('/')}>Open Newt</button>
      </footer>
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
