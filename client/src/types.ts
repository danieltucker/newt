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

export type NotificationType = 'friend_request' | 'friend_accept' | 'comment_reply' | 'friend_comment';

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
