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

  /**
   * `dest` files the article straight onto a Library shelf, in the one request
   * that creates it - a null folderId inside it means Unsorted. Without it the
   * article lands in the reading list.
   *
   * The server keeps one copy per destination, so what comes back may be a row
   * that was already there (flagged `duplicate`). Splicing that in by id rather
   * than pushing it is what keeps the list from showing the same article twice
   * until the next reload.
   */
  const saveItem = useCallback(async (
    item: Omit<ReadingListItem, 'id' | 'savedAt' | 'inLibrary' | 'folderId' | 'notes' | 'duplicate'>,
    dest?: { folderId: string | null },
  ) => {
    const created = await apiPost<ReadingListItem>('/api/v1/reading-list', {
      ...item,
      ...(dest ? { folderId: dest.folderId, inLibrary: true } : {}),
    });
    setItems(prev => prev.some(i => i.id === created.id)
      ? prev.map(i => i.id === created.id ? created : i)   // the copy already there, left where it sits
      : [created, ...prev]);
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

  // Undo of removeItem. The delete has already gone through by the time this is
  // offered, so restoring means re-creating: the row comes back with a new id
  // but its original savedAt, which is what lands it back in the same place in
  // the list. Comment threads key off the URL rather than the id, so a
  // deleted-and-restored article keeps its conversation.
  //
  // Its shelf comes back with it. Undo means "put it back", and the create had
  // no way to say where until it learned to take a destination - so an article
  // deleted off a shelf used to reappear in the reading list instead.
  const restoreItem = useCallback(async (item: ReadingListItem) => {
    const created = await apiPost<ReadingListItem>('/api/v1/reading-list', {
      url: item.url,
      title: item.title,
      source: item.source,
      readTime: item.readTime,
      tag: item.tag,
      imageUrl: item.imageUrl,
      notes: item.notes,
      savedAt: item.savedAt,
      folderId: item.folderId,
      inLibrary: item.inLibrary,
    });
    // Spliced back in by savedAt rather than pushed to the front, so it lands
    // where the next reload will put it - the server orders by savedAt desc.
    setItems(prev => {
      const rest = prev.filter(i => i.id !== created.id);
      const at = rest.findIndex(i => new Date(i.savedAt).getTime() <= new Date(created.savedAt).getTime());
      return at === -1 ? [...rest, created] : [...rest.slice(0, at), created, ...rest.slice(at)];
    });
    return created;
  }, []);

  return { items, saveItem, updateItem, setInLibrary, moveToFolder, clearFolder, removeItem, restoreItem };
}

/**
 * The hook's surface, so a parent that already owns a reading list can hand it
 * to a child instead of the child opening a second copy that drifts from it.
 */
export type ReadingListBinding = ReturnType<typeof useReadingList>;
