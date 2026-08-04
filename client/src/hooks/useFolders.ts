import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api';
import { Folder } from '../types';

// Bookmark folders only. Feeds moved out in v1.11.0 - see useFeeds.
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

  return {
    folders, loading, createFolder, updateFolder, deleteFolder, reorderFolders,
    reload: load,
  };
}
