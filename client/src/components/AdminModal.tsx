import { useState, useEffect, useMemo, Fragment } from 'react';
import { apiGet, apiPatch, apiDelete } from '../services/api';
import { formatBytes } from '../utils/formatBytes';
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

type Tab = 'overview' | 'users' | 'reports' | 'comments' | 'blog' | 'audit';

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

const TAB_TITLES: Record<Tab, string> = {
  overview: 'Overview',
  users: 'Users',
  reports: 'Reports',
  comments: 'Comments',
  blog: 'Blog posts',
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

function relativeDate(s: string | null): string {
  if (!s) return 'never';
  const diff = Date.now() - new Date(s).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return formatDate(s);
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

/* Hand-rolled line chart with area fill - one point per day */
function LineChart({ points, gradientId }: { points: HistoryPoint[]; gradientId: string }) {
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

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} preserveAspectRatio="none" aria-label="Cumulative total over the last 90 days">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className={styles.areaTop} />
          <stop offset="100%" className={styles.areaBottom} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline points={line} className={styles.line} fill="none" vectorEffect="non-scaling-stroke" />
      {lastPt && (
        <circle cx={W} cy={y(lastPt.total)} r={3.5} className={styles.lineDot}>
          <title>{`${lastPt.date}: ${lastPt.total}`}</title>
        </circle>
      )}
      {points.map((p, i) => (
        i % 30 === 0 && (
          <text key={p.date} x={Math.max(x(i), 24)} y={H - 4} className={styles.axisLabel} textAnchor="middle">
            {new Date(p.date + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' })}
          </text>
        )
      ))}
    </svg>
  );
}

/* Hand-rolled bar chart - one bar per day, no chart library needed */
function SignupChart({ signups }: { signups: AdminStats['signups'] }) {
  const W = 600, H = 140, PAD_B = 18;
  const max = Math.max(1, ...signups.map(s => s.count));
  const barW = W / signups.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart} preserveAspectRatio="none" aria-label="Signups per day, last 30 days">
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
              className={s.count > 0 ? styles.bar : styles.barEmpty}
            >
              <title>{`${s.date}: ${s.count} signup${s.count === 1 ? '' : 's'}`}</title>
            </rect>
            {i % 7 === 0 && (
              <text x={x + barW / 2} y={H - 4} className={styles.axisLabel} textAnchor="middle">
                {new Date(s.date + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' })}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function AdminModal({
  currentUsername, onClose, onViewProfile, focusReportId, onClearFocusReport,
}: Props) {
  // Arriving from a report alert lands on the queue, not the overview.
  const [tab, setTab] = useState<Tab>(focusReportId ? 'reports' : 'overview');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [comments, setComments] = useState<AdminComment[]>([]);
  const [posts, setPosts] = useState<AdminBlogPost[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
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
        .catch(() => setError('Could not load blog posts'));
    }
    if (tab === 'audit' && !loadedAudit) {
      setLoadedAudit(true);
      apiGet<{ entries: AuditEntry[]; nextCursor: string | null }>('/api/v1/admin/audit')
        .then(d => { setAudit(d.entries); setAuditCursor(d.nextCursor); })
        .catch(() => setError('Could not load the audit log'));
    }
  }, [tab, loadedComments, loadedPosts, loadedAudit]);

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
    setQuery('');
    setConfirmDeleteId(null);
    // An expanded thread belongs to the row that opened it; leaving it open
    // would reopen under whatever row happens to share that id on the next tab.
    setThreadFor(null);
    // Leaving the Reports tab abandons the single-report view the bell opened.
    if (next !== 'reports') onClearFocusReport?.();
  }

  const totalSignups30d = stats?.signups.reduce((n, s) => n + s.count, 0) ?? 0;

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.nav}>
          <div className={styles.navHeader}>Admin</div>
          <button className={`${styles.navItem} ${tab === 'overview' ? styles.navActive : ''}`} onClick={() => switchTab('overview')}>
            Overview
          </button>
          <button className={`${styles.navItem} ${tab === 'users' ? styles.navActive : ''}`} onClick={() => switchTab('users')}>
            Users
          </button>
          {/* Badged with the queue depth: the one tab where the number is the
              reason to open it, not a detail found once inside. */}
          <button className={`${styles.navItem} ${tab === 'reports' ? styles.navActive : ''}`} onClick={() => switchTab('reports')}>
            Reports
            {openReports > 0 && <span className={styles.navBadge}>{openReports}</span>}
          </button>
          <button className={`${styles.navItem} ${tab === 'comments' ? styles.navActive : ''}`} onClick={() => switchTab('comments')}>
            Comments
          </button>
          <button className={`${styles.navItem} ${tab === 'blog' ? styles.navActive : ''}`} onClick={() => switchTab('blog')}>
            Blog posts
          </button>
          <button className={`${styles.navItem} ${tab === 'audit' ? styles.navActive : ''}`} onClick={() => switchTab('audit')}>
            Audit log
          </button>
        </div>

        <div className={styles.content}>
          <div className={styles.contentHeader}>
            <span className={styles.title}>{TAB_TITLES[tab]}</span>
            <button className={styles.closeBtn} onClick={onClose}>✕ Close</button>
          </div>

          {error && <div className={styles.error}>{error}</div>}

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
                  <span className={styles.statLabel}>Blog posts</span>
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
                <LineChart points={stats.history.users} gradientId="admin-users-grad" />
              </div>

              <div className={styles.chartBlock}>
                <div className={styles.chartTitle}>
                  Total bookmarks - last 90 days
                  <TrendBadge points={stats.history.bookmarks} />
                </div>
                <LineChart points={stats.history.bookmarks} gradientId="admin-bookmarks-grad" />
              </div>

              <div className={styles.chartBlock}>
                <div className={styles.chartTitle}>
                  Total comments - last 90 days
                  <TrendBadge points={stats.history.comments} />
                </div>
                <LineChart points={stats.history.comments} gradientId="admin-comments-grad" />
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
                  Total blog posts - last 90 days
                  <TrendBadge points={stats.history.blogPosts} />
                </div>
                <LineChart points={stats.history.blogPosts} gradientId="admin-blog-grad" />
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
                Blog posts or Users tab; each writes its own entry in the audit log.
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
                  {query ? `No posts match "${query}"` : 'No blog posts yet'}
                </div>
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
      </div>
    </div>
  );
}
