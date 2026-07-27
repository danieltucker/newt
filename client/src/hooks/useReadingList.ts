import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../services/api';
import { ReadingListItem } from '../types';

export function useReadingList(accessToken: string | null) {
  const [items, setItems] = useState<ReadingListItem[]>([]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    const data = await apiGet<ReadingListItem[]>('/api/v1/reading-list');
    setItems(data);
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  const saveItem = useCallback(async (item: Omit<ReadingListItem, 'id' | 'savedAt' | 'inLibrary' | 'folderId' | 'notes'>) => {
    const created = await apiPost<ReadingListItem>('/api/v1/reading-list', item);
    setItems(prev => [created, ...prev]);
    return created;
  }, []);

  const updateItem = useCallback(async (id: string, patch: Partial<Pick<ReadingListItem, 'inLibrary' | 'title' | 'tag' | 'notes'>>) => {
    const updated = await apiPatch<ReadingListItem>(`/api/v1/reading-list/${id}`, patch);
    setItems(prev => prev.map(i => i.id === id ? updated : i));
  }, []);

  // Library moves/removes update state first (so the UI can animate the change
  // synchronously) and reconcile with the server behind the scenes
  const setInLibrary = useCallback(async (id: string, inLibrary: boolean) => {
    // Mirrors the server rule: leaving the Library also leaves the shelf.
    setItems(prev => prev.map(i => i.id === id
      ? { ...i, inLibrary, folderId: inLibrary ? i.folderId : null }
      : i));
    try {
      const updated = await apiPatch<ReadingListItem>(`/api/v1/reading-list/${id}`, { inLibrary });
      setItems(prev => prev.map(i => i.id === id ? updated : i));
    } catch {
      load();
    }
  }, [load]);

  // Filing onto a shelf implies the article is in the Library, so this is also
  // how an article gets there from the reading list in one action.
  const moveToFolder = useCallback(async (id: string, folderId: string | null) => {
    setItems(prev => prev.map(i => i.id === id
      ? { ...i, folderId, inLibrary: folderId ? true : i.inLibrary }
      : i));
    try {
      const updated = await apiPatch<ReadingListItem>(`/api/v1/reading-list/${id}`, { folderId });
      setItems(prev => prev.map(i => i.id === id ? updated : i));
    } catch {
      load();
    }
  }, [load]);

  // A deleted shelf drops its articles into Unsorted rather than deleting them.
  const clearFolder = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const dropped = new Set(ids);
    setItems(prev => prev.map(i => dropped.has(i.id) ? { ...i, folderId: null } : i));
  }, []);

  const removeItem = useCallback(async (id: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
    try {
      await apiDelete(`/api/v1/reading-list/${id}`);
    } catch {
      load();
    }
  }, [load]);

  return { items, saveItem, updateItem, setInLibrary, moveToFolder, clearFolder, removeItem };
}

/**
 * The hook's surface, so a parent that already owns a reading list can hand it
 * to a child instead of the child opening a second copy that drifts from it.
 */
export type ReadingListBinding = ReturnType<typeof useReadingList>;
