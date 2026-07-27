import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api';
import { ReadingFolder } from '../types';

/**
 * Library shelves. Counts come from the server rather than being derived from
 * the loaded items, because a shelf's count has to be right even when the
 * caller hasn't loaded the articles on it.
 */
export function useReadingFolders(accessToken: string | null) {
  const [folders, setFolders] = useState<ReadingFolder[]>([]);

  const load = useCallback(async () => {
    if (!accessToken) { setFolders([]); return; }
    const data = await apiGet<ReadingFolder[]>('/api/v1/reading-folders');
    setFolders(data);
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const createFolder = useCallback(async (name: string, color: string) => {
    const created = await apiPost<ReadingFolder>('/api/v1/reading-folders', { name, color });
    setFolders(prev => [...prev, created]);
    return created;
  }, []);

  const updateFolder = useCallback(async (id: string, patch: { name?: string; color?: string }) => {
    setFolders(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
    try {
      await apiPut(`/api/v1/reading-folders/${id}`, patch);
    } catch {
      load();
    }
  }, [load]);

  // Resolves to the ids that fell back to Unsorted, so the caller can fix up
  // its own item state without a refetch.
  const deleteFolder = useCallback(async (id: string): Promise<string[]> => {
    setFolders(prev => prev.filter(f => f.id !== id));
    try {
      const { unsortedIds } = await apiDelete<{ unsortedIds: string[] }>(`/api/v1/reading-folders/${id}`);
      return unsortedIds;
    } catch {
      load();
      return [];
    }
  }, [load]);

  const reorderFolders = useCallback(async (ordered: ReadingFolder[]) => {
    setFolders(ordered.map((f, i) => ({ ...f, position: i })));
    try {
      await apiPut('/api/v1/reading-folders/reorder', ordered.map((f, i) => ({ id: f.id, position: i })));
    } catch {
      load();
    }
  }, [load]);

  // The item hooks move articles on and off shelves, so counts go stale from
  // the outside; this lets the owner of that action put them right.
  const adjustCount = useCallback((folderId: string | null, delta: number) => {
    if (!folderId) return;
    setFolders(prev => prev.map(f =>
      f.id === folderId ? { ...f, itemCount: Math.max(0, f.itemCount + delta) } : f
    ));
  }, []);

  return { folders, createFolder, updateFolder, deleteFolder, reorderFolders, adjustCount, reloadFolders: load };
}
