export interface Folder {
  id: string;
  name: string;
  color: string;
  position: number;
  feedUrls: string[];
  feedLastCheckedAt?: string | null;
}

export interface FeedArticle {
  id: string;
  feedUrl: string;
  title: string;
  link: string;
  source: string;
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
  archived: boolean;
  savedAt: string;
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

export type NotificationType = 'friend_request' | 'friend_accept' | 'comment_reply' | 'friend_comment' | 'friend_post';

export interface AppNotification {
  id: string;
  type: NotificationType;
  actor: PublicUser | null;
  articleUrl: string | null;
  articleTitle: string | null;
  commentId: string | null;
  read: boolean;
  createdAt: string;
}

export interface AuthState {
  accessToken: string | null;
  username: string | null;
}

// ── Public profiles (/u/<username>) ────────────────────────────────────────
export interface ProfileUser {
  username: string;
  displayName: string;
  avatar: string | null;
  createdAt: string;
  commentCount: number;
  postCount: number;
  isSelf: boolean;
  relation: FriendRelation;
  // RSS URL for this person's public posts — offered for copying, and what the
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

// A distinct article the owner has commented on (History tab).
export interface ProfileArticle {
  articleUrl: string;
  articleTitle: string;
  commentCount: number;
  lastCommentedAt: string;
}

// ── Blog posts (/u/<username>/<slug>) ──────────────────────────────────────
// Visibility reuses the comment tiers exactly, and 'private' doubles as the
// draft state — publishing is just widening it.

// List-view shape: everything but the body.
export interface BlogPostSummary {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
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
