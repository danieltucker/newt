import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../services/api';
import { formatBytes } from '../utils/formatBytes';
import { useMediaQuery } from '../hooks/useMediaQuery';
import styles from './AdminModal.module.css';

interface HistoryPoint { date: string; total: number }

interface VisibilityCounts { public: number; friends: number; private: number }

interface AdminStats {
  totals: {
    users: number;
    admins: number;
    totpUsers: number;
    bookmarks: number;
    folders: number;
    readingItems: number;
    feedArticles: number;
    comments: number;
    deletedComments: number;
    commentReplies: number;
    commentEdits: number;
    blogPosts: number;
    publishedPosts: number;
    images: number;
    imageBytes: number;
    friendships: number;
    blocks: number;
    openReports: number;
  };
  activeUsers7d: number;
  signups: { date: string; count: number }[];
  history: {
    users: HistoryPoint[];
    bookmarks: HistoryPoint[];
    comments: HistoryPoint[];
    blogPosts: HistoryPoint[];
  };
  visibility: {
    comments: VisibilityCounts;
    blogPosts: VisibilityCounts;
  };
}

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  isAdmin: boolean;
  bannedAt: string | null;
  totpEnabled: boolean;
  createdAt: string;
  bookmarks: number;
  folders: number;
  readingItems: number;
  comments: number;
  blogPosts: number;
  lastActiveAt: string | null;
}

interface AdminComment {
  id: string;
  author: string;
  articleTitle: string;
  articleUrl: string;
  title: string | null;
  snippet: string;
  visibility: string;
  isReply: boolean;
  replies: number;
  edits: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AdminBlogPost {
  id: string;
  author: string;
  title: string;
  slug: string;
  excerpt: string;
  visibility: string;
  commentsEnabled: boolean;
  url: string;
  comments: number;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

import { summarizeMetadata } from '../utils/auditMetadata';
import { ModerationReport, ReportStatus, AdminThread, AdminThreadComment } from '../types';

type Tab = 'overview' | 'users' | 'reports' | 'comments' | 'blog' | 'feeds' | 'errors' | 'audit';

// Sits beside the audit log in the nav but is its opposite: the audit trail is
// what admins did and is kept forever, this is what broke and ages out.
interface ErrorEntry {
  id: string;
  source: 'server' | 'feed';
  message: string;
  detail: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  // Who hit it. Null for a feed error, and for anything an anonymous request
  // triggered - which is itself worth seeing, so it renders as "anonymous"
  // rather than being hidden.
  username: string | null;
  feedUrl: string | null;
  createdAt: string;
}

// The standing health of one feed, as opposed to the individual failures
// ErrorEntry records. A feed appears here only while it is currently failing.
interface FeedHealth {
  id: string;
  url: string;
  title: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  /** Has crossed the threshold at which admins are alerted. */
  alerting: boolean;
}

// A feed as the Feeds tab lists it - every feed the instance polls, not only the
// broken ones. `subscribers` counts people, not subscription rows: two spellings
// of one URL are one feed here, the same way the refresher treats them.
interface AdminFeed {
  id: string;
  url: string;
  title: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastRequestedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  subscribers: number;
  items: number;
  /** Nobody has opened it inside the demand window, so the scheduler skips it. */
  dormant: boolean;
  /** Set means nothing polls it. Never automatic-and-destructive: see below. */
  disabledAt: string | null;
  /**
   * 'failing' - switched itself off after too many consecutive failures.
   * 'blocked' - its host matches a block rule.
   * 'manual'  - an admin pressed the button.
   */
  disabledReason: 'failing' | 'blocked' | 'manual' | null;
}

// A host this instance refuses to poll. 'domain' covers the host and its
// subdomains; 'suffix' covers a whole extension (.xyz). `feeds` is how many
// stored feeds the rule currently matches - the only way to tell a rule that
// did what was intended from one whose pattern was subtly wrong.
interface BlockedDomain {
  id: string;
  pattern: string;
  kind: 'domain' | 'suffix';
  note: string;
  createdByUsername: string;
  createdAt: string;
  feeds: number;
}

// Which column the feed list is ordered by. Server-side, since the list pages -
// sorting only what has been loaded would order a page, not the list.
type FeedSort = 'checked' | 'success' | 'requested' | 'failures' | 'title' | 'url' | 'subscribers' | 'articles';
type FeedStatus = 'all' | 'healthy' | 'failing' | 'disabled' | 'blocked' | 'dormant';

const FEED_STATUS_LABELS: Record<FeedStatus, string> = {
  all: 'All',
  healthy: 'Healthy',
  failing: 'Failing',
  disabled: 'Switched off',
  blocked: 'Blocked',
  dormant: 'Dormant',
};

// One refresh attempt. 'unchanged' is a 304 - the origin was reached and had
// nothing new, which is most of what a healthy instance does and is why the log
// is worth having: a feed with no entries at all is not being polled.
interface FeedLogEntry {
  id: string;
  feedId: string;
  feedUrl: string;
  feedTitle: string;
  outcome: 'success' | 'unchanged' | 'failed';
  status: number | null;
  durationMs: number;
  items: number | null;
  newItems: number | null;
  error: string | null;
  createdAt: string;
}

// One entry in the moderation record. `metadata` is whatever the server thought
// worth preserving for that action - shape varies by action, so it's rendered
// generically rather than typed per-verb.
interface AuditEntry {
  id: string;
  actor: string;
  actorExists: boolean;
  action: string;
  label: string;
  destructive: boolean;
  targetType: string;
  targetId: string;
  targetLabel: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// A column header that sorts the feed list. The arrow marks the active column
// and its direction; inactive headers stay unmarked rather than showing a
// neutral glyph, so which column is in force is readable at a glance.
function SortableTh({ label, sortKey, active, dir, onSort }: {
  label: string;
  sortKey: FeedSort;
  active: FeedSort;
  dir: 'asc' | 'desc';
  onSort: (key: FeedSort) => void;
}) {
  const isActive = active === sortKey;
  return (
    <th>
      <button
        type="button"
        className={`${styles.sortHeader} ${isActive ? styles.sortHeaderActive : ''}`}
        onClick={() => onSort(sortKey)}
        // Announced rather than left to the arrow, which is decorative to a
        // screen reader and says nothing about what pressing this would do.
        aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {isActive && <span className={styles.sortArrow} aria-hidden="true">{dir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  );
}

const TAB_TITLES: Record<Tab, string> = {
  overview: 'Overview',
  users: 'Users',
  reports: 'Reports',
  comments: 'Comments',
  blog: 'Posts',
  feeds: 'Feeds',
  errors: 'Errors',
  audit: 'Audit log',
};

interface Props {
  currentUsername: string;
  onClose: () => void;
  // Open a person's public profile. Closes the panel on the way - the profile
  // renders in the shell underneath it.
  onViewProfile?: (username: string) => void;
  // Set when the panel was opened from a report alert in the bell: show that
  // one report instead of the queue. Fetched by id rather than looked for in the
  // queue, because by now it may be handled (so filtered out) or several pages
  // down.
  focusReportId?: string | null;
  onClearFocusReport?: () => void;
}

function formatDate(s: string | null): string {
  if (!s) return '-';
  return new Date(s).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The api helpers throw with the raw response body as the message, which for
// this server is a JSON envelope. Several feed actions fail for reasons only the
// server knows ("still covered by a block rule"), and showing the reader
// `{"error":"..."}` would waste the one sentence that explains what happened.
function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback;
  try {
    const parsed = JSON.parse(err.message) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch { /* not JSON — fall through to the raw message */ }
  return err.message.slice(0, 300) || fallback;
}

function relativeDate(s: string | null): string {
  if (!s) return 'never';
  const diff = Date.now() - new Date(s).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return formatDate(s);
}

// Minutes matter in the refresh log the way days do in the other tables: entries
// land every few minutes, and stamping the whole page "today" would say nothing
// about the thing being asked - when this feed was last actually fetched.
function relativeTime(s: string | null): string {
  if (!s) return 'never';
  const mins = Math.floor((Date.now() - new Date(s).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return relativeDate(s);
}

// How long a fetch took. Sub-second in milliseconds because that's the range
// most fetches sit in; above that, seconds - an 8.0s row is the fetch timeout
// and reads as one at a glance.
function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// A person's handle, anywhere it appears in the panel. Routes to their public
// profile when there's somewhere to route to - a moderator looking at a row
// almost always wants the rest of what that account has been doing, and every
// other surface in the app already links a username.
//
// Falls back to plain text rather than a dead button when the panel is rendered
// without a navigator, and for an account that has since been deleted (its name
// survives in an audit row, but there is no profile behind it any more).
function Handle({ username, exists = true, onView }: {
  username: string;
  exists?: boolean;
  onView?: (username: string) => void;
}) {
  if (!onView || !exists) return <>@{username}</>;
  return (
    <button type="button" className={styles.userLink} onClick={() => onView(username)} title={`View @${username}`}>
      @{username}
    </button>
  );
}

// What a moderation delete actually did. A comment holding replies is kept as a
// content-less tombstone so the thread below it survives; one without replies is
// removed outright. The thread view has to show these differently - reporting a
// hard delete as "removed, its replies remain" would describe replies that never
// existed.
type RemovalOutcome = 'tombstoned' | 'removed' | null;

// ── Thread view ─────────────────────────────────────────────────────────────
// The conversation a comment sits in, unfiltered. A reported comment read on its
// own is often unjudgeable - "you too" is a pleasantry or an insult depending
// entirely on what it answers - and the report's snapshot can only hold the one
// comment.

function CommentThread({ commentId, url, highlightId, onViewProfile, onRemove }: {
  // Either identifies the thread. `url` is the fallback for a report whose
  // comment has since been deleted, which is exactly when context matters most.
  commentId?: string;
  url?: string | null;
  highlightId?: string;
  onViewProfile?: (username: string) => void;
  onRemove?: (id: string) => Promise<RemovalOutcome>;
}) {
  const [thread, setThread] = useState<AdminThread | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [removingId, setRemovingId] = useState<string | null>(null);

  const query = commentId
    ? `commentId=${encodeURIComponent(commentId)}`
    : `url=${encodeURIComponent(url ?? '')}`;

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    apiGet<AdminThread>(`/api/v1/admin/comments/thread?${query}`)
      .then(d => { if (!cancelled) { setThread(d); setState('ready'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [query]);

  async function remove(id: string) {
    if (!onRemove) return;
    setRemovingId(id);
    // Mirror what the server did rather than refetching - the rest of the
    // thread is unchanged either way.
    const outcome = await onRemove(id);
    if (outcome === 'tombstoned') {
      setThread(prev => prev && {
        ...prev,
        comments: tombstone(prev.comments, id),
        total: prev.total - 1,
      });
    } else if (outcome === 'removed') {
      setThread(prev => prev && {
        ...prev,
        comments: pruneComment(prev.comments, id),
        total: prev.total - 1,
      });
    }
    setRemovingId(null);
  }

  if (state === 'loading') return <div className={styles.threadNote}>Loading thread…</div>;
  if (state === 'error' || !thread) return <div className={styles.threadNote}>Couldn’t load the thread.</div>;
  if (thread.comments.length === 0) {
    return <div className={styles.threadNote}>This thread is empty - every comment on it has been removed.</div>;
  }

  return (
    <div className={styles.thread}>
      <div className={styles.threadHead}>
        {thread.articleUrl
          ? <a className={styles.reportLink} href={thread.articleUrl} target="_blank" rel="noopener noreferrer">
              {thread.articleTitle || thread.articleUrl}
            </a>
          : <span>{thread.articleTitle || 'Thread'}</span>}
        <span className={styles.threadCount}>{thread.total} comment{thread.total === 1 ? '' : 's'}</span>
      </div>
      <ThreadNodes
        nodes={thread.comments}
        depth={0}
        highlightId={highlightId}
        removingId={removingId}
        onViewProfile={onViewProfile}
        onRemove={onRemove ? remove : undefined}
      />
    </div>
  );
}

// Empties a comment but keeps it in the tree, holding its replies up - what
// deleteCommentPreservingThread does to a comment that has any.
function tombstone(nodes: AdminThreadComment[], id: string): AdminThreadComment[] {
  return nodes.map(n => (n.id === id
    ? { ...n, deleted: true, body: '', title: null }
    : { ...n, replies: tombstone(n.replies, id) }));
}

// Drops a comment from the tree entirely - what happens to one with no replies.
// Its (empty) reply list is spliced in rather than discarded: the server only
// hard-deletes a leaf, so there is nothing to promote, but doing it this way
// means a race that added a reply mid-request loses nothing on screen.
function pruneComment(nodes: AdminThreadComment[], id: string): AdminThreadComment[] {
  return nodes.flatMap(n => (n.id === id
    ? n.replies
    : [{ ...n, replies: pruneComment(n.replies, id) }]));
}

function ThreadNodes({ nodes, depth, highlightId, removingId, onViewProfile, onRemove }: {
  nodes: AdminThreadComment[];
  depth: number;
  highlightId?: string;
  removingId: string | null;
  onViewProfile?: (username: string) => void;
  onRemove?: (id: string) => void;
}) {
  return (
    <>
      {nodes.map(n => (
        <div key={n.id} className={styles.threadItem} style={{ marginLeft: depth === 0 ? 0 : 14 }}>
          <div className={`${styles.threadComment} ${n.id === highlightId ? styles.threadHighlight : ''} ${n.deleted ? styles.threadDeleted : ''}`}>
            <div className={styles.threadMeta}>
              <Handle username={n.author} onView={onViewProfile} />
              <VisibilityChip visibility={n.visibility} />
              {n.edits > 0 && <span className={styles.threadEdits}>{n.edits} edit{n.edits === 1 ? '' : 's'}</span>}
              {n.id === highlightId && <span className={styles.threadReported}>reported</span>}
              <span className={styles.threadWhen} title={new Date(n.createdAt).toLocaleString()}>
                {relativeDate(n.createdAt)}
              </span>
              {/* A tombstone has no content left to remove */}
              {onRemove && !n.deleted && (
                <button
                  className={styles.threadRemove}
                  disabled={removingId === n.id}
                  onClick={() => onRemove(n.id)}
                  title="Remove this comment. Replies below it survive."
                >
                  {removingId === n.id ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
            {n.deleted ? (
              <div className={styles.threadBodyGone}>This comment was removed. Its replies remain.</div>
            ) : (
              <>
                {n.title && <div className={styles.threadTitle}>{n.title}</div>}
                {/* Sanitized server-side on write - see sanitizeCommentHtml */}
                <div className={styles.threadBody} dangerouslySetInnerHTML={{ __html: n.body }} />
              </>
            )}
          </div>
          {n.replies.length > 0 && (
            <ThreadNodes
              nodes={n.replies}
              depth={depth + 1}
              highlightId={highlightId}
              removingId={removingId}
              onViewProfile={onViewProfile}
              onRemove={onRemove}
            />
          )}
        </div>
      ))}
    </>
  );
}

// ── One report ──────────────────────────────────────────────────────────────
// Shared by the queue and the single-report view the bell's alert opens, so the
// two can't drift into showing different things about the same report.
function ReportCard({ report: r, busy, threadOpen, onToggleThread, onResolve, onViewProfile, onRemoveComment }: {
  report: ModerationReport;
  busy: boolean;
  threadOpen: boolean;
  onToggleThread: () => void;
  onResolve: (r: ModerationReport, status: 'resolved' | 'dismissed') => void;
  onViewProfile?: (username: string) => void;
  onRemoveComment: (id: string) => Promise<RemovalOutcome>;
}) {
  return (
    <div className={styles.reportCard}>
      <div className={styles.reportHead}>
        <span className={styles.reportCategory}>{r.categoryLabel}</span>
        <span className={styles.reportKind}>
          {r.targetType === 'blogPost' ? 'post' : r.targetType}
        </span>
        {/* One report is an incident; the fifth about the same person is a
            pattern worth seeing without a search. */}
        {r.reportsAgainstSubject > 1 && (
          <span
            className={styles.reportRepeat}
            title={`@${r.subject} has been reported ${r.reportsAgainstSubject} times in total`}
          >
            {r.reportsAgainstSubject}× reported
          </span>
        )}
        {r.status !== 'open' && (
          <span className={`${styles.reportStatus} ${r.status === 'resolved' ? styles.reportUpheld : styles.reportDismissed}`}>
            {r.status === 'resolved' ? 'Upheld' : 'Dismissed'}
            {r.resolvedBy && ` by @${r.resolvedBy}`}
          </span>
        )}
        <span className={styles.reportWhen} title={new Date(r.createdAt).toLocaleString()}>
          {relativeDate(r.createdAt)}
        </span>
      </div>

      <div className={styles.reportTarget}>
        {r.targetUrl
          ? <a className={styles.reportLink} href={r.targetUrl} target="_blank" rel="noopener noreferrer">{r.targetLabel}</a>
          : r.targetLabel}
      </div>

      {/* The content as it read when reported, so the report can still be judged
          after an edit or a delete. */}
      {r.snapshot && <div className={styles.reportSnapshot}>{r.snapshot}</div>}

      {r.note && (
        <div className={styles.reportNote}>
          <span className={styles.reportNoteLabel}>Reporter said:</span> {r.note}
        </div>
      )}

      {/* Only a comment has a conversation around it. A post report already
          links to the post, where the thread is on the page. */}
      {r.targetType === 'comment' && (
        <button className={styles.threadToggle} onClick={onToggleThread} aria-expanded={threadOpen}>
          {threadOpen ? '▾ Hide thread' : '▸ View thread'}
        </button>
      )}
      {threadOpen && r.targetType === 'comment' && (
        <CommentThread
          commentId={r.targetId}
          url={r.targetUrl}
          highlightId={r.targetId}
          onViewProfile={onViewProfile}
          onRemove={onRemoveComment}
        />
      )}

      <div className={styles.reportFoot}>
        <span className={styles.reportMeta}>
          <Handle username={r.subject} exists={r.subjectExists} onView={onViewProfile} />
          {!r.subjectExists && <span className={styles.mutedText}> (deleted)</span>}
          {' reported by '}
          <Handle username={r.reporter} exists={r.reporterExists} onView={onViewProfile} />
          {!r.reporterExists && <span className={styles.mutedText}> (deleted)</span>}
        </span>
        {r.status === 'open' && (
          <span className={styles.reportBtns}>
            <button
              className={`${styles.adminToggle} ${styles.banBtn}`}
              disabled={busy}
              onClick={() => onResolve(r, 'resolved')}
              title="This report is valid - I've acted on it, or I'm about to"
            >
              {busy ? 'Saving…' : 'Uphold'}
            </button>
            <button
              className={styles.adminToggle}
              disabled={busy}
              onClick={() => onResolve(r, 'dismissed')}
              title="No action needed"
            >
              Dismiss
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

const VISIBILITY_ORDER = ['public', 'friends', 'private'] as const;

function VisibilityChip({ visibility }: { visibility: string }) {
  const cls = visibility === 'public' ? styles.visPublic
    : visibility === 'friends' ? styles.visFriends
    : styles.visPrivate;
  return <span className={`${styles.visChip} ${cls}`}>{visibility}</span>;
}

/* Stacked bar of the public/friends/private split, with a matching legend */
function VisibilityMeter({ counts }: { counts: VisibilityCounts }) {
  const total = VISIBILITY_ORDER.reduce((n, k) => n + counts[k], 0);
  return (
    <div className={styles.meterBlock}>
      <div className={styles.meterTrack}>
        {total === 0
          ? <div className={styles.meterEmpty} />
          : VISIBILITY_ORDER.map(k => counts[k] > 0 && (
              <div
                key={k}
                className={`${styles.meterFill} ${k === 'public' ? styles.visPublic : k === 'friends' ? styles.visFriends : styles.visPrivate}`}
                style={{ width: `${(counts[k] / total) * 100}%` }}
                title={`${k}: ${counts[k]}`}
              />
            ))}
      </div>
      <div className={styles.meterLegend}>
        {VISIBILITY_ORDER.map(k => (
          <span key={k} className={styles.meterLegendItem}>
            <i className={`${styles.meterSwatch} ${k === 'public' ? styles.visPublic : k === 'friends' ? styles.visFriends : styles.visPrivate}`} />
            {k} <strong>{counts[k]}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

/* Trend over the window: % change when there's a baseline, absolute otherwise */
function TrendBadge({ points }: { points: HistoryPoint[] }) {
  const first = points[0]?.total ?? 0;
  const last = points[points.length - 1]?.total ?? 0;
  const delta = last - first;

  let text: string;
  if (first === 0) text = delta > 0 ? `+${delta} new` : 'no change';
  else {
    const pct = (delta / first) * 100;
    text = `${pct >= 0 ? '+' : ''}${Math.abs(pct) < 10 ? pct.toFixed(1) : Math.round(pct)}% (90d)`;
  }
  const cls = delta > 0 ? styles.trendUp : delta < 0 ? styles.trendDown : styles.trendFlat;
  return <span className={`${styles.trendBadge} ${cls}`}>{text}</span>;
}

/* ── Chart hover ─────────────────────────────────────────────────────────────
   Both charts had a `<title>` on the last point and on each bar, which is the
   cheapest tooltip there is and not really one: it only appears over the mark
   itself (a 4px dot, or a bar 2px wide on a 90-day window), it waits out the
   browser's delay, and it can't be styled. So the answer to "how many users
   joined on that day" was a hit-testing exercise. This is a readout that
   follows the pointer anywhere over the plot and always names a day.

   The charts stretch with `preserveAspectRatio="none"`, so the x axis maps
   linearly from rendered pixels to viewBox units, and one fraction serves for
   both the SVG guide line and the HTML tooltip's `left`. That's the whole
   reason this can be a fraction rather than two coordinate systems. */

interface ChartHover { index: number; frac: number }

/**
 * @param count  number of data points
 * @param mode   'nearest' snaps to the closest point (a line's vertices);
 *               'band' picks the slot the pointer is inside (a bar's column).
 */
function useChartHover(count: number, mode: 'nearest' | 'band') {
  const [hover, setHover] = useState<ChartHover | null>(null);

  // Pointer events rather than mouse events: the same handler then covers a
  // finger on the touchscreen, where there is no hover at all and a tap is the
  // only way to ask.
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (count === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const index = mode === 'nearest'
      ? Math.round(frac * (count - 1))
      : Math.min(count - 1, Math.floor(frac * count));
    setHover({ index, frac });
  }

  return {
    hover,
    handlers: {
      onPointerMove,
      onPointerLeave: () => setHover(null),
      // A finger that has left the glass isn't pointing at anything any more,
      // and without this the readout stays stuck on a touchscreen.
      onPointerCancel: () => setHover(null),
    },
  };
}

function chartDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/** The floating readout. `frac` positions it; the ends flip it so it stays in. */
function ChartTooltip({ frac, label, value }: { frac: number; label: string; value: string }) {
  // Nudged rather than measured: at the edges the tooltip is anchored by its
  // near side instead of its centre, which keeps it inside the card without
  // needing to know how wide it came out.
  const align = frac < 0.15 ? 'translateX(0)'
    : frac > 0.85 ? 'translateX(-100%)'
    : 'translateX(-50%)';
  return (
    <div className={styles.chartTip} style={{ left: `${frac * 100}%`, transform: align }}>
      <span className={styles.chartTipValue}>{value}</span>
      <span className={styles.chartTipLabel}>{label}</span>
    </div>
  );
}

/* Hand-rolled line chart with area fill - one point per day */
function LineChart({ points, gradientId, noun }: {
  points: HistoryPoint[];
  gradientId: string;
  /** What one unit is, for the readout: "users", "bookmarks", "comments". */
  noun: string;
}) {
  const W = 600, H = 140, PAD_B = 18, PAD_T = 10;
  const totals = points.map(p => p.total);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const span = Math.max(1, max - min);
  const plotH = H - PAD_B - PAD_T;

  const x = (i: number) => (i / Math.max(1, points.length - 1)) * W;
  const y = (t: number) => PAD_T + plotH - ((t - min) / span) * plotH;

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ');
  const area = `0,${H - PAD_B} ${line} ${W},${H - PAD_B}`;
  const lastPt = points[points.length - 1];

  const { hover, handlers } = useChartHover(points.length, 'nearest');
  const hovered = hover ? points[hover.index] : null;

  return (
    <div className={styles.chartWrap} {...handlers}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} preserveAspectRatio="none" aria-label="Cumulative total over the last 90 days">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className={styles.areaTop} />
            <stop offset="100%" className={styles.areaBottom} />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline points={line} className={styles.line} fill="none" vectorEffect="non-scaling-stroke" />

        {/* The guide is drawn at the snapped point, not under the cursor: it has
            to agree with the number in the readout, or it reads as lag. */}
        {hovered && (
          <>
            <line
              x1={x(hover!.index)} y1={PAD_T} x2={x(hover!.index)} y2={H - PAD_B}
              className={styles.chartGuide} vectorEffect="non-scaling-stroke"
            />
            <circle cx={x(hover!.index)} cy={y(hovered.total)} r={4} className={styles.chartMarker} />
          </>
        )}

        {/* The end-of-series dot is redundant while a point is being inspected,
            and two dots on one line invite the question of which is which. */}
        {lastPt && !hovered && (
          <circle cx={W} cy={y(lastPt.total)} r={3.5} className={styles.lineDot} />
        )}

        {points.map((p, i) => (
          i % 30 === 0 && (
            <text key={p.date} x={Math.max(x(i), 24)} y={H - 4} className={styles.axisLabel} textAnchor="middle">
              {new Date(p.date + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' })}
            </text>
          )
        ))}
      </svg>

      {hovered && (
        <ChartTooltip
          frac={hover!.frac}
          label={chartDate(hovered.date)}
          value={`${hovered.total.toLocaleString()} ${noun}`}
        />
      )}
    </div>
  );
}

/* Hand-rolled bar chart - one bar per day, no chart library needed */
function SignupChart({ signups }: { signups: AdminStats['signups'] }) {
  const W = 600, H = 140, PAD_B = 18;
  const max = Math.max(1, ...signups.map(s => s.count));
  const barW = W / signups.length;

  const { hover, handlers } = useChartHover(signups.length, 'band');
  const hovered = hover ? signups[hover.index] : null;

  return (
    <div className={styles.chartWrap} {...handlers}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} preserveAspectRatio="none" aria-label="Signups per day, last 30 days">
        {/* Behind the bars: the highlight is a full-height band so a day with
            no signups still has something to point at. A zero bar is 1.5px
            tall, which is nothing to aim a cursor at and, on the day you most
            want to check, exactly what you'd be aiming at. */}
        {hover && (
          <rect
            x={hover.index * barW} y={0} width={barW} height={H - PAD_B}
            className={styles.chartBand}
          />
        )}
        {signups.map((s, i) => {
          const h = (s.count / max) * (H - PAD_B - 8);
          const x = i * barW;
          return (
            <g key={s.date}>
              <rect
                x={x + barW * 0.18}
                y={H - PAD_B - h}
                width={barW * 0.64}
                height={Math.max(h, s.count > 0 ? 3 : 1.5)}
                rx={2}
                className={`${s.count > 0 ? styles.bar : styles.barEmpty} ${hover?.index === i ? styles.barHover : ''}`}
              />
              {i % 7 === 0 && (
                <text x={x + barW / 2} y={H - 4} className={styles.axisLabel} textAnchor="middle">
                  {new Date(s.date + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hovered && (
        <ChartTooltip
          frac={hover!.frac}
          label={chartDate(hovered.date)}
          value={`${hovered.count} new ${hovered.count === 1 ? 'user' : 'users'}`}
        />
      )}
    </div>
  );
}

export default function AdminModal({
  currentUsername, onClose, onViewProfile, focusReportId, onClearFocusReport,
}: Props) {
  // Arriving from a report alert lands on the queue, not the overview.
  const [tab, setTab] = useState<Tab>(focusReportId ? 'reports' : 'overview');

  // Below this the 180px rail and a table of users can't share the width, so
  // the panel becomes a drill-down: the tab list, then one tab at a time with a
  // back button. Same shape and same breakpoint as Settings. A report alert
  // named its tab, so that one skips the list.
  const compact = useMediaQuery('(max-width: 720px)');
  const [showList, setShowList] = useState(!focusReportId);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [comments, setComments] = useState<AdminComment[]>([]);
  const [posts, setPosts] = useState<AdminBlogPost[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [errorCounts, setErrorCounts] = useState({ server: 0, feed: 0 });
  const [errorCursor, setErrorCursor] = useState<string | null>(null);
  const [errorsLoadingMore, setErrorsLoadingMore] = useState(false);
  const [errorSource, setErrorSource] = useState<'all' | 'server' | 'feed'>('all');
  const [retentionDays, setRetentionDays] = useState(30);
  const [feedHealth, setFeedHealth] = useState<FeedHealth[]>([]);
  const [feedTotals, setFeedTotals] = useState({ total: 0, healthy: 0 });
  // The Feeds tab: the searchable list of everything being polled, and the log
  // of refresh attempts underneath it.
  const [feedList, setFeedList] = useState<AdminFeed[]>([]);
  const [feedListTotal, setFeedListTotal] = useState(0);
  const [feedListNext, setFeedListNext] = useState<number | null>(null);
  const [feedListLoadingMore, setFeedListLoadingMore] = useState(false);
  const [feedFilter, setFeedFilter] = useState<FeedStatus>('all');
  // Sorted on the server for the same reason it is searched there: the list
  // pages, so ordering the loaded rows would order a page rather than the list.
  const [feedSort, setFeedSort] = useState<FeedSort>('checked');
  const [feedDir, setFeedDir] = useState<'asc' | 'desc'>('desc');
  // Searched on the server, so it can reach past the loaded page - the list is
  // every feed on the instance, and filtering only what's rendered would answer
  // "not found" for feeds that are plainly there.
  const [feedSearch, setFeedSearch] = useState('');
  const [dormantAfterDays, setDormantAfterDays] = useState(14);
  const [disableAfterFailures, setDisableAfterFailures] = useState(20);
  // The blocklist, and the feeds left switched off by rules that have since been
  // removed - those need a decision, so the panel has to be able to mention them.
  const [blockedDomains, setBlockedDomains] = useState<BlockedDomain[]>([]);
  const [orphanedBlocks, setOrphanedBlocks] = useState(0);
  const [blockPattern, setBlockPattern] = useState('');
  const [blockNote, setBlockNote] = useState('');
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState('');
  // Set while a per-feed action is in flight, so the row's buttons can be
  // disabled without freezing the whole table.
  const [feedBusy, setFeedBusy] = useState<string | null>(null);
  // Bumped by any action that changes what the feed list should contain. The
  // list is server-filtered and server-sorted, so a row cannot be patched in
  // place - disabling a feed may move it out of the active filter entirely.
  const [feedReloadKey, setFeedReloadKey] = useState(0);
  const [feedLog, setFeedLog] = useState<FeedLogEntry[]>([]);
  const [feedLogCursor, setFeedLogCursor] = useState<string | null>(null);
  const [feedLogLoadingMore, setFeedLogLoadingMore] = useState(false);
  const [feedLogOutcome, setFeedLogOutcome] = useState<'all' | 'success' | 'unchanged' | 'failed'>('all');
  // Set by "History" on a feed row: the same log, narrowed to one feed. Kept as
  // the whole feed rather than an id so the heading can name it without a lookup.
  const [feedLogFor, setFeedLogFor] = useState<AdminFeed | null>(null);
  const [feedLogSummary, setFeedLogSummary] = useState({ success: 0, unchanged: 0, failed: 0 });
  const [feedLogRetentionDays, setFeedLogRetentionDays] = useState(7);
  // Which stack trace is unrolled. One at a time - a trace is tall enough that
  // two open at once turns the table into scrolling.
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [reportCursor, setReportCursor] = useState<string | null>(null);
  const [reportsLoadingMore, setReportsLoadingMore] = useState(false);
  // The queue defaults to what's waiting; 'all' reads back through everything
  // already handled.
  const [reportFilter, setReportFilter] = useState<ReportStatus | 'all'>('open');
  const [openReports, setOpenReports] = useState(0);
  // The single report the bell sent us to, fetched by id. Null while it loads;
  // 'missing' once we know there's nothing there (deleted, or a stale alert).
  const [focused, setFocused] = useState<ModerationReport | 'missing' | null>(null);
  // Which comment's thread is expanded, keyed by the row or card that opened it
  // so two places can't fight over one piece of state.
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const [error, setError] = useState('');
  // The affirmative counterpart. Feed and blocklist actions have consequences
  // that aren't visible in the table they leave behind - "switched off 12 feeds"
  // is the whole outcome of adding a block rule, and silence would hide it.
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function copyToClipboard(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 1500);
    } catch { /* clipboard unavailable (e.g. insecure context) - ignore */ }
  }

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
      u.username.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)
    );
  }, [users, query]);

  const filteredComments = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return comments;
    return comments.filter(c =>
      c.author.toLowerCase().includes(q)
      || c.articleTitle.toLowerCase().includes(q)
      || (c.title ?? '').toLowerCase().includes(q)
      || c.snippet.toLowerCase().includes(q)
    );
  }, [comments, query]);

  const filteredAudit = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return audit;
    return audit.filter(e =>
      e.actor.toLowerCase().includes(q)
      || e.label.toLowerCase().includes(q)
      || e.action.toLowerCase().includes(q)
      || e.targetLabel.toLowerCase().includes(q)
    );
  }, [audit, query]);

  const filteredReports = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter(r =>
      r.subject.toLowerCase().includes(q)
      || r.reporter.toLowerCase().includes(q)
      || r.targetLabel.toLowerCase().includes(q)
      || r.categoryLabel.toLowerCase().includes(q)
      || r.note.toLowerCase().includes(q)
      || r.snapshot.toLowerCase().includes(q)
    );
  }, [reports, query]);

  const filteredPosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter(p =>
      p.author.toLowerCase().includes(q)
      || p.title.toLowerCase().includes(q)
      || p.excerpt.toLowerCase().includes(q)
    );
  }, [posts, query]);

  useEffect(() => {
    Promise.all([
      apiGet<AdminStats>('/api/v1/admin/stats'),
      apiGet<AdminUser[]>('/api/v1/admin/users'),
    ])
      .then(([s, u]) => { setStats(s); setUsers(u); setOpenReports(s.totals.openReports); })
      .catch(() => setError('Could not load admin data'));
  }, []);

  // Detail tables are fetched the first time their tab is opened - they're the
  // two heaviest payloads and most sessions only ever look at the overview.
  const [loadedComments, setLoadedComments] = useState(false);
  const [loadedPosts, setLoadedPosts] = useState(false);
  const [loadedAudit, setLoadedAudit] = useState(false);

  // The queue refetches whenever the status filter changes, so unlike the other
  // tabs it isn't guarded by a one-shot "loaded" flag.
  const reportsUrl = useMemo(
    () => `/api/v1/admin/reports${reportFilter === 'open' ? '' : `?status=${reportFilter}`}`,
    [reportFilter],
  );

  useEffect(() => {
    // The focused view shows one report fetched by id; loading the queue behind
    // it would be a wasted request the moderator never sees.
    if (tab !== 'reports' || focusReportId) return;
    let cancelled = false;
    apiGet<{ reports: ModerationReport[]; nextCursor: string | null }>(reportsUrl)
      .then(d => { if (!cancelled) { setReports(d.reports); setReportCursor(d.nextCursor); } })
      .catch(() => { if (!cancelled) setError('Could not load reports'); });
    return () => { cancelled = true; };
  }, [tab, reportsUrl, focusReportId]);

  useEffect(() => {
    if (!focusReportId) { setFocused(null); return; }
    // The initial tab state only covers a panel opened *by* the alert. If it was
    // already open on another tab, the alert has to move it - otherwise the
    // click appears to do nothing at all.
    setTab('reports');
    let cancelled = false;
    setFocused(null);
    apiGet<{ report: ModerationReport }>(`/api/v1/admin/reports/${encodeURIComponent(focusReportId)}`)
      .then(d => { if (!cancelled) setFocused(d.report); })
      // A report can legitimately be gone by the time the alert is clicked, so
      // this is an empty state rather than an error banner.
      .catch(() => { if (!cancelled) setFocused('missing'); });
    return () => { cancelled = true; };
  }, [focusReportId]);

  useEffect(() => {
    if (tab === 'comments' && !loadedComments) {
      setLoadedComments(true);
      apiGet<AdminComment[]>('/api/v1/admin/comments')
        .then(setComments)
        .catch(() => setError('Could not load comments'));
    }
    if (tab === 'blog' && !loadedPosts) {
      setLoadedPosts(true);
      apiGet<AdminBlogPost[]>('/api/v1/admin/blog-posts')
        .then(setPosts)
        .catch(() => setError('Could not load posts'));
    }
    if (tab === 'audit' && !loadedAudit) {
      setLoadedAudit(true);
      apiGet<{ entries: AuditEntry[]; nextCursor: string | null }>('/api/v1/admin/audit')
        .then(d => { setAudit(d.entries); setAuditCursor(d.nextCursor); })
        .catch(() => setError('Could not load the audit log'));
    }
  }, [tab, loadedComments, loadedPosts, loadedAudit]);

  // Unlike the tabs above, this one has no one-shot "loaded" guard: the source
  // filter goes to the server (the counts have to describe the whole log, not
  // the page), so switching it refetches - the same shape the report queue uses.
  useEffect(() => {
    if (tab !== 'errors') return;
    let cancelled = false;
    const q = errorSource === 'all' ? '' : `?source=${errorSource}`;
    apiGet<{
      entries: ErrorEntry[];
      counts: { server: number; feed: number };
      retentionDays: number;
      nextCursor: string | null;
    }>(`/api/v1/admin/errors${q}`)
      .then(d => {
        if (cancelled) return;
        setErrors(d.entries);
        setErrorCounts(d.counts);
        setRetentionDays(d.retentionDays);
        setErrorCursor(d.nextCursor);
      })
      .catch(() => { if (!cancelled) setError('Could not load the error log'); });
    return () => { cancelled = true; };
  }, [tab, errorSource]);

  // Feed health is standing state rather than a log, so it doesn't care about
  // the source filter. Fetched on mount rather than when the tab opens, because
  // the count badges the nav - a badge that only appears after you've visited
  // the tab is no use as the reason to visit it.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ feeds: FeedHealth[]; total: number; healthy: number }>('/api/v1/admin/feeds/health')
      .then(d => {
        if (cancelled) return;
        setFeedHealth(d.feeds);
        setFeedTotals({ total: d.total, healthy: d.healthy });
      })
      .catch(() => { if (!cancelled) setError('Could not load feed health'); });
    return () => { cancelled = true; };
  }, []);

  // Every query the feed list makes carries the same search, filter and sort -
  // built in one place so "load more" cannot drift from the query that produced
  // the rows it is appending to, which would interleave two different orderings.
  const feedQuery = useCallback((extra?: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (feedSearch.trim()) params.set('q', feedSearch.trim());
    if (feedFilter !== 'all') params.set('status', feedFilter);
    params.set('sort', feedSort);
    params.set('dir', feedDir);
    return params.toString();
  }, [feedSearch, feedFilter, feedSort, feedDir]);

  // The feed list searches, filters and sorts on the server, so every change
  // refetches rather than narrowing what's already loaded - a search that only
  // looked at the first page would report "no match" for feeds that are plainly
  // there. Debounced so holding a key down is one request, not twelve.
  //
  // `feedReloadKey` is bumped by the row actions: disabling a feed can move it
  // out of the current filter, so the list has to come back from the server
  // rather than be patched in place.
  useEffect(() => {
    if (tab !== 'feeds') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiGet<{
        feeds: AdminFeed[];
        total: number;
        nextOffset: number | null;
        dormantAfterDays: number;
        disableAfterFailures: number;
      }>(`/api/v1/admin/feeds?${feedQuery()}`)
        .then(d => {
          if (cancelled) return;
          setFeedList(d.feeds);
          setFeedListTotal(d.total);
          setFeedListNext(d.nextOffset);
          setDormantAfterDays(d.dormantAfterDays);
          setDisableAfterFailures(d.disableAfterFailures);
        })
        .catch(() => { if (!cancelled) setError('Could not load feeds'); });
    }, feedSearch ? 300 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tab, feedSearch, feedQuery, feedReloadKey]);

  // The blocklist. Reloaded alongside the feed list because the two are coupled:
  // adding a rule switches feeds off, and the rule's feed count is read from the
  // same table the list is showing.
  useEffect(() => {
    if (tab !== 'feeds') return;
    let cancelled = false;
    apiGet<{ rules: BlockedDomain[]; orphanedBlocks: number }>('/api/v1/admin/blocked-domains')
      .then(d => {
        if (cancelled) return;
        setBlockedDomains(d.rules);
        setOrphanedBlocks(d.orphanedBlocks);
      })
      .catch(() => { if (!cancelled) setError('Could not load the blocked domain list'); });
    return () => { cancelled = true; };
  }, [tab, feedReloadKey]);

  // The refresh log. Same shape as the error log: the outcome filter goes to the
  // server because the tallies have to describe the whole log rather than the
  // page, and narrowing to one feed is another server-side filter for the same
  // reason - its last check may be a hundred rows down.
  useEffect(() => {
    if (tab !== 'feeds') return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (feedLogOutcome !== 'all') params.set('outcome', feedLogOutcome);
    if (feedLogFor) params.set('feedId', feedLogFor.id);
    const qs = params.toString();
    apiGet<{
      entries: FeedLogEntry[];
      summary: { success: number; unchanged: number; failed: number };
      retentionDays: number;
      nextCursor: string | null;
    }>(`/api/v1/admin/feeds/log${qs ? `?${qs}` : ''}`)
      .then(d => {
        if (cancelled) return;
        setFeedLog(d.entries);
        setFeedLogSummary(d.summary);
        setFeedLogRetentionDays(d.retentionDays);
        setFeedLogCursor(d.nextCursor);
      })
      .catch(() => { if (!cancelled) setError('Could not load the feed log'); });
    return () => { cancelled = true; };
  }, [tab, feedLogOutcome, feedLogFor]);

  async function loadMoreFeeds() {
    if (feedListNext === null) return;
    setFeedListLoadingMore(true);
    try {
      const d = await apiGet<{ feeds: AdminFeed[]; total: number; nextOffset: number | null }>(
        `/api/v1/admin/feeds?${feedQuery({ offset: String(feedListNext) })}`);
      setFeedList(prev => [...prev, ...d.feeds]);
      setFeedListTotal(d.total);
      setFeedListNext(d.nextOffset);
    } catch {
      setError('Could not load more feeds');
    }
    setFeedListLoadingMore(false);
  }

  // Clicking a column header sorts by it; clicking the one already sorted flips
  // the direction. Each column starts in the direction that answers the question
  // it is there for - "most failures" and "most subscribers" descending, but
  // titles and URLs A-Z, where descending would be perverse as a first click.
  function sortFeedsBy(key: FeedSort) {
    if (feedSort === key) {
      setFeedDir(d => (d === 'desc' ? 'asc' : 'desc'));
      return;
    }
    setFeedSort(key);
    setFeedDir(key === 'title' || key === 'url' ? 'asc' : 'desc');
  }

  // ── Feed and blocklist actions ─────────────────────────────────────────────
  // All of them bump feedReloadKey rather than patching the row: an action can
  // move a feed out of the active filter (disabling one while 'Healthy' is
  // selected), and a locally-patched row would sit there contradicting it.

  async function feedAction(feed: AdminFeed, action: 'disable' | 'enable' | 'delete') {
    if (action === 'delete' && !window.confirm(
      `Delete "${feed.title || feed.url}"?\n\nThis removes the feed and its stored articles. `
      + `Anyone subscribed keeps the subscription, and the feed will be recreated if they open it again — `
      + `switch it off instead if you want it to stay gone.`,
    )) return;

    setFeedBusy(feed.id);
    try {
      if (action === 'delete') {
        await apiDelete(`/api/v1/admin/feeds/${feed.id}`);
      } else {
        await apiPost(`/api/v1/admin/feeds/${feed.id}/${action}`, {});
      }
      setFeedReloadKey(k => k + 1);
    } catch (err) {
      // The server's message is the informative one here - "still covered by a
      // block rule" is the whole reason an enable can fail.
      setError(errorText(err, `Could not ${action} that feed`));
    }
    setFeedBusy(null);
  }

  async function addBlockedDomain(e: React.FormEvent) {
    e.preventDefault();
    const pattern = blockPattern.trim();
    if (!pattern || blockBusy) return;
    setBlockBusy(true);
    setBlockError('');
    try {
      const d = await apiPost<{ rule: BlockedDomain; disabled: number }>(
        '/api/v1/admin/blocked-domains', { pattern, note: blockNote.trim() });
      setBlockPattern('');
      setBlockNote('');
      // Said out loud because it is the surprising half of the action: adding a
      // rule does not only gate new subscriptions, it switches off what is
      // already stored, and that should never be discovered afterwards.
      if (d.disabled > 0) {
        setNotice(`Blocked ${d.rule.pattern} and switched off ${d.disabled} ${d.disabled === 1 ? 'feed' : 'feeds'}`);
      } else {
        setNotice(`Blocked ${d.rule.pattern} — no stored feeds matched it`);
      }
      setFeedReloadKey(k => k + 1);
    } catch (err) {
      // Shown next to the field rather than in the panel-wide banner: it is
      // almost always "that isn't a valid pattern", which is about the input.
      setBlockError(errorText(err, 'Could not add that rule'));
    }
    setBlockBusy(false);
  }

  async function removeBlockedDomain(rule: BlockedDomain) {
    // Two questions, asked as two dialogs. A single confirm() has only OK and
    // Cancel, so folding "remove the rule?" and "and revive its feeds?" into one
    // makes Cancel mean both "don't revive" and "do nothing" — and whichever the
    // reader assumed, half the time it does the other.
    if (!window.confirm(
      `Unblock ${rule.pattern}?\n\nNew subscriptions to it will be allowed again.`,
    )) return;

    // Only worth asking when there is something to revive.
    const restore = rule.feeds > 0 && window.confirm(
      `Also switch its ${rule.feeds} ${rule.feeds === 1 ? 'feed' : 'feeds'} back on?\n\n`
      + `OK — start fetching them again.\n`
      + `Cancel — remove the rule but leave the feeds off.`,
    );

    setBlockBusy(true);
    try {
      const d = await apiDelete<{ restored: number }>(
        `/api/v1/admin/blocked-domains/${rule.id}${restore ? '?restore=1' : ''}`);
      setNotice(restore && d.restored > 0
        ? `Unblocked ${rule.pattern} and switched ${d.restored} ${d.restored === 1 ? 'feed' : 'feeds'} back on`
        : `Unblocked ${rule.pattern}`);
      setFeedReloadKey(k => k + 1);
    } catch {
      setError('Could not remove that rule');
    }
    setBlockBusy(false);
  }

  async function loadMoreFeedLog() {
    if (!feedLogCursor) return;
    setFeedLogLoadingMore(true);
    try {
      const params = new URLSearchParams({ cursor: feedLogCursor });
      if (feedLogOutcome !== 'all') params.set('outcome', feedLogOutcome);
      if (feedLogFor) params.set('feedId', feedLogFor.id);
      const d = await apiGet<{ entries: FeedLogEntry[]; nextCursor: string | null }>(
        `/api/v1/admin/feeds/log?${params.toString()}`);
      setFeedLog(prev => [...prev, ...d.entries]);
      setFeedLogCursor(d.nextCursor);
    } catch {
      setError('Could not load more of the feed log');
    }
    setFeedLogLoadingMore(false);
  }

  async function loadMoreErrors() {
    if (!errorCursor) return;
    setErrorsLoadingMore(true);
    try {
      const src = errorSource === 'all' ? '' : `source=${errorSource}&`;
      const d = await apiGet<{ entries: ErrorEntry[]; nextCursor: string | null }>(
        `/api/v1/admin/errors?${src}cursor=${encodeURIComponent(errorCursor)}`);
      setErrors(prev => [...prev, ...d.entries]);
      setErrorCursor(d.nextCursor);
    } catch {
      setError('Could not load more of the error log');
    }
    setErrorsLoadingMore(false);
  }

  async function loadMoreAudit() {
    if (!auditCursor) return;
    setAuditLoadingMore(true);
    try {
      const d = await apiGet<{ entries: AuditEntry[]; nextCursor: string | null }>(
        `/api/v1/admin/audit?cursor=${encodeURIComponent(auditCursor)}`);
      setAudit(prev => [...prev, ...d.entries]);
      setAuditCursor(d.nextCursor);
    } catch {
      setError('Could not load more of the audit log');
    }
    setAuditLoadingMore(false);
  }

  async function loadMoreReports() {
    if (!reportCursor) return;
    setReportsLoadingMore(true);
    try {
      const sep = reportsUrl.includes('?') ? '&' : '?';
      const d = await apiGet<{ reports: ModerationReport[]; nextCursor: string | null }>(
        `${reportsUrl}${sep}cursor=${encodeURIComponent(reportCursor)}`);
      setReports(prev => [...prev, ...d.reports]);
      setReportCursor(d.nextCursor);
    } catch {
      setError('Could not load more reports');
    }
    setReportsLoadingMore(false);
  }

  // Closing a report records the moderator's judgement and nothing else - the
  // content actions live on their own rows in the Comments and Blog tabs, each
  // writing its own audit entry. See PATCH /admin/reports/:id.
  async function resolveReport(r: ModerationReport, status: 'resolved' | 'dismissed') {
    setBusyId(r.id);
    try {
      await apiPatch(`/api/v1/admin/reports/${r.id}`, { status });
      setOpenReports(n => Math.max(0, n - 1));
      // On the open queue the row has left the list it's filtered to; anywhere
      // else it stays, restamped with what was decided.
      setReports(prev => reportFilter === 'open'
        ? prev.filter(x => x.id !== r.id)
        : prev.map(x => x.id === r.id
            ? { ...x, status, resolvedBy: currentUsername, resolvedAt: new Date().toISOString() }
            : x));
      // The focused view has nowhere to filter a row out to - it holds exactly
      // one report - so it restamps in place and keeps showing the outcome.
      setFocused(prev => (prev && prev !== 'missing' && prev.id === r.id
        ? { ...prev, status, resolvedBy: currentUsername, resolvedAt: new Date().toISOString() }
        : prev));
    } catch {
      setError('Could not update this report');
    } finally {
      setBusyId(null);
    }
  }

  // Removing a comment from inside a thread view. Goes through the same admin
  // endpoint the Comments tab uses, so it lands in the audit log identically -
  // the thread is a different way to reach the action, not a different action.
  //
  // Returns which of the two things the server did, so the thread can update
  // itself without a refetch: a comment holding replies is tombstoned in place,
  // one without them disappears entirely.
  async function removeThreadComment(id: string): Promise<RemovalOutcome> {
    try {
      const { deleted } = await apiDelete<{ ok: true; deleted: boolean }>(`/api/v1/admin/comments/${id}`);
      // Keep the Comments tab and the totals honest if they're already loaded.
      setComments(prev => deleted
        ? prev.map(x => x.id === id ? { ...x, deleted: true, snippet: '', title: null } : x)
        : prev.filter(x => x.id !== id));
      setStats(prev => prev ? {
        ...prev,
        totals: {
          ...prev.totals,
          comments: prev.totals.comments - 1,
          deletedComments: prev.totals.deletedComments + (deleted ? 1 : 0),
        },
      } : prev);
      return deleted ? 'tombstoned' : 'removed';
    } catch {
      setError('Could not remove that comment');
      return null;
    }
  }

  // Escape closes, and the page behind holds still while the panel is up -
  // it covers the whole screen at narrow widths, and scrolling a table to its
  // end should not then start scrolling the feed underneath.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  async function toggleBan(u: AdminUser) {
    setBusyId(u.id);
    try {
      await apiPatch(`/api/v1/admin/users/${u.id}/ban`, { banned: !u.bannedAt });
      setUsers(prev => prev.map(x => x.id === u.id
        ? { ...x, bannedAt: u.bannedAt ? null : new Date().toISOString() }
        : x));
    } catch {
      setError('Could not update ban status');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteUser(u: AdminUser) {
    setBusyId(u.id);
    try {
      await apiDelete(`/api/v1/admin/users/${u.id}`);
      setUsers(prev => prev.filter(x => x.id !== u.id));
      setStats(prev => prev ? {
        ...prev,
        totals: { ...prev.totals, users: prev.totals.users - 1 },
      } : prev);
    } catch {
      setError('Could not delete account');
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  }

  async function toggleAdmin(u: AdminUser) {
    setBusyId(u.id);
    try {
      await apiPatch(`/api/v1/admin/users/${u.id}/admin`, { isAdmin: !u.isAdmin });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, isAdmin: !u.isAdmin } : x));
      setStats(prev => prev ? {
        ...prev,
        totals: { ...prev.totals, admins: prev.totals.admins + (u.isAdmin ? -1 : 1) },
      } : prev);
    } catch {
      setError('Could not update admin status');
    } finally {
      setBusyId(null);
    }
  }

  // A comment holding replies becomes a tombstone rather than vanishing, so the
  // row stays in the table flagged as deleted. The server tells us which happened.
  async function deleteComment(c: AdminComment) {
    setBusyId(c.id);
    try {
      const { deleted } = await apiDelete<{ ok: true; deleted: boolean }>(`/api/v1/admin/comments/${c.id}`);
      setComments(prev => deleted
        ? prev.map(x => x.id === c.id ? { ...x, deleted: true, snippet: '', title: null } : x)
        : prev.filter(x => x.id !== c.id));
      setStats(prev => prev ? {
        ...prev,
        totals: {
          ...prev.totals,
          comments: prev.totals.comments - 1,
          deletedComments: prev.totals.deletedComments + (deleted ? 1 : 0),
        },
      } : prev);
    } catch {
      setError('Could not delete comment');
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  }

  async function unpublishPost(p: AdminBlogPost) {
    setBusyId(p.id);
    try {
      await apiPatch(`/api/v1/admin/blog-posts/${p.id}/visibility`, { visibility: 'private' });
      setPosts(prev => prev.map(x => x.id === p.id ? { ...x, visibility: 'private' } : x));
      setStats(prev => prev ? {
        ...prev,
        totals: { ...prev.totals, publishedPosts: prev.totals.publishedPosts - 1 },
      } : prev);
    } catch {
      setError('Could not unpublish post');
    } finally {
      setBusyId(null);
    }
  }

  function switchTab(next: Tab) {
    setTab(next);
    setShowList(false);
    setQuery('');
    setConfirmDeleteId(null);
    // An expanded thread belongs to the row that opened it; leaving it open
    // would reopen under whatever row happens to share that id on the next tab.
    setThreadFor(null);
    // Same for the log narrowed to one feed - it belongs to the row that opened
    // it, and coming back to the tab should show the whole timeline again.
    if (next !== 'feeds') setFeedLogFor(null);
    // Leaving the Reports tab abandons the single-report view the bell opened.
    if (next !== 'reports') onClearFocusReport?.();
  }

  const totalSignups30d = stats?.signups.reduce((n, s) => n + s.count, 0) ?? 0;

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${styles.panel} ${compact ? styles.compact : ''}`}>
        {(!compact || showList) && (
        <div className={styles.nav}>
          <div className={styles.navTop}>
            <div className={styles.navHeader}>Admin</div>
            {compact && (
              <button className={styles.iconBtn} onClick={onClose} aria-label="Close admin">✕</button>
            )}
          </div>
          <button className={`${styles.navItem} ${!compact && tab === 'overview' ? styles.navActive : ''}`} onClick={() => switchTab('overview')}>
            Overview
          </button>
          <button className={`${styles.navItem} ${!compact && tab === 'users' ? styles.navActive : ''}`} onClick={() => switchTab('users')}>
            Users
          </button>
          {/* Badged with the queue depth: the one tab where the number is the
              reason to open it, not a detail found once inside. */}
          <button className={`${styles.navItem} ${!compact && tab === 'reports' ? styles.navActive : ''}`} onClick={() => switchTab('reports')}>
            Reports
            {openReports > 0 && <span className={styles.navBadge}>{openReports}</span>}
          </button>
          <button className={`${styles.navItem} ${!compact && tab === 'comments' ? styles.navActive : ''}`} onClick={() => switchTab('comments')}>
            Comments
          </button>
          <button className={`${styles.navItem} ${!compact && tab === 'blog' ? styles.navActive : ''}`} onClick={() => switchTab('blog')}>
            Posts
          </button>
          {/* Badged like Reports, and for the same reason: a failing feed is
              work waiting, and the count is why you'd open the tab. The badge
              sits here rather than on Errors because a failing feed is still
              failing, whereas a recorded server error is already in the past. */}
          <button className={`${styles.navItem} ${!compact && tab === 'feeds' ? styles.navActive : ''}`} onClick={() => switchTab('feeds')}>
            Feeds
            {feedHealth.length > 0 && <span className={styles.navBadge}>{feedHealth.length}</span>}
          </button>
          <button className={`${styles.navItem} ${!compact && tab === 'errors' ? styles.navActive : ''}`} onClick={() => switchTab('errors')}>
            Errors
          </button>
          <button className={`${styles.navItem} ${!compact && tab === 'audit' ? styles.navActive : ''}`} onClick={() => switchTab('audit')}>
            Audit log
          </button>
        </div>
        )}

        {(!compact || !showList) && (
        <div className={styles.content}>
          <div className={styles.contentHeader}>
            {compact && (
              <button className={styles.backBtn} onClick={() => setShowList(true)}>
                <span aria-hidden>‹</span> Back
              </button>
            )}
            <span className={styles.title}>{TAB_TITLES[tab]}</span>
            <button className={styles.closeBtn} onClick={onClose}>
              ✕<span className={styles.closeLabel}>&nbsp;Close</span>
            </button>
          </div>

          {error && <div className={styles.error}>{error}</div>}
          {/* Dismissible rather than timed: "switched off 12 feeds" is a result
              worth reading twice, and a toast that vanishes is the wrong shape
              for something that changed what the server is doing. */}
          {notice && (
            <div className={styles.notice}>
              {notice}
              <button className={styles.noticeDismiss} onClick={() => setNotice('')} aria-label="Dismiss">✕</button>
            </div>
          )}

          {tab === 'overview' && stats && (
            <div className={styles.body}>
              <div className={styles.statGrid}>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.users}</span>
                  <span className={styles.statLabel}>Users</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.activeUsers7d}</span>
                  <span className={styles.statLabel}>Active (7d)</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.admins}</span>
                  <span className={styles.statLabel}>Admins</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.totpUsers}</span>
                  <span className={styles.statLabel}>With 2FA</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.bookmarks}</span>
                  <span className={styles.statLabel}>Bookmarks</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.readingItems}</span>
                  <span className={styles.statLabel}>Saved articles</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.comments}</span>
                  <span className={styles.statLabel}>Comments</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.blogPosts}</span>
                  <span className={styles.statLabel}>Posts</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.friendships}</span>
                  <span className={styles.statLabel}>Friendships</span>
                </div>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{stats.totals.blocks}</span>
                  <span className={styles.statLabel}>Blocks</span>
                </div>
                {/* Doubles as a nudge: a non-zero count here is work waiting,
                    so it links straight into the queue. */}
                <button className={styles.statCard} onClick={() => switchTab('reports')}>
                  <span className={styles.statValue}>{stats.totals.openReports}</span>
                  <span className={styles.statLabel}>Open reports</span>
                </button>
                {/* Same idea as Open reports above - a number that is only
                    interesting when it isn't zero, wired to the tab that
                    explains it. */}
                <button className={styles.statCard} onClick={() => switchTab('feeds')}>
                  <span className={styles.statValue}>{feedHealth.length}</span>
                  <span className={styles.statLabel}>Failing feeds</span>
                </button>
                <div className={styles.statCard}>
                  <span className={styles.statValue}>{formatBytes(stats.totals.imageBytes)}</span>
                  <span className={styles.statLabel}>Images ({stats.totals.images})</span>
                </div>
              </div>

              <div className={styles.chartBlock}>
                <div className={styles.chartTitle}>
                  New users - last 30 days
                  <span className={styles.chartTotal}>{totalSignups30d} total</span>
                </div>
                <SignupChart signups={stats.signups} />
              </div>

              <div className={styles.chartBlock}>
                <div className={styles.chartTitle}>
                  Total users - last 90 days
                  <TrendBadge points={stats.history.users} />
                </div>
                <LineChart points={stats.history.users} gradientId="admin-users-grad" noun="users" />
              </div>

              <div className={styles.chartBlock}>
                <div className={styles.chartTitle}>
                  Total bookmarks - last 90 days
                  <TrendBadge points={stats.history.bookmarks} />
                </div>
                <LineChart points={stats.history.bookmarks} gradientId="admin-bookmarks-grad" noun="bookmarks" />
              </div>

              <div className={styles.chartBlock}>
                <div className={styles.chartTitle}>
                  Total comments - last 90 days
                  <TrendBadge points={stats.history.comments} />
                </div>
                <LineChart points={stats.history.comments} gradientId="admin-comments-grad" noun="comments" />
                <VisibilityMeter counts={stats.visibility.comments} />
                <div className={styles.chartFacts}>
                  <span>{stats.totals.commentReplies} replies</span>
                  <span>{stats.totals.comments - stats.totals.commentReplies} top-level</span>
                  <span>{stats.totals.commentEdits} edits recorded</span>
                  <span>{stats.totals.deletedComments} deleted</span>
                </div>
              </div>

              <div className={styles.chartBlock}>
                <div className={styles.chartTitle}>
                  Total posts - last 90 days
                  <TrendBadge points={stats.history.blogPosts} />
                </div>
                <LineChart points={stats.history.blogPosts} gradientId="admin-blog-grad" noun="posts" />
                <VisibilityMeter counts={stats.visibility.blogPosts} />
                <div className={styles.chartFacts}>
                  <span>{stats.totals.publishedPosts} published</span>
                  <span>{stats.totals.blogPosts - stats.totals.publishedPosts} drafts</span>
                </div>
              </div>
            </div>
          )}

          {tab === 'users' && (
            <div className={styles.body}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search by username or email…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Joined</th>
                    <th>Last active</th>
                    <th className={styles.num}>Bookmarks</th>
                    <th className={styles.num}>Comments</th>
                    <th className={styles.num}>Posts</th>
                    <th>2FA</th>
                    <th>Admin</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(u => {
                    const isSelf = u.username === currentUsername;
                    const banned = !!u.bannedAt;
                    return (
                      <tr key={u.id} className={banned ? styles.bannedRow : ''}>
                        <td className={styles.userCell}>
                          <span
                            className={styles.copyable}
                            title="Click to copy"
                            onClick={() => copyToClipboard(u.username, `${u.id}-username`)}
                          >
                            {u.username}
                          </span>
                          {copiedKey === `${u.id}-username` && <span className={styles.copiedChip}>copied</span>}
                          {isSelf && <span className={styles.youBadge}>you</span>}
                          {banned && <span className={styles.bannedBadge}>banned</span>}
                          {/* The name itself stays click-to-copy - that's what
                              a moderator reaches for here. The profile gets its
                              own affordance rather than stealing that click. */}
                          {onViewProfile && (
                            <button
                              className={styles.profilePeek}
                              onClick={() => onViewProfile(u.username)}
                              title={`View @${u.username}'s profile`}
                              aria-label={`View @${u.username}'s profile`}
                            >
                              ↗
                            </button>
                          )}
                        </td>
                        <td className={styles.emailCell}>
                          {u.email ? (
                            <>
                              <span
                                className={styles.copyable}
                                title="Click to copy"
                                onClick={() => copyToClipboard(u.email!, `${u.id}-email`)}
                              >
                                {u.email}
                              </span>
                              {copiedKey === `${u.id}-email` && <span className={styles.copiedChip}>copied</span>}
                            </>
                          ) : '-'}
                        </td>
                        <td>{formatDate(u.createdAt)}</td>
                        <td>{relativeDate(u.lastActiveAt)}</td>
                        <td className={styles.num}>{u.bookmarks}</td>
                        <td className={styles.num}>{u.comments}</td>
                        <td className={styles.num}>{u.blogPosts}</td>
                        <td>{u.totpEnabled ? <span className={styles.badgeOn}>on</span> : <span className={styles.badgeOff}>off</span>}</td>
                        <td>
                          <button
                            className={`${styles.adminToggle} ${u.isAdmin ? styles.adminOn : ''}`}
                            onClick={() => toggleAdmin(u)}
                            disabled={isSelf || busyId === u.id}
                            title={isSelf ? 'You cannot remove your own admin access' : u.isAdmin ? 'Revoke admin' : 'Make admin'}
                          >
                            {u.isAdmin ? 'Admin' : 'Grant'}
                          </button>
                        </td>
                        <td>
                          <div className={styles.actionCell}>
                            <button
                              className={`${styles.adminToggle} ${banned ? styles.unbanBtn : styles.banBtn}`}
                              onClick={() => toggleBan(u)}
                              disabled={isSelf || busyId === u.id}
                              title={isSelf ? 'You cannot ban yourself' : banned ? `Banned ${formatDate(u.bannedAt)} - click to unban` : 'Ban: signs the user out and blocks sign-in'}
                            >
                              {banned ? 'Unban' : 'Ban'}
                            </button>
                            {confirmDeleteId === u.id ? (
                              <>
                                <button
                                  className={`${styles.adminToggle} ${styles.deleteConfirmBtn}`}
                                  onClick={() => deleteUser(u)}
                                  disabled={busyId === u.id}
                                >
                                  Confirm
                                </button>
                                <button className={styles.adminToggle} onClick={() => setConfirmDeleteId(null)}>
                                  ✕
                                </button>
                              </>
                            ) : (
                              <button
                                className={`${styles.adminToggle} ${styles.banBtn}`}
                                onClick={() => setConfirmDeleteId(u.id)}
                                disabled={isSelf || busyId === u.id}
                                title={isSelf ? 'You cannot delete your own account' : 'Permanently delete this account and all its data'}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredUsers.length === 0 && (
                <div className={styles.emptyResult}>No users match "{query}"</div>
              )}
            </div>
          )}

          {/* Opened from a report alert: one report, and the way back to the
              queue. Fetched by id, so it works whether or not the report is
              still open and however far down the list it has slid. */}
          {tab === 'reports' && focusReportId && (
            <div className={styles.body}>
              <button className={styles.backToQueue} onClick={onClearFocusReport}>
                ← Back to the queue
              </button>
              {focused === null && <div className={styles.emptyResult}>Loading report…</div>}
              {focused === 'missing' && (
                <div className={styles.emptyResult}>
                  This report no longer exists. It may have been removed along with the account
                  that filed it.
                </div>
              )}
              {focused && focused !== 'missing' && (
                <div className={styles.reportList}>
                  <ReportCard
                    report={focused}
                    busy={busyId === focused.id}
                    threadOpen={threadFor === focused.id}
                    onToggleThread={() => setThreadFor(t => (t === focused.id ? null : focused.id))}
                    onResolve={resolveReport}
                    onViewProfile={onViewProfile}
                    onRemoveComment={removeThreadComment}
                  />
                </div>
              )}
            </div>
          )}

          {tab === 'reports' && !focusReportId && (
            <div className={styles.body}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search by person, reason or content…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />

              <div className={styles.filterRow} role="tablist" aria-label="Report status">
                {(['open', 'resolved', 'dismissed', 'all'] as const).map(f => (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={reportFilter === f}
                    className={`${styles.filterChip} ${reportFilter === f ? styles.filterChipActive : ''}`}
                    onClick={() => setReportFilter(f)}
                  >
                    {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
                    {f === 'open' && openReports > 0 && <span className={styles.filterCount}>{openReports}</span>}
                  </button>
                ))}
              </div>

              <div className={styles.tableNote}>
                Closing a report records your judgement and nothing else. To act on the content
                itself - remove a comment, unpublish a post, ban an account - use the Comments,
                Posts or Users tab; each writes its own entry in the audit log.
              </div>

              <div className={styles.reportList}>
                {filteredReports.map(r => (
                  <ReportCard
                    key={r.id}
                    report={r}
                    busy={busyId === r.id}
                    threadOpen={threadFor === r.id}
                    onToggleThread={() => setThreadFor(t => (t === r.id ? null : r.id))}
                    onResolve={resolveReport}
                    onViewProfile={onViewProfile}
                    onRemoveComment={removeThreadComment}
                  />
                ))}
              </div>

              {filteredReports.length === 0 && (
                <div className={styles.emptyResult}>
                  {query
                    ? `No reports match "${query}"`
                    : reportFilter === 'open'
                      ? 'Nothing waiting - the queue is clear'
                      : `No ${reportFilter === 'all' ? '' : reportFilter + ' '}reports`}
                </div>
              )}
              {reportCursor && !query && (
                <button className={styles.moreBtn} disabled={reportsLoadingMore} onClick={loadMoreReports}>
                  {reportsLoadingMore ? 'Loading…' : 'Load older reports'}
                </button>
              )}
            </div>
          )}

          {tab === 'comments' && (
            <div className={styles.body}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search by author, article or text…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <div className={styles.tableNote}>
                Newest {comments.length} comments, every visibility. Deleting a comment
                with replies leaves a “[deleted]” placeholder so the thread survives.
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Author</th>
                    <th>Comment</th>
                    <th>On</th>
                    <th>Visibility</th>
                    <th className={styles.num}>Replies</th>
                    <th className={styles.num}>Edits</th>
                    <th>Posted</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredComments.map(c => (
                    <Fragment key={c.id}>
                    <tr className={c.deleted ? styles.bannedRow : ''}>
                      <td className={styles.userCell}><Handle username={c.author} onView={onViewProfile} /></td>
                      <td className={styles.snippetCell}>
                        {c.deleted
                          ? <span className={styles.mutedText}>[deleted]</span>
                          : (
                            <>
                              {c.title && <span className={styles.snippetTitle}>{c.title}</span>}
                              <span className={styles.snippetBody}>{c.snippet || '-'}</span>
                            </>
                          )}
                        {c.isReply && <span className={styles.replyBadge}>reply</span>}
                      </td>
                      <td className={styles.emailCell}>
                        <a className={styles.link} href={c.articleUrl} target="_blank" rel="noreferrer noopener">
                          {c.articleTitle || c.articleUrl}
                        </a>
                      </td>
                      <td><VisibilityChip visibility={c.visibility} /></td>
                      <td className={styles.num}>{c.replies}</td>
                      <td className={styles.num}>{c.edits}</td>
                      <td>{relativeDate(c.createdAt)}</td>
                      <td>
                        <div className={styles.actionCell}>
                          {/* Available even on a tombstone: what the removed
                              comment was answering is often the whole question. */}
                          <button
                            className={styles.adminToggle}
                            onClick={() => setThreadFor(t => (t === c.id ? null : c.id))}
                            aria-expanded={threadFor === c.id}
                            title="Read the whole conversation this comment sits in"
                          >
                            {threadFor === c.id ? 'Hide' : 'Thread'}
                          </button>
                          {c.deleted ? (
                            <span className={styles.mutedText}>-</span>
                          ) : confirmDeleteId === c.id ? (
                            <>
                              <button
                                className={`${styles.adminToggle} ${styles.deleteConfirmBtn}`}
                                onClick={() => deleteComment(c)}
                                disabled={busyId === c.id}
                              >
                                Confirm
                              </button>
                              <button className={styles.adminToggle} onClick={() => setConfirmDeleteId(null)}>✕</button>
                            </>
                          ) : (
                            <button
                              className={`${styles.adminToggle} ${styles.banBtn}`}
                              onClick={() => setConfirmDeleteId(c.id)}
                              disabled={busyId === c.id}
                              title={c.replies > 0
                                ? 'Remove the content; the thread below it is kept'
                                : 'Permanently delete this comment'}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {threadFor === c.id && (
                      <tr className={styles.threadRow}>
                        <td colSpan={8}>
                          <CommentThread
                            commentId={c.id}
                            url={c.articleUrl}
                            highlightId={c.id}
                            onViewProfile={onViewProfile}
                            onRemove={removeThreadComment}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {filteredComments.length === 0 && (
                <div className={styles.emptyResult}>
                  {query ? `No comments match "${query}"` : 'No comments yet'}
                </div>
              )}
            </div>
          )}

          {tab === 'blog' && (
            <div className={styles.body}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search by author, title or excerpt…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <div className={styles.tableNote}>
                Newest {posts.length} posts, drafts included - a draft is a post with
                private visibility. Unpublishing sets it back to private; the author’s
                content is left intact.
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Author</th>
                    <th>Post</th>
                    <th>Visibility</th>
                    <th className={styles.num}>Comments</th>
                    <th>Published</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPosts.map(p => (
                    <tr key={p.id}>
                      <td className={styles.userCell}><Handle username={p.author} onView={onViewProfile} /></td>
                      <td className={styles.snippetCell}>
                        <a className={`${styles.link} ${styles.snippetTitle}`} href={p.url} target="_blank" rel="noreferrer noopener">
                          {p.title}
                        </a>
                        <span className={styles.snippetBody}>{p.excerpt || '-'}</span>
                      </td>
                      <td><VisibilityChip visibility={p.visibility} /></td>
                      <td className={styles.num}>
                        {p.commentsEnabled ? p.comments : <span className={styles.mutedText} title="Comments are turned off for this post">off</span>}
                      </td>
                      <td>{p.visibility === 'private' ? <span className={styles.mutedText}>draft</span> : formatDate(p.publishedAt)}</td>
                      <td>{relativeDate(p.updatedAt)}</td>
                      <td>
                        <div className={styles.actionCell}>
                          <button
                            className={`${styles.adminToggle} ${styles.banBtn}`}
                            onClick={() => unpublishPost(p)}
                            disabled={p.visibility === 'private' || busyId === p.id}
                            title={p.visibility === 'private'
                              ? 'Already private'
                              : 'Set back to private - removes it from public view without deleting it'}
                          >
                            Unpublish
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredPosts.length === 0 && (
                <div className={styles.emptyResult}>
                  {query ? `No posts match "${query}"` : 'No posts yet'}
                </div>
              )}
            </div>
          )}

          {tab === 'feeds' && (
            <div className={styles.body}>
              {/* Three sections, narrowing as you go: what is broken, what
                  exists, and what actually happened. The last is the one the
                  other two can't answer - a feed with no errors and no recent
                  check isn't healthy, it isn't being polled. */}
              <div className={styles.sectionTitle}>
                Feed health
                <span className={styles.sectionNote}>
                  {feedTotals.healthy} of {feedTotals.total} feeds fetching normally
                </span>
              </div>
              {feedHealth.length === 0 ? (
                <div className={styles.emptyResult}>Every feed fetched successfully on its last check</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Feed</th>
                      <th>Failures</th>
                      <th>Last error</th>
                      <th>Last worked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feedHealth.map(f => (
                      <tr key={f.id}>
                        <td className={styles.emailCell}>
                          <a className={styles.errorLink} href={f.url} target="_blank" rel="noopener noreferrer">
                            {f.title || f.url}
                          </a>
                          {f.title && <div className={styles.mutedText}>{f.url}</div>}
                        </td>
                        <td>
                          {/* Marked once it has been reported to the admins, so
                              the row and the bell agree about what counts. */}
                          <span className={f.alerting ? styles.auditDestructive : styles.auditAction}>
                            {f.consecutiveFailures} in a row
                          </span>
                        </td>
                        <td className={styles.emailCell}>
                          <span className={styles.mutedText}>{f.lastError || '-'}</span>
                          {f.lastErrorAt && (
                            <div className={styles.mutedText} title={new Date(f.lastErrorAt).toLocaleString()}>
                              {relativeTime(f.lastErrorAt)}
                            </div>
                          )}
                        </td>
                        <td title={f.lastSuccessAt ? new Date(f.lastSuccessAt).toLocaleString() : undefined}>
                          {/* No success ever recorded is a different problem
                              from one that stopped working - most likely a URL
                              that was never a feed. */}
                          {f.lastSuccessAt
                            ? relativeTime(f.lastSuccessAt)
                            : <span className={styles.mutedText}>never</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* ── Every feed, searchable ─────────────────────────────────
                  The health table above only lists what is currently broken,
                  which leaves the more common question unanswered: is this URL
                  even here, who subscribes to it, and when was it last read. */}
              <div className={styles.sectionTitle}>
                All feeds
                <span className={styles.sectionNote}>
                  {feedListTotal} {feedListTotal === 1 ? 'feed' : 'feeds'}
                  {feedSearch.trim() || feedFilter !== 'all' ? ' matching' : ' polled by this instance'}
                </span>
              </div>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search every feed by address or title…"
                value={feedSearch}
                onChange={e => setFeedSearch(e.target.value)}
              />
              <div className={styles.filterRow}>
                {(Object.keys(FEED_STATUS_LABELS) as FeedStatus[]).map(f => (
                  <button
                    key={f}
                    className={`${styles.filterChip} ${feedFilter === f ? styles.filterChipActive : ''}`}
                    onClick={() => setFeedFilter(f)}
                  >
                    {FEED_STATUS_LABELS[f]}
                  </button>
                ))}
              </div>
              <div className={styles.tableNote}>
                Feeds are shared: one fetch serves every subscriber, and two spellings
                of the same address are one feed here. A dormant feed is one nobody has
                opened in {dormantAfterDays} days - the scheduler stops polling it until
                someone does, so a stale "last checked" on those is by design, not a fault.
                {' '}A feed that fails {disableAfterFailures} times in a row switches itself
                off and stops being fetched; nothing is ever deleted automatically, so
                switching one back on is all it takes to retry.
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {/* Sorting happens on the server, so these order the whole
                        list rather than the loaded page. */}
                    <SortableTh label="Feed" sortKey="title" active={feedSort} dir={feedDir} onSort={sortFeedsBy} />
                    <SortableTh label="Subscribers" sortKey="subscribers" active={feedSort} dir={feedDir} onSort={sortFeedsBy} />
                    <SortableTh label="Articles" sortKey="articles" active={feedSort} dir={feedDir} onSort={sortFeedsBy} />
                    <SortableTh label="Failures" sortKey="failures" active={feedSort} dir={feedDir} onSort={sortFeedsBy} />
                    <SortableTh label="Last checked" sortKey="checked" active={feedSort} dir={feedDir} onSort={sortFeedsBy} />
                    <SortableTh label="Last success" sortKey="success" active={feedSort} dir={feedDir} onSort={sortFeedsBy} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {feedList.map(f => (
                    <tr key={f.id} className={f.disabledAt ? styles.rowInactive : undefined}>
                      <td className={styles.emailCell}>
                        <a className={styles.errorLink} href={f.url} target="_blank" rel="noopener noreferrer">
                          {f.title || f.url}
                        </a>
                        {f.title && <div className={styles.mutedText}>{f.url}</div>}
                        {/* Why it is off, in the row rather than a tooltip: the
                            three reasons need different responses, and "blocked"
                            in particular is not a fault to go investigating. */}
                        {f.disabledAt ? (
                          <div className={styles.mutedText}>
                            <span className={styles.auditDestructive}>
                              {f.disabledReason === 'blocked' ? 'blocked'
                                : f.disabledReason === 'manual' ? 'switched off'
                                : 'switched off after repeated failures'}
                            </span>
                            {f.disabledReason !== 'blocked' && f.lastError && ` - ${f.lastError}`}
                          </div>
                        ) : f.consecutiveFailures > 0 && (
                          <div className={styles.mutedText}>
                            failing - {f.lastError || 'reason not recorded'}
                          </div>
                        )}
                      </td>
                      <td>{f.subscribers}</td>
                      <td>{f.items}</td>
                      <td>
                        {f.consecutiveFailures > 0
                          ? <span className={styles.auditAction}>{f.consecutiveFailures}</span>
                          : <span className={styles.mutedText}>-</span>}
                      </td>
                      <td title={f.lastCheckedAt ? new Date(f.lastCheckedAt).toLocaleString() : undefined}>
                        {relativeTime(f.lastCheckedAt)}
                        {f.dormant && <div className={styles.mutedText}>dormant</div>}
                      </td>
                      <td title={f.lastSuccessAt ? new Date(f.lastSuccessAt).toLocaleString() : undefined}>
                        {f.lastSuccessAt
                          ? relativeTime(f.lastSuccessAt)
                          : <span className={styles.mutedText}>never</span>}
                      </td>
                      <td className={styles.actionCell}>
                        {/* Narrows the log below to this feed - the fastest way
                            to tell a feed that is quiet from one that is stuck. */}
                        <button className={styles.traceToggle} onClick={() => setFeedLogFor(f)}>
                          History
                        </button>
                        {f.disabledAt ? (
                          <button
                            className={styles.traceToggle}
                            disabled={feedBusy === f.id}
                            onClick={() => feedAction(f, 'enable')}
                          >
                            Switch on
                          </button>
                        ) : (
                          <button
                            className={styles.traceToggle}
                            disabled={feedBusy === f.id}
                            onClick={() => feedAction(f, 'disable')}
                          >
                            Switch off
                          </button>
                        )}
                        <button
                          className={styles.dangerToggle}
                          disabled={feedBusy === f.id}
                          onClick={() => feedAction(f, 'delete')}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {feedList.length === 0 && (
                <div className={styles.emptyResult}>
                  {feedSearch.trim()
                    ? `No feeds match "${feedSearch.trim()}"`
                    : feedFilter === 'failing'
                      ? 'No feed is currently failing'
                      : feedFilter === 'dormant'
                        ? 'Every feed has been opened recently'
                        : feedFilter === 'disabled'
                          ? 'No feed has been switched off'
                          : feedFilter === 'blocked'
                            ? 'No feed is blocked by a domain rule'
                            : feedFilter === 'healthy'
                              ? 'No feed is currently healthy'
                              : 'No feeds yet'}
                </div>
              )}
              {feedListNext !== null && (
                <button className={styles.moreBtn} disabled={feedListLoadingMore} onClick={loadMoreFeeds}>
                  {feedListLoadingMore ? 'Loading…' : `Load more feeds (${feedListTotal - feedList.length} left)`}
                </button>
              )}

              {/* ── Blocked domains ────────────────────────────────────────
                  Hosts this instance refuses to poll. A rule stops new
                  subscriptions *and* switches off what is already stored -
                  otherwise blocking a domain would only close the front door
                  while the server carried on fetching it. */}
              <div className={styles.sectionTitle}>
                Blocked domains
                <span className={styles.sectionNote}>
                  {blockedDomains.length} {blockedDomains.length === 1 ? 'rule' : 'rules'}
                </span>
              </div>
              <div className={styles.tableNote}>
                <strong>example.com</strong> blocks that domain and everything under it
                (news.example.com), but never notexample.com. <strong>.xyz</strong> — with the
                leading dot — blocks a whole domain extension. Adding a rule switches off the
                feeds already stored that match it; removing one asks whether to bring them back.
              </div>
              <form className={styles.blockForm} onSubmit={addBlockedDomain}>
                <input
                  className={styles.searchInput}
                  type="text"
                  placeholder="example.com or .xyz"
                  value={blockPattern}
                  onChange={e => { setBlockPattern(e.target.value); setBlockError(''); }}
                />
                <input
                  className={styles.searchInput}
                  type="text"
                  placeholder="Why (optional)"
                  value={blockNote}
                  onChange={e => setBlockNote(e.target.value)}
                  maxLength={200}
                />
                <button className={styles.moreBtn} type="submit" disabled={blockBusy || !blockPattern.trim()}>
                  {blockBusy ? 'Working…' : 'Block'}
                </button>
              </form>
              {blockError && <div className={styles.error}>{blockError}</div>}
              {orphanedBlocks > 0 && (
                <div className={styles.tableNote}>
                  {orphanedBlocks} {orphanedBlocks === 1 ? 'feed is' : 'feeds are'} still switched off by a rule
                  that has since been removed. Removing a rule doesn't revive them on its own — use the
                  "Blocked" filter above and switch on the ones you want back.
                </div>
              )}
              {blockedDomains.length === 0 ? (
                <div className={styles.emptyResult}>No domains are blocked</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Pattern</th>
                      <th>Covers</th>
                      <th>Feeds</th>
                      <th>Added</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {blockedDomains.map(r => (
                      <tr key={r.id}>
                        <td className={styles.emailCell}>
                          {r.pattern}
                          {r.note && <div className={styles.mutedText}>{r.note}</div>}
                        </td>
                        <td className={styles.mutedText}>
                          {r.kind === 'suffix' ? 'the extension' : 'the domain and subdomains'}
                        </td>
                        {/* The count is what says whether the pattern did what
                            was meant - a rule matching nothing usually means it
                            was typed slightly wrong. */}
                        <td>{r.feeds}</td>
                        <td title={new Date(r.createdAt).toLocaleString()}>
                          {relativeTime(r.createdAt)}
                          {r.createdByUsername && (
                            <div className={styles.mutedText}>by {r.createdByUsername}</div>
                          )}
                        </td>
                        <td>
                          <button
                            className={styles.traceToggle}
                            disabled={blockBusy}
                            onClick={() => removeBlockedDomain(r)}
                          >
                            Unblock
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* ── The refresh log ────────────────────────────────────────
                  Successes and 304s included, deliberately. A log of failures
                  can only say what broke; this one also says the refresher ran,
                  which is what you need when a feed looks frozen. */}
              <div className={styles.sectionTitle}>
                {feedLogFor ? 'Refresh log for this feed' : 'Refresh log'}
                <span className={styles.sectionNote}>
                  {feedLogFor
                    ? (feedLogFor.title || feedLogFor.url)
                    : `${feedLogSummary.success + feedLogSummary.unchanged + feedLogSummary.failed} checks in the last 24 hours`}
                </span>
              </div>
              <div className={styles.filterRow}>
                {(['all', 'success', 'unchanged', 'failed'] as const).map(o => (
                  <button
                    key={o}
                    className={`${styles.filterChip} ${feedLogOutcome === o ? styles.filterChipActive : ''}`}
                    onClick={() => setFeedLogOutcome(o)}
                  >
                    {o === 'all' ? 'All' : o === 'success' ? 'Updated' : o === 'unchanged' ? 'No change' : 'Failed'}
                    {/* Tallies are the last 24 hours across every feed, so they
                        stay the same when the log is narrowed to one - they
                        describe the instance, not the rows below. */}
                    <span className={styles.errorCount}>
                      {o === 'all'
                        ? feedLogSummary.success + feedLogSummary.unchanged + feedLogSummary.failed
                        : feedLogSummary[o]}
                    </span>
                  </button>
                ))}
                {feedLogFor && (
                  <button className={styles.filterChip} onClick={() => setFeedLogFor(null)}>
                    ✕ Show every feed
                  </button>
                )}
              </div>
              <div className={styles.tableNote}>
                One line per attempt, newest first. "No change" is a 304 - the feed was
                reached and had nothing new, which is most of a healthy day's work.
                Entries older than {feedLogRetentionDays} days are removed automatically.
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Feed</th>
                    <th>Result</th>
                    <th>Took</th>
                    <th>Articles</th>
                  </tr>
                </thead>
                <tbody>
                  {feedLog.map(e => (
                    <tr key={e.id}>
                      <td title={new Date(e.createdAt).toLocaleString()}>{relativeTime(e.createdAt)}</td>
                      <td className={styles.emailCell}>
                        <a className={styles.errorLink} href={e.feedUrl} target="_blank" rel="noopener noreferrer">
                          {e.feedTitle || e.feedUrl}
                        </a>
                      </td>
                      <td>
                        <span className={e.outcome === 'failed' ? styles.auditDestructive : styles.auditAction}>
                          {e.outcome === 'success' ? 'Updated' : e.outcome === 'unchanged' ? 'No change' : 'Failed'}
                          {/* Blank for our own blog feeds, which never go over
                              HTTP - so there is no status to report. */}
                          {e.status !== null && ` ${e.status}`}
                        </span>
                      </td>
                      <td>{formatDuration(e.durationMs)}</td>
                      <td className={styles.emailCell}>
                        {e.outcome === 'failed'
                          ? <span className={styles.mutedText}>{e.error || 'reason not recorded'}</span>
                          : e.items !== null
                            ? <>{e.items} items{e.newItems ? `, ${e.newItems} new` : ''}</>
                            : <span className={styles.mutedText}>-</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {feedLog.length === 0 && (
                <div className={styles.emptyResult}>
                  {feedLogFor
                    ? 'This feed has not been checked within the retention window'
                    : feedLogOutcome === 'all'
                      ? 'No refreshes recorded yet - the scheduler checks stale feeds every few minutes'
                      : 'No attempts with that result'}
                </div>
              )}
              {feedLogCursor && (
                <button className={styles.moreBtn} disabled={feedLogLoadingMore} onClick={loadMoreFeedLog}>
                  {feedLogLoadingMore ? 'Loading…' : 'Load older entries'}
                </button>
              )}
            </div>
          )}

          {tab === 'errors' && (
            <div className={styles.body}>
              <div className={styles.sectionTitle}>Recent errors</div>
              <div className={styles.filterRow}>
                {(['all', 'server', 'feed'] as const).map(s => (
                  <button
                    key={s}
                    className={`${styles.filterChip} ${errorSource === s ? styles.filterChipActive : ''}`}
                    onClick={() => setErrorSource(s)}
                  >
                    {s === 'all' ? 'All' : s === 'server' ? 'Server' : 'Feeds'}
                    <span className={styles.errorCount}>
                      {s === 'all' ? errorCounts.server + errorCounts.feed : errorCounts[s]}
                    </span>
                  </button>
                ))}
              </div>
              <div className={styles.tableNote}>
                Unhandled server errors and feeds that failed to load, newest first.
                Entries older than {retentionDays} days are removed automatically -
                this is a diagnostic log, not a record like the audit trail.
                Requests that failed because someone asked for something invalid
                (a 4xx) aren't errors and aren't listed. "Show detail" on a feed
                error carries the timing and whatever the origin actually sent back;
                which feeds are broken right now is in{' '}
                <button className={styles.traceToggle} onClick={() => switchTab('feeds')}>
                  Feeds
                </button>.
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Source</th>
                    <th>What happened</th>
                    <th>Where</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map(e => (
                    <Fragment key={e.id}>
                      <tr>
                        <td title={new Date(e.createdAt).toLocaleString()}>{relativeDate(e.createdAt)}</td>
                        <td>
                          {/* Feed rows carry a status now too, when the failure
                              had one: a 404 and a timeout are different problems
                              and used to read identically here. */}
                          <span className={e.source === 'server' ? styles.auditDestructive : styles.auditAction}>
                            {e.source === 'server' ? 'Server' : 'Feed'}{e.status ? ` ${e.status}` : ''}
                          </span>
                        </td>
                        <td className={styles.emailCell}>
                          {e.message}
                          {/* A stack trace is the reason this table exists, but
                              it's also twenty lines - so it unrolls under the
                              row rather than living in a cell. */}
                          {e.detail && (
                            <button
                              className={styles.traceToggle}
                              onClick={() => setOpenTrace(openTrace === e.id ? null : e.id)}
                            >
                              {openTrace === e.id ? 'Hide detail' : 'Show detail'}
                            </button>
                          )}
                        </td>
                        <td className={styles.emailCell}>
                          {e.source === 'feed'
                            ? (e.feedUrl
                                ? <a className={styles.errorLink} href={e.feedUrl} target="_blank" rel="noopener noreferrer">{e.feedUrl}</a>
                                : <span className={styles.mutedText}>-</span>)
                            : <span className={styles.mutedText}>{e.method} {e.path}</span>}
                        </td>
                        <td>
                          {e.username
                            ? <Handle username={e.username} exists onView={onViewProfile} />
                            : <span className={styles.mutedText}>{e.source === 'feed' ? '-' : 'anonymous'}</span>}
                        </td>
                      </tr>
                      {openTrace === e.id && e.detail && (
                        <tr>
                          <td colSpan={5}><pre className={styles.trace}>{e.detail}</pre></td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {errors.length === 0 && (
                <div className={styles.emptyResult}>
                  {errorSource === 'all'
                    ? 'Nothing has gone wrong in the retention window'
                    : `No ${errorSource === 'server' ? 'server' : 'feed'} errors recorded`}
                </div>
              )}
              {errorCursor && (
                <button className={styles.moreBtn} disabled={errorsLoadingMore} onClick={loadMoreErrors}>
                  {errorsLoadingMore ? 'Loading…' : 'Load older entries'}
                </button>
              )}
            </div>
          )}

          {tab === 'audit' && (
            <div className={styles.body}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search by admin, action or target…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <div className={styles.tableNote}>
                Every moderation action, newest first. This log is append-only - nothing
                in the app writes to it except the actions themselves, and nothing edits
                or removes an entry once written.
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Admin</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAudit.map(e => (
                    <tr key={e.id}>
                      <td title={new Date(e.createdAt).toLocaleString()}>{relativeDate(e.createdAt)}</td>
                      <td>
                        <Handle username={e.actor} exists={e.actorExists} onView={onViewProfile} />
                        {/* The account is gone; the name survives in the row */}
                        {!e.actorExists && <span className={styles.mutedText}> (deleted)</span>}
                      </td>
                      <td>
                        <span className={e.destructive ? styles.auditDestructive : styles.auditAction}>
                          {e.label}
                        </span>
                      </td>
                      <td className={styles.emailCell}>{e.targetLabel}</td>
                      <td className={styles.emailCell}>
                        {e.metadata
                          ? <span className={styles.mutedText}>{summarizeMetadata(e.metadata)}</span>
                          : <span className={styles.mutedText}>-</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredAudit.length === 0 && (
                <div className={styles.emptyResult}>
                  {query ? `No entries match "${query}"` : 'No moderation actions recorded yet'}
                </div>
              )}
              {auditCursor && !query && (
                <button className={styles.moreBtn} disabled={auditLoadingMore} onClick={loadMoreAudit}>
                  {auditLoadingMore ? 'Loading…' : 'Load older entries'}
                </button>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
