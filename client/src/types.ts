// A profile's outbound link. Defined beside the platform table it goes with, and
// re-exported here so a consumer of ProfileUser needs only the one import.
import type { ProfileLink } from './utils/profileLinks';
export type { ProfileLink };

// One feed the user follows. It has an id of its own so it can be renamed,
// re-pointed at a new URL, or moved to another category and still be the same
// subscription. `name` is "" when the user hasn't set one - see feedLabel.
export interface FeedSubscription {
  id: string;
  url: string;
  name: string;
  position: number;
  /** Which category it's filed under. Null is Uncategorised, a real place. */
  feedFolderId: string | null;
  /** The publisher's own title, from the shared Feed row. May be "". */
  title?: string;
  lastCheckedAt?: string | null;
}

/**
 * A category in the feed reader - "Tech news", "Local", "Auto". Deliberately
 * separate from bookmark `Folder`: the feed is one river you read on its own
 * terms, and where a *link* is filed says nothing about its publisher.
 */
export interface FeedFolder {
  id: string;
  name: string;
  color: string;
  position: number;
}

/** A bookmark whose site has a feed the user isn't following yet. */
export interface ImportableFeed {
  id: string;
  name: string;
  domain: string;
  feedUrl: string;
}

/** One of the curated starter feeds offered on first run. */
export interface SuggestedFeed {
  name: string;
  url: string;
  site: string;
  blurb: string;
  category: string;
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  position: number;
}

export interface FeedArticle {
  id: string;
  feedUrl: string;
  title: string;
  link: string;
  source: string;
  /** The category of the subscription it arrived through, for filtering. */
  feedFolderId?: string | null;
  pubDate: string | null;
  fetchedAt: string;
  readTime: number | null;
  snippet: string | null;
  imageUrl: string | null;
  categories: string[];
  read?: boolean;
}

export interface Bookmark {
  id: string;
  folderId: string | null;
  // Pinned bookmarks surface in the sidebar's top pin grid but keep their folder.
  pinned?: boolean;
  domain: string;
  name: string;
  faviconUrl: string;
  color: string;
  position: number;
  feedUrl?: string | null;
  feedCheckedAt?: string | null;
  feedLatestAt?: string | null;
  unreadCount?: number;
  lastVisitedAt?: string | null;
}

export interface ReadingListItem {
  id: string;
  url: string;
  title: string;
  source: string;
  readTime: string;
  tag: string;
  notes: string;
  imageUrl: string;
  /** Moved out of the active reading list and onto a Library shelf. */
  inLibrary: boolean;
  /** Which Library shelf. Null means Unsorted, not "unknown". */
  folderId: string | null;
  savedAt: string;
}

/** A shelf in the Library. Self-only - never rendered on a public profile. */
export interface ReadingFolder {
  id: string;
  name: string;
  color: string;
  position: number;
  /** Library items on this shelf, computed server-side. */
  itemCount: number;
}

export type CommentVisibility = 'public' | 'friends' | 'private';

// A comment thread hangs off an article's canonical URL, so the same
// conversation shows on the feed card and the saved reading-list card alike.
export interface ArticleComment {
  id: string;
  parentId: string | null;
  title: string | null;      // root comments only
  body: string;              // sanitized HTML from the rich editor
  visibility: CommentVisibility;
  deleted: boolean;          // a tombstone: content wiped, kept to hold up its replies
  createdAt: string;
  updatedAt: string;
  mine: boolean;
  // Server-decided: true only when the viewer is an admin looking at someone
  // else's live comment. The client never infers this - see toNode in
  // server/src/routes/comments.ts.
  canModerate?: boolean;
  author: { username: string; displayName: string; avatar: string | null };
  replies: ArticleComment[];
}

export interface CommentPrefs {
  showPublic: boolean;
  defaultVisibility: CommentVisibility;
  sort: 'newest' | 'oldest';
  autoExpand: boolean;
}

// One version of a comment's content. `editedAt` on a revision is when it was
// replaced; on `current` it's the comment's last-updated time.
export interface CommentRevision {
  title: string | null;
  body: string;
  visibility: CommentVisibility;
  editedAt: string;
}

export interface CommentHistory {
  current: CommentRevision;
  revisions: CommentRevision[];   // newest-first; empty for edits made before history tracking
}

// ── Friends & notifications ────────────────────────────────────────────────
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

export interface FriendRequest {
  id: string;
  user: PublicUser;
  createdAt: string;
}

export interface FriendRequests {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export type FriendRelation = 'none' | 'friends' | 'incoming' | 'outgoing';

export interface FriendSearchResult extends PublicUser {
  relation: FriendRelation;
}

// ── Blocking ───────────────────────────────────────────────────────────────
// A block is a wall, not a mute: one row makes the pair mutually invisible.
// Only your own side is ever listed - who has blocked *you* is deliberately
// unknowable. See server/src/lib/blocks.ts.
export interface BlockedUser extends PublicUser {
  blockedAt: string;
}

// ── Reports ────────────────────────────────────────────────────────────────
export type ReportCategory = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'other';
export type ReportTargetType = 'comment' | 'blogPost' | 'user';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

// What a moderator sees in the queue. `snapshot` is the content as it read when
// reported, so the report survives the author editing or deleting it.
export interface ModerationReport {
  id: string;
  reporter: string;
  reporterExists: boolean;
  subject: string;
  subjectExists: boolean;
  targetType: ReportTargetType;
  targetId: string;
  targetLabel: string;
  targetUrl: string | null;
  snapshot: string;
  category: ReportCategory;
  categoryLabel: string;
  note: string;
  status: ReportStatus;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  // Total reports naming this person, this one included - so the smallest is 1.
  reportsAgainstSubject: number;
  createdAt: string;
}

// One comment in the moderator's thread view: the whole conversation around a
// reported comment, unfiltered by visibility. Unlike ArticleComment a tombstone
// keeps its author here - who wrote the removed comment is what a moderator is
// usually looking for.
export interface AdminThreadComment {
  id: string;
  parentId: string | null;
  author: string;
  title: string | null;
  body: string;
  visibility: CommentVisibility;
  deleted: boolean;
  edits: number;
  createdAt: string;
  updatedAt: string;
  replies: AdminThreadComment[];
}

export interface AdminThread {
  articleTitle: string;
  articleUrl: string;
  total: number;
  comments: AdminThreadComment[];
}

export type NotificationType =
  | 'friend_request' | 'friend_accept' | 'comment_reply' | 'friend_comment' | 'friend_post'
  // Moderator-only: a user filed a report. Carries no actor - see
  // notifyAdminsOfReport in server/src/routes/reports.ts.
  | 'report_new'
  // Admin-only, both from server/src/lib/adminAlerts.ts. 'user_new' carries the
  // new account as its actor, so the bell links to their profile; 'feed_failing'
  // is actorless (a feed is not a person) and puts the feed URL in articleUrl.
  | 'user_new' | 'feed_failing';

export interface AppNotification {
  id: string;
  type: NotificationType;
  actor: PublicUser | null;
  articleUrl: string | null;
  articleTitle: string | null;
  commentId: string | null;
  // Set on 'report_new' only: which report the alert opens in the moderation
  // queue. Null on every other type.
  reportId: string | null;
  read: boolean;
  createdAt: string;
}

export interface AuthState {
  accessToken: string | null;
  username: string | null;
}

// ── Public profiles (/u/<username>) ────────────────────────────────────────
export interface ProfileUser {
  // Sent by toPublicUser server-side. Needed because unblocking is keyed on the
  // user id, not the username.
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  createdAt: string;
  // The banner behind the avatar. An uploaded image wins; failing that a named
  // gradient; failing that one derived from the username. See coverStyle().
  coverImage: string | null;
  coverTheme: string | null;
  // The owner's links out, in the order they arranged them.
  profileLinks: ProfileLink[];
  commentCount: number;
  postCount: number;
  isSelf: boolean;
  relation: FriendRelation;
  // True only on the *blocker's* view of someone they blocked: a stub profile
  // with no content and an Unblock button. Someone who was blocked gets a 404
  // instead, so this never tells anyone they've been blocked.
  blocked: boolean;
  // RSS URL for this person's public posts - offered for copying, and what the
  // Follow button subscribes a folder to.
  blogFeedUrl: string;
}

// One of the profile owner's comments, with the article it was posted on.
export interface ProfileComment {
  id: string;
  title: string | null;
  body: string;
  visibility: CommentVisibility;
  articleUrl: string;
  articleTitle: string;
  createdAt: string;
  updatedAt: string;
}

// ── Blog posts (/u/<username>/<slug>) ──────────────────────────────────────
// Visibility reuses the comment tiers exactly, and 'private' doubles as the
// draft state - publishing is just widening it.

// List-view shape: everything but the body.
export interface BlogPostSummary {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  // Cover image as a site-relative /api/v1/images/<id> path, '' for none.
  heroImage: string;
  visibility: CommentVisibility;
  commentsEnabled: boolean;
  // Absolute canonical URL. Also the key its comment thread hangs on, so it is
  // what gets handed to CommentsPanel rather than anything recomputed locally.
  url: string;
  publishedAt: string;
  updatedAt: string;
  author?: PublicUser;
}

export interface BlogPost extends BlogPostSummary {
  body: string;              // sanitized HTML from the rich editor
  articleKey?: string;
  isSelf?: boolean;
}

// One entry in a profile's merged Activity tab: either a post the owner wrote or
// a comment they shared. The `kind` tag is what the renderer switches on.
export type ProfileActivityItem =
  | { kind: 'post'; at: string; post: BlogPostSummary }
  | { kind: 'comment'; at: string; comment: ProfileComment };
