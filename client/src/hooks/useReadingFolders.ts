import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api';
import { ReadingFolder } from '../types';

// Twelve hues spaced around the wheel, not a brand-colour list. The bookmark
// picker reuses real product colours (Reddit orange, Spotify green, Stack
// Overflow orange…), which is why it lands three oranges and no yellow - fine
// when the colour is a logo reference, useless when it is a label you have to
// tell apart at a glance. Each of these reads distinctly at dot size on both
// themes. Six-digit hex is what the server accepts.
//
// Lives beside the hook rather than in the Library panel because a shelf can be
// created from anywhere a Save button appears, and all of them should be
// drawing from one list.
export const SHELF_COLORS = [
  '#E5484D', // red
  '#F76B15', // orange
  '#FFC53D', // yellow
  '#99D52A', // lime
  '#30A46C', // green
  '#12A594', // teal
  '#00A2C7', // cyan
  '#0091FF', // blue
  '#5E6AD2', // indigo
  '#8E4EC6', // violet
  '#D6409F', // magenta
  '#8B8D98', // slate
];

/** The first colour no shelf is using, so a new one is telling apart on sight. */
export function nextShelfColor(folders: ReadingFolder[]): string {
  const taken = new Set(folders.map(f => f.color.toUpperCase()));
  return SHELF_COLORS.find(c => !taken.has(c)) ?? SHELF_COLORS[0];
}

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

  /**
   * Fold in a shelf the server made on its own account: the Archived shelf,
   * which is created lazily by the first archive rather than by anything the
   * user pressed in the Library. Without this it would not appear in the
   * sidebar until the next reload.
   *
   * Upsert rather than append, because archiving the second article returns the
   * same shelf as the first and the sidebar must not grow a duplicate.
   */
  const upsertFolder = useCallback((folder: ReadingFolder) => {
    setFolders(prev => prev.some(f => f.id === folder.id)
      ? prev.map(f => f.id === folder.id ? { ...f, ...folder } : f)
      : [...prev, folder]);
  }, []);

  return { folders, createFolder, updateFolder, deleteFolder, reorderFolders, adjustCount, upsertFolder, reloadFolders: load };
}
