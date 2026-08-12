import { useState, useEffect, useRef, useCallback } from 'react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../services/api';
import { ArticleComment, CommentPrefs, CommentVisibility, CommentHistory } from '../types';
import RichEditor from './RichEditor';
import ReportModal from './ReportModal';
import { uploadImage } from '../utils/imageUpload';
import { fetchPageMeta } from '../utils/pageMeta';
import { VIS_ORDER, VIS_META } from './VisibilityMeta';
import SplitMenuButton, { MenuItem } from './SplitMenuButton';
import styles from './CommentsPanel.module.css';

// The comment thread, always open. It lives at the foot of the article reader
// modal, where there is room to actually read and write; cards carry only the
// compact CommentBar below, which opens that modal.
//
// Threads are keyed server-side by the article's canonical URL, so the same
// conversation appears whether the article came from the feed or the reading
// list.

interface Props {
  articleUrl: string;
  articleTitle: string;
  prefs: CommentPrefs;
  onCountChange?: (url: string, next: number) => void;
  // Reading-list items saved before comments existed carry a single plain-text
  // note, folded into the thread as a private comment the first time it loads.
  legacyNote?: string;
  onLegacyNoteMigrated?: () => void;
  // Open a comment author's public profile (/u/<username>). Absent when there's
  // nowhere to route to (e.g. rendered outside the app shell).
  onViewProfile?: (username: string) => void;
  // Logged-out viewers can read a public thread but not post/reply/edit/delete.
  readOnly?: boolean;
  // One comment to scroll to and flash once the thread has loaded - set when
  // the reader was opened *from* a specific comment (a card on a profile).
  // A thread can be long, and landing at the top of one leaves you hunting for
  // the comment you clicked.
  focusCommentId?: string | null;
}

function countTree(nodes: ArticleComment[]): number {
  return nodes.reduce((n, c) => n + 1 + countTree(c.replies), 0);
}

function commentDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Mirrors the server's blank check so Post can't offer to submit an empty
// editor (which still emits markup like "<p><br></p>").
function htmlIsBlank(html: string): boolean {
  if (/<(hr|table|img)\b/i.test(html)) return false;
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length === 0;
}

// Keep in step with MAX_COMMENT_TEXT in server/src/lib/comments.ts. Enforced
// server-side; this just gives the composer a live counter and blocks Post so
// the user isn't surprised by a rejection.
const MAX_COMMENT_TEXT = 5000;
function commentTextLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().length;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

// The three visibility tiers live in VisibilityMeta so the blog composer shows
// the identical set - they write the same `visibility` values and are read
// through the same friendship rules.

// ── The compact strip that sits on a card ────────────────────────────────
//
// A split pill, matching the Save button beside it: the label opens the reader,
// and the caret carries the other two things you do with an article once you
// have read it. Explore and Repost were only ever inside the reader, at the
// foot of the text - which is the right place to *find* them and the wrong
// place to reach them from a feed you are scanning. Neither is a decision that
// needs the article open: you know from the card whether you want to quote it
// or go deeper on it.
//
// It stays a plain pill when there is nothing behind the caret - a signed-out
// reader, or an account with no model connected on a surface that offers no
// repost either. A caret over an empty menu is worse than no caret.
export function CommentBar({ count, onClick, onExplore, onRepost }: {
  count: number;
  onClick: () => void;
  /** Opens an Explore thread on this article. Absent with no model connected. */
  onExplore?: () => void;
  /** Opens the composer on a post quoting this article. */
  onRepost?: () => void;
}) {
  // Split in two so a narrow card can drop the noun and keep the number - the
  // count is the only part of this label that is data. See the collapse note in
  // SplitMenuButton.module.css.
  const label = count > 0 ? String(count) : 'Comment';
  const labelExtra = count > 0 ? `comment${count === 1 ? '' : 's'}` : undefined;
  const title = count > 0
    ? 'Read the article and its comments'
    : 'Read the article and add a comment';

  if (!onExplore && !onRepost) {
    return (
      <button
        className={styles.bar}
        onClick={onClick}
        title={title}
        aria-label={labelExtra ? `${label} ${labelExtra}` : label}
      >
        <CommentIcon />
        <span className={styles.barLabel} aria-hidden>
          {label}
          {labelExtra && <span className={styles.barWord}> {labelExtra}</span>}
        </span>
      </button>
    );
  }

  return (
    <SplitMenuButton
      label={label}
      labelExtra={labelExtra}
      icon={<CommentIcon />}
      onPrimary={onClick}
      primaryTitle={title}
      menuLabel="Take it further"
      menu={close => (
        <>
          {onExplore && (
            <MenuItem
              label="Explore"
              icon={<ExploreIcon />}
              onClick={() => { close(); onExplore(); }}
            />
          )}
          {onRepost && (
            <MenuItem
              label="Repost"
              icon={<RepostIcon />}
              onClick={() => { close(); onRepost(); }}
            />
          )}
        </>
      )}
    />
  );
}

// Comment images are capped at 320px tall so one screenshot can't push the rest
// of the thread off-screen. Clicking opens the full size in a new tab - cheaper
// than a lightbox, and it works for remote images too.
function openImageAt(e: React.MouseEvent) {
  const img = (e.target as HTMLElement).closest('img');
  if (!img) return;
  const src = img.getAttribute('src');
  if (src) window.open(src, '_blank', 'noopener,noreferrer');
}

// ── Composer ──────────────────────────────────────────────────────────────
// The body lives in a ref rather than state: RichEditor is uncontrolled, and
// re-rendering it on every keystroke buys nothing. Only the empty/non-empty
// flip needs a render, to enable the Post button.
function Composer({
  allowTitle, initialTitle = '', initialBody = '', defaultVisibility, submitLabel,
  autoFocusBody, busy, onSubmit, onCancel,
}: {
  allowTitle: boolean;
  initialTitle?: string;
  initialBody?: string;
  defaultVisibility: CommentVisibility;
  submitLabel: string;
  // The body, not the title: the title is optional and the reader opened this
  // to write a comment, so that is where the caret belongs.
  autoFocusBody?: boolean;
  busy: boolean;
  onSubmit: (v: { title: string; body: string; visibility: CommentVisibility }) => void;
  onCancel?: () => void;
}) {
  const bodyRef = useRef(initialBody);
  const [empty, setEmpty] = useState(htmlIsBlank(initialBody));
  const [textLen, setTextLen] = useState(() => commentTextLength(initialBody));
  const [title, setTitle] = useState(initialTitle);
  const [visibility, setVisibility] = useState<CommentVisibility>(defaultVisibility);
  const tooLong = textLen > MAX_COMMENT_TEXT;

  const handleChange = useCallback((html: string) => {
    bodyRef.current = html;
    const blank = htmlIsBlank(html);
    setEmpty(prev => (prev === blank ? prev : blank));
    setTextLen(commentTextLength(html));
  }, []);

  return (
    <div className={styles.composer}>
      {allowTitle && (
        <input
          className={styles.titleInput}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Add a title (optional)"
          maxLength={200}
        />
      )}
      <div className={styles.editorShell}>
        <RichEditor
          initialHtml={initialBody}
          onChange={handleChange}
          onUploadImage={uploadImage}
          onFetchPageMeta={fetchPageMeta}
          autoFocus={autoFocusBody}
        />
      </div>
      <div className={styles.composerFoot}>
        <div className={styles.visSwitch} role="radiogroup" aria-label="Who can see this comment">
          {VIS_ORDER.map(v => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={visibility === v}
              className={`${styles.visOption} ${visibility === v ? styles.visOptionActive : ''}`}
              onClick={() => setVisibility(v)}
              title={VIS_META[v].hint}
            >
              {VIS_META[v].icon}
              <span className={styles.visOptionLabel}>{VIS_META[v].label}</span>
            </button>
          ))}
        </div>
        <div className={styles.composerBtns}>
          {textLen > MAX_COMMENT_TEXT * 0.8 && (
            <span className={`${styles.charCount} ${tooLong ? styles.charCountOver : ''}`}>
              {textLen.toLocaleString()} / {MAX_COMMENT_TEXT.toLocaleString()}
            </span>
          )}
          {onCancel && (
            <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className={styles.postBtn}
            disabled={empty || busy || tooLong}
            title={tooLong ? `Comment is too long - keep it under ${MAX_COMMENT_TEXT.toLocaleString()} characters` : undefined}
            onClick={() => onSubmit({ title: title.trim(), body: bodyRef.current, visibility })}
          >
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── One comment (and its replies) ────────────────────────────────────────
function CommentItem({
  node, depth, prefs, busyId, replyTo, editing,
  onReply, onEdit, onDelete, onModerate, onSubmitReply, onSubmitEdit, onCancel, onViewProfile, readOnly,
}: {
  node: ArticleComment;
  depth: number;
  prefs: CommentPrefs;
  busyId: string | null;
  replyTo: string | null;
  editing: string | null;
  onReply: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onModerate: (id: string) => void;
  onSubmitReply: (parentId: string, v: { body: string; visibility: CommentVisibility }) => void;
  onSubmitEdit: (id: string, v: { title: string; body: string; visibility: CommentVisibility }) => void;
  onCancel: () => void;
  onViewProfile?: (username: string) => void;
  readOnly?: boolean;
}) {
  const isEditing = editing === node.id;
  const isReplying = replyTo === node.id;
  const wasEdited = node.updatedAt !== node.createdAt;
  const replyCount = countTree(node.replies);

  const [collapsed, setCollapsed] = useState(false);
  const [confirmingMod, setConfirmingMod] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<CommentHistory | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState(false);

  async function toggleHistory() {
    if (showHistory) { setShowHistory(false); return; }
    setShowHistory(true);
    if (history || histLoading) return;
    setHistLoading(true);
    setHistError(false);
    try {
      setHistory(await apiGet<CommentHistory>(`/api/v1/comments/${node.id}/history`));
    } catch {
      setHistError(true);
    } finally {
      setHistLoading(false);
    }
  }

  return (
    // data-comment-id, not an element id: the same thread can be mounted twice
    // (a reader over a page that already lists it), and duplicate ids would make
    // the focus lookup below pick whichever one happened to be first in the DOM.
    <div className={styles.comment} data-comment-id={node.id}>
      <div className={styles.commentHead}>
        {(() => {
          const avatarEl = node.deleted
            ? <span className={styles.avatarFallback}>–</span>
            : node.author.avatar
              ? <img className={styles.avatar} src={node.author.avatar} alt="" />
              : <span className={styles.avatarFallback}>{initialOf(node.author.displayName)}</span>;
          const canView = !node.deleted && onViewProfile && node.author.username;
          if (!canView) {
            return <>
              {avatarEl}
              <span className={`${styles.authorName} ${node.deleted ? styles.deletedAuthor : ''}`}>{node.author.displayName}</span>
            </>;
          }
          return (
            <button
              type="button"
              className={styles.authorLink}
              onClick={() => onViewProfile!(node.author.username)}
              title={`View @${node.author.username}`}
            >
              {avatarEl}
              <span className={styles.authorName}>{node.author.displayName}</span>
            </button>
          );
        })()}
        {!node.deleted && node.mine && <span className={styles.youTag}>you</span>}
        <span className={styles.dot}>·</span>
        <time className={styles.date} dateTime={node.createdAt} title={new Date(node.createdAt).toLocaleString()}>
          {commentDate(node.createdAt)}
        </time>
        {!node.deleted && wasEdited && (
          <button
            type="button"
            className={`${styles.edited} ${showHistory ? styles.editedActive : ''}`}
            onClick={toggleHistory}
            title={`Edited ${new Date(node.updatedAt).toLocaleString()} - click to view history`}
          >
            edited {commentDate(node.updatedAt)}
          </button>
        )}
        {/* Tag your own comments (all three tiers), and others' friends-only
            comments so it's clear why you can see them. Others' public comments
            need no tag - public is the default read. A moderator sees the tier
            on everything, because who can read a comment is half of whether it
            needs acting on. */}
        {!node.deleted && (node.mine || node.canModerate || node.visibility === 'friends') && (
          <span className={`${styles.visTag} ${styles[`visTag_${node.visibility}`]}`}>
            {VIS_META[node.visibility].tag}
          </span>
        )}
        {/* The handle, so a moderator can act on an author rather than a name */}
        {!node.deleted && node.canModerate && node.author.username && (
          <span className={styles.modHandle}>@{node.author.username}</span>
        )}
      </div>

      {node.deleted ? (
        <div className={styles.deletedBody}>This comment was deleted.</div>
      ) : isEditing ? (
        <Composer
          allowTitle={node.parentId === null}
          initialTitle={node.title ?? ''}
          initialBody={node.body}
          defaultVisibility={node.visibility}
          submitLabel="Save"
          busy={busyId === node.id}
          onSubmit={v => onSubmitEdit(node.id, v)}
          onCancel={onCancel}
        />
      ) : (
        <>
          {node.title && <div className={styles.commentTitle}>{node.title}</div>}
          {/* Sanitized server-side on write - see server/src/lib/comments.ts */}
          {/* A comment can carry a reference card if one is pasted in - there
              is no /reference command here, but the allowlist permits the
              markup, so the themed skin has to be on. */}
          <div
            className={`${styles.body} note-embed-read`}
            onClick={openImageAt}
            dangerouslySetInnerHTML={{ __html: node.body }}
          />
          {!readOnly && (
            <div className={styles.actions}>
              <button className={styles.actionBtn} onClick={() => onReply(node.id)}>Reply</button>
              {node.mine && <button className={styles.actionBtn} onClick={() => onEdit(node.id)}>Edit</button>}
              {/* Somebody else's words, so there is something to report. Quiet
                  by default - it earns attention only when it's needed. */}
              {!node.mine && (
                <button className={`${styles.actionBtn} ${styles.reportAction}`} onClick={() => setReporting(true)}>
                  Report
                </button>
              )}
              {node.mine && (
                <button
                  className={`${styles.actionBtn} ${styles.deleteAction}`}
                  onClick={() => onDelete(node.id)}
                  disabled={busyId === node.id}
                >
                  Delete
                </button>
              )}
              {/* Moderation. Two-step, because it acts on somebody else's words
                  and - when the comment has replies - reshapes a live thread. */}
              {node.canModerate && (
                confirmingMod ? (
                  <span className={styles.modConfirm}>
                    <span className={styles.modConfirmText}>
                      {replyCount > 0
                        ? `Remove the text? The ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'} below stay.`
                        : 'Remove this comment permanently?'}
                    </span>
                    <button
                      className={styles.modConfirmBtn}
                      onClick={() => { setConfirmingMod(false); onModerate(node.id); }}
                      disabled={busyId === node.id}
                    >
                      {busyId === node.id ? 'Removing…' : 'Remove'}
                    </button>
                    <button className={styles.actionBtn} onClick={() => setConfirmingMod(false)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className={`${styles.actionBtn} ${styles.modAction}`}
                    onClick={() => setConfirmingMod(true)}
                    title={replyCount > 0
                      ? 'Moderate: removes the content and keeps the thread below it'
                      : 'Moderate: permanently removes this comment'}
                  >
                    <ShieldIcon />
                    Remove
                  </button>
                )
              )}
            </div>
          )}
          {showHistory && (
            <CommentHistoryPanel loading={histLoading} error={histError} history={history} />
          )}
          {reporting && (
            <ReportModal
              targetType="comment"
              targetId={node.id}
              subjectName={node.author.displayName}
              onClose={() => setReporting(false)}
            />
          )}
        </>
      )}

      {isReplying && (
        <Composer
          allowTitle={false}
          autoFocusBody
          defaultVisibility={prefs.defaultVisibility}
          submitLabel="Reply"
          busy={busyId === node.id}
          onSubmit={v => onSubmitReply(node.id, { body: v.body, visibility: v.visibility })}
          onCancel={onCancel}
        />
      )}

      {node.replies.length > 0 && (
        <div className={styles.replies}>
          {/* Clicking the rail folds the whole subtree - the pressure valve for
              deep threads, since replies now keep indenting at every level. */}
          <button
            className={styles.collapseRail}
            onClick={() => setCollapsed(c => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Show ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Collapse replies'}
            title={collapsed ? 'Expand' : 'Collapse'}
          />
          <div className={styles.repliesBody}>
            {collapsed ? (
              <button className={styles.showReplies} onClick={() => setCollapsed(false)}>
                Show {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            ) : (
              node.replies.map(r => (
                <CommentItem
                  key={r.id}
                  node={r}
                  depth={depth + 1}
                  prefs={prefs}
                  busyId={busyId}
                  replyTo={replyTo}
                  editing={editing}
                  onReply={onReply}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onModerate={onModerate}
                  onSubmitReply={onSubmitReply}
                  onSubmitEdit={onSubmitEdit}
                  onCancel={onCancel}
                  onViewProfile={onViewProfile}
                  readOnly={readOnly}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline edit history for one comment ──────────────────────────────────────
function CommentHistoryPanel({ loading, error, history }: {
  loading: boolean; error: boolean; history: CommentHistory | null;
}) {
  if (loading) return <div className={styles.history}><div className={styles.historyEmpty}>Loading history…</div></div>;
  if (error) return <div className={styles.history}><div className={styles.historyEmpty}>Couldn’t load history.</div></div>;
  if (!history) return null;

  // Nothing to compare against - the comment was edited before history tracking
  if (history.revisions.length === 0) {
    return (
      <div className={styles.history}>
        <div className={styles.historyEmpty}>
          This comment was edited before history was recorded, so earlier versions aren’t available.
        </div>
      </div>
    );
  }

  const versions = [
    { ...history.current, label: 'Current version' },
    ...history.revisions.map(r => ({ ...r, label: 'Earlier version' })),
  ];

  return (
    <div className={styles.history}>
      <div className={styles.historyTitle}>Edit history</div>
      <ol className={styles.historyList}>
        {versions.map((v, i) => (
          <li key={i} className={styles.historyItem}>
            <div className={styles.historyMeta}>
              <span className={styles.historyLabel}>{v.label}</span>
              <span className={styles.historyTime}>
                {i === 0 ? `edited ${commentDate(v.editedAt)}` : commentDate(v.editedAt)}
              </span>
              <span className={`${styles.visTag} ${styles[`visTag_${v.visibility}`]}`}>
                {VIS_META[v.visibility].tag}
              </span>
            </div>
            {v.title && <div className={styles.commentTitle}>{v.title}</div>}
            {/* Sanitized server-side on write, same as live comment bodies */}
            <div className={styles.historyBody} dangerouslySetInnerHTML={{ __html: v.body }} />
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function CommentsPanel({
  articleUrl, articleTitle, prefs, onCountChange, legacyNote, onLegacyNoteMigrated, onViewProfile, readOnly,
  focusCommentId,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [comments, setComments] = useState<ArticleComment[]>([]);
  const [composing, setComposing] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const migratedRef = useRef(false);
  const legacyRef = useRef({ legacyNote, onLegacyNoteMigrated });
  legacyRef.current = { legacyNote, onLegacyNoteMigrated };
  const countRef = useRef(onCountChange);
  countRef.current = onCountChange;

  const publish = useCallback((tree: ArticleComment[]) => {
    setComments(tree);
    countRef.current?.(articleUrl, countTree(tree));
  }, [articleUrl]);

  const fetchThread = useCallback(async (): Promise<ArticleComment[] | null> => {
    try {
      const data = await apiGet<{ comments: ArticleComment[] }>(
        `/api/v1/comments?url=${encodeURIComponent(articleUrl)}`
      );
      return data.comments ?? [];
    } catch {
      return null;
    }
  }, [articleUrl]);

  // Load on mount, folding in any pre-comments note
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      let tree = await fetchThread();
      if (tree === null) {
        if (!cancelled) { setError('Could not load comments'); setLoading(false); }
        return;
      }
      const { legacyNote: note, onLegacyNoteMigrated: done } = legacyRef.current;
      if (note && note.trim() && !migratedRef.current) {
        migratedRef.current = true;
        try {
          await apiPost('/api/v1/comments', {
            url: articleUrl,
            articleTitle,
            body: textToHtml(note.trim()),
            visibility: 'private',
          });
          const refreshed = await fetchThread();
          if (refreshed) tree = refreshed;
          done?.();
        } catch {
          // Keeping the note on the item is the safe failure - it is not lost
          migratedRef.current = false;
        }
      }
      if (cancelled) return;
      publish(tree);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [articleUrl, articleTitle, fetchThread, publish]);

  // Scroll to the comment the reader was opened from, and flash it so it is
  // obvious which one that was. Runs once the thread has rendered - `comments`
  // is in the deps rather than `loading`, because the nodes don't exist until
  // the tree is on screen. The class is removed on a timer rather than left to
  // an animation end event, so a re-render mid-flash can't strand it.
  //
  // Replies render expanded, so a nested comment needs no unfolding to be found.
  useEffect(() => {
    if (!focusCommentId || comments.length === 0) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(focusCommentId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add(styles.focused);
    const t = setTimeout(() => el.classList.remove(styles.focused), 2400);
    return () => clearTimeout(t);
  }, [focusCommentId, comments]);

  const reload = useCallback(async () => {
    const tree = await fetchThread();
    if (tree) publish(tree);
  }, [fetchThread, publish]);

  async function submitRoot(v: { title: string; body: string; visibility: CommentVisibility }) {
    setBusyId('new');
    try {
      await apiPost('/api/v1/comments', {
        url: articleUrl, articleTitle,
        title: v.title || undefined, body: v.body, visibility: v.visibility,
      });
      setComposing(false);
      await reload();
    } catch {
      setError('Could not post comment');
    } finally {
      setBusyId(null);
    }
  }

  async function submitReply(parentId: string, v: { body: string; visibility: CommentVisibility }) {
    setBusyId(parentId);
    try {
      await apiPost('/api/v1/comments', {
        url: articleUrl, articleTitle, parentId, body: v.body, visibility: v.visibility,
      });
      setReplyTo(null);
      await reload();
    } catch {
      setError('Could not post reply');
    } finally {
      setBusyId(null);
    }
  }

  async function submitEdit(id: string, v: { title: string; body: string; visibility: CommentVisibility }) {
    setBusyId(id);
    try {
      await apiPatch(`/api/v1/comments/${id}`, {
        title: v.title || null, body: v.body, visibility: v.visibility,
      });
      setEditing(null);
      await reload();
    } catch {
      setError('Could not save comment');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    try {
      await apiDelete(`/api/v1/comments/${id}`);
      await reload();
    } catch {
      setError('Could not delete comment');
    } finally {
      setBusyId(null);
    }
  }

  // Moderation goes through the admin endpoint, not the author's own delete -
  // that route is what writes the AdminAction row, so removing a comment from
  // here lands in the audit log exactly as it would from the admin panel.
  async function moderate(id: string) {
    setBusyId(id);
    try {
      await apiDelete(`/api/v1/admin/comments/${id}`);
      await reload();
    } catch {
      setError('Could not remove comment');
    } finally {
      setBusyId(null);
    }
  }

  function cancelAll() {
    setReplyTo(null);
    setEditing(null);
  }

  const total = countTree(comments);

  return (
    <section className={styles.panel} ref={rootRef}>
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>
          Comments
          {total > 0 && <span className={styles.panelCount}>{total}</span>}
        </h2>
        {readOnly && <span className={styles.readOnlyHint}>Sign in to join the conversation</span>}
      </div>

      {/* The resting composer. A field to click into and a button that names the
          action, rather than an "Add comment" button that hid the writing
          surface behind a step. Both halves do the same thing - the field is
          what a reader aims at, the button is what they look for. */}
      {!composing && !loading && !readOnly && (
        <div className={styles.promptRow}>
          <button
            type="button"
            className={styles.promptField}
            onClick={() => setComposing(true)}
          >
            Add a comment…
          </button>
          <button
            type="button"
            className={styles.promptBtn}
            onClick={() => setComposing(true)}
          >
            Comment
          </button>
        </div>
      )}

      {loading && (
        <div className={styles.skeleton}>
          <span className={styles.skelLine} />
          <span className={`${styles.skelLine} ${styles.skelShort}`} />
        </div>
      )}
      {error && <div className={styles.statusError}>{error}</div>}

      {!loading && comments.length === 0 && !composing && (
        <div className={styles.empty}>
          <CommentIcon />
          {/* The invitation to write now lives in the prompt above, so this
              says only what it knows. */}
          <span>No comments yet.</span>
        </div>
      )}

      {composing && (
        <Composer
          allowTitle
          autoFocusBody
          defaultVisibility={prefs.defaultVisibility}
          submitLabel="Post comment"
          busy={busyId === 'new'}
          onSubmit={submitRoot}
          onCancel={() => setComposing(false)}
        />
      )}

      {comments.length > 0 && (
        <div className={styles.thread}>
          {comments.map(c => (
            <CommentItem
              key={c.id}
              node={c}
              depth={0}
              prefs={prefs}
              busyId={busyId}
              replyTo={replyTo}
              editing={editing}
              onReply={id => { setEditing(null); setReplyTo(id); }}
              onEdit={id => { setReplyTo(null); setEditing(id); }}
              onDelete={remove}
              onModerate={moderate}
              onSubmitReply={submitReply}
              onSubmitEdit={submitEdit}
              onCancel={cancelAll}
              onViewProfile={onViewProfile}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// Marks an action as moderator-only, so it never reads as an ordinary control
function ShieldIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

// The two rows behind the comment pill's caret. Same glyphs as the buttons at
// the foot of the reader, so a reader who has met them there recognises them
// here - they are the same two actions, reached earlier.
function ExploreIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function RepostIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

// GlobeIcon / LockIcon / FriendsIcon now live in VisibilityMeta alongside the
// tier labels they belong to.
