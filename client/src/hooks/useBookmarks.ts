import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiDelete, apiFetch } from '../services/api';
import { Bookmark } from '../types';

/** A feed found behind a freshly added bookmark, pending the user's yes or no. */
export interface FeedOffer {
  url: string;
  /** The publisher's name for itself, falling back to the name on the tile. */
  title: string;
}

export function useBookmarks(accessToken: string | null, folderId: string | null) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken || !folderId) return;
    setLoading(true);
    try {
      const data = await apiGet<Bookmark[]>(`/api/v1/bookmarks?folderId=${folderId}`);
      setBookmarks(data);
    } finally {
      setLoading(false);
    }
  }, [accessToken, folderId]);

  useEffect(() => { load(); }, [load]);

  const addBookmark = useCallback(async (payload: {
    folderId: string; domain: string; name: string; faviconUrl: string; color: string;
  }) => {
    const bookmark = await apiPost<Bookmark>('/api/v1/bookmarks', payload);
    if (payload.folderId === folderId) {
      setBookmarks(prev => [...prev, bookmark]);
    }
    return bookmark;
  }, [folderId]);

  const updateBookmark = useCallback(async (id: string, updates: Partial<Pick<Bookmark, 'domain' | 'name' | 'faviconUrl' | 'color' | 'folderId'>>) => {
    const updated = await apiPut<Bookmark>(`/api/v1/bookmarks/${id}`, updates);
    if (updates.folderId && updates.folderId !== folderId) {
      setBookmarks(prev => prev.filter(b => b.id !== id));
    } else {
      setBookmarks(prev => prev.map(b => b.id === id ? updated : b));
    }
    return updated;
  }, [folderId]);

  const deleteBookmark = useCallback(async (id: string) => {
    await apiDelete(`/api/v1/bookmarks/${id}`);
    setBookmarks(prev => prev.filter(b => b.id !== id));
  }, []);

  const reorderBookmarks = useCallback(async (reordered: Bookmark[]) => {
    setBookmarks(reordered);
    await apiPut('/api/v1/bookmarks/reorder', reordered.map((b, i) => ({ id: b.id, position: i })));
  }, []);

  // Persist a new order without assuming it's the active folder - the inline
  // sidebar can reorder any expanded folder. The caller owns the display state.
  const persistBookmarkOrder = useCallback(async (reordered: Bookmark[]) => {
    await apiPut('/api/v1/bookmarks/reorder', reordered.map((b, i) => ({ id: b.id, position: i })));
  }, []);

  const checkFeed = useCallback(async (id: string) => {
    const res = await apiFetch(`/api/v1/bookmarks/${id}/check-feed`, { method: 'POST' });
    if (!res.ok) return;
    const updated: Bookmark = await res.json();
    setBookmarks(prev => prev.map(b => b.id === id ? updated : b));
  }, []);

  // Whether the site behind a bookmark publishes a feed worth offering. Slow by
  // nature - the server is fetching the site to find out - and never throws: a
  // failed lookup means no prompt, which is exactly what "no feed" looks like.
  const discoverFeed = useCallback(async (id: string): Promise<FeedOffer | null> => {
    try {
      const res = await apiFetch(`/api/v1/bookmarks/${id}/discover-feed`, { method: 'POST' });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.offer ?? null;
    } catch {
      return null;
    }
  }, []);

  // Take the offer. The address is read from the bookmark server-side, so this
  // sends nothing but the id.
  const followFeed = useCallback(async (id: string) => {
    const res = await apiFetch(`/api/v1/bookmarks/${id}/follow-feed`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || "Couldn't follow that feed");
    }
  }, []);

  const markVisited = useCallback(async (id: string) => {
    setBookmarks(prev => prev.map(b => b.id === id ? { ...b, lastVisitedAt: new Date().toISOString(), unreadCount: 0 } : b));
    apiFetch(`/api/v1/bookmarks/${id}/visited`, { method: 'POST' }).catch(() => {});
  }, []);

  return { bookmarks, setBookmarks, loading, addBookmark, updateBookmark, deleteBookmark, reorderBookmarks, persistBookmarkOrder, checkFeed, discoverFeed, followFeed, markVisited, reload: load };
}
