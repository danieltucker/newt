import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../services/api';
import { Folder, FolderFeed } from '../types';

// feedUrls is derived from feeds server-side; mirror that here so an optimistic
// update doesn't leave the two disagreeing until the next load.
function withFeeds(folder: Folder, feeds: FolderFeed[]): Folder {
  const ordered = [...feeds].sort((a, b) => a.position - b.position);
  return { ...folder, feeds: ordered, feedUrls: ordered.map(f => f.url) };
}

export function useFolders(accessToken: string | null) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const data = await apiGet<Folder[]>('/api/v1/folders');
      setFolders(data);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const createFolder = useCallback(async (name: string, color: string) => {
    const folder = await apiPost<Folder>('/api/v1/folders', { name, color });
    setFolders(prev => [...prev, folder]);
    return folder;
  }, []);

  const updateFolder = useCallback(async (id: string, updates: Partial<Pick<Folder, 'name' | 'color'>>) => {
    await apiPut(`/api/v1/folders/${id}`, updates);
    setFolders(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  const deleteFolder = useCallback(async (id: string) => {
    await apiDelete(`/api/v1/folders/${id}`);
    setFolders(prev => prev.filter(f => f.id !== id));
  }, []);

  const reorderFolders = useCallback(async (reordered: Folder[]) => {
    setFolders(reordered);
    await apiPut('/api/v1/folders/reorder', reordered.map((f, i) => ({ id: f.id, position: i })));
  }, []);

  const addFeed = useCallback(async (folderId: string, url: string, name = '') => {
    const feed = await apiPost<FolderFeed>(`/api/v1/folders/${folderId}/feeds`, { url, name });
    setFolders(prev => prev.map(f =>
      f.id === folderId ? withFeeds(f, [...f.feeds, feed]) : f));
    return feed;
  }, []);

  // Renames, re-points or moves a feed. A move rewrites two folders, so this
  // drops the row from every folder before adding it back to the one it landed
  // in - the same code path whether or not the folder actually changed.
  const updateFeed = useCallback(async (
    feedId: string,
    updates: { url?: string; name?: string; folderId?: string },
  ) => {
    const feed = await apiPatch<FolderFeed & { folderId: string }>(
      `/api/v1/folders/feeds/${feedId}`, updates);
    setFolders(prev => prev.map(f => {
      const without = f.feeds.filter(x => x.id !== feedId);
      if (f.id !== feed.folderId) {
        return without.length === f.feeds.length ? f : withFeeds(f, without);
      }
      return withFeeds(f, [...without, feed]);
    }));
    return feed;
  }, []);

  const deleteFeed = useCallback(async (feedId: string) => {
    await apiDelete(`/api/v1/folders/feeds/${feedId}`);
    setFolders(prev => prev.map(f => {
      const without = f.feeds.filter(x => x.id !== feedId);
      return without.length === f.feeds.length ? f : withFeeds(f, without);
    }));
  }, []);

  return {
    folders, loading, createFolder, updateFolder, deleteFolder, reorderFolders,
    addFeed, updateFeed, deleteFeed, reload: load,
  };
}
