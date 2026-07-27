import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiDelete, apiFetch } from '../services/api';
import { Bookmark } from '../types';

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

  const markVisited = useCallback(async (id: string) => {
    setBookmarks(prev => prev.map(b => b.id === id ? { ...b, lastVisitedAt: new Date().toISOString(), unreadCount: 0 } : b));
    apiFetch(`/api/v1/bookmarks/${id}/visited`, { method: 'POST' }).catch(() => {});
  }, []);

  return { bookmarks, setBookmarks, loading, addBookmark, updateBookmark, deleteBookmark, reorderBookmarks, persistBookmarkOrder, checkFeed, markVisited, reload: load };
}
