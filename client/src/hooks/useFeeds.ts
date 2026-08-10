import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../services/api';
import { FeedSubscription, FeedFolder, ImportableFeed, SuggestedFeed } from '../types';

interface FeedsResponse {
  folders: FeedFolder[];
  subscriptions: FeedSubscription[];
}

function byPosition<T extends { position: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position);
}

/**
 * Everything the feed reader subscribes to, and the categories it's filed
 * under. One hook rather than two because nothing ever wants only half of it -
 * the manager edits both, and the filter bar needs a category's name to label
 * the feeds inside it.
 */
export function useFeeds(accessToken: string | null) {
  const [subscriptions, setSubscriptions] = useState<FeedSubscription[]>([]);
  const [folders, setFolders] = useState<FeedFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const data = await apiGet<FeedsResponse>('/api/v1/feeds');
      setFolders(byPosition(data.folders));
      setSubscriptions(byPosition(data.subscriptions));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  /**
   * Follow a feed. `url` is whatever the user typed - a feed, a site's front
   * page, or a bare hostname; the server resolves it and rejects what isn't a
   * feed, so the returned row's `url` may differ from what went in.
   */
  const addFeed = useCallback(async (
    url: string,
    opts: { name?: string; feedFolderId?: string | null; skipValidation?: boolean } = {},
  ) => {
    const sub = await apiPost<FeedSubscription>('/api/v1/feeds', {
      url,
      name: opts.name ?? '',
      feedFolderId: opts.feedFolderId ?? null,
      skipValidation: opts.skipValidation === true,
    });
    setSubscriptions(prev => byPosition([...prev, sub]));
    return sub;
  }, []);

  /**
   * Follow several at once. Categories may be named rather than identified -
   * the first-run picker offers ones that don't exist yet - so this reloads
   * afterwards rather than trying to reconstruct what the server created.
   */
  const addFeeds = useCallback(async (
    feeds: Array<{ url: string; name?: string; category?: string; feedFolderId?: string | null }>,
  ) => {
    const result = await apiPost<{ added: FeedSubscription[]; skipped: { url: string; reason: string }[] }>(
      '/api/v1/feeds/batch', { feeds });
    await load();
    return result;
  }, [load]);

  const updateFeed = useCallback(async (
    id: string,
    updates: { name?: string; url?: string; feedFolderId?: string | null },
  ) => {
    const sub = await apiPatch<FeedSubscription>(`/api/v1/feeds/${id}`, updates);
    setSubscriptions(prev => byPosition(prev.map(s => s.id === id ? { ...s, ...sub } : s)));
    return sub;
  }, []);

  const removeFeed = useCallback(async (id: string) => {
    await apiDelete(`/api/v1/feeds/${id}`);
    setSubscriptions(prev => prev.filter(s => s.id !== id));
  }, []);

  const createFolder = useCallback(async (name: string, color?: string) => {
    const folder = await apiPost<FeedFolder>('/api/v1/feeds/folders', { name, color });
    setFolders(prev => byPosition([...prev, folder]));
    return folder;
  }, []);

  const updateFolder = useCallback(async (id: string, updates: { name?: string; color?: string }) => {
    await apiPatch(`/api/v1/feeds/folders/${id}`, updates);
    setFolders(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  // Deleting a category never unsubscribes you from what was in it - those
  // feeds fall back to Uncategorised, and the server says which ones so the
  // list can be corrected without a refetch.
  const removeFolder = useCallback(async (id: string) => {
    const { uncategorizedIds } = await apiDelete<{ uncategorizedIds: string[] }>(
      `/api/v1/feeds/folders/${id}`);
    const orphaned = new Set(uncategorizedIds);
    setFolders(prev => prev.filter(f => f.id !== id));
    setSubscriptions(prev => prev.map(s =>
      orphaned.has(s.id) ? { ...s, feedFolderId: null } : s));
  }, []);

  return {
    subscriptions, folders, loading, loaded,
    addFeed, addFeeds, updateFeed, removeFeed,
    createFolder, updateFolder, removeFolder,
    reload: load,
  };
}

/** Bookmarked sites with a feed the user isn't following - the import list. */
export function useImportableFeeds(accessToken: string | null, enabled: boolean) {
  const [importable, setImportable] = useState<ImportableFeed[]>([]);

  const load = useCallback(async () => {
    if (!accessToken || !enabled) return;
    try {
      setImportable(await apiGet<ImportableFeed[]>('/api/v1/feeds/importable'));
    } catch { /* the manager still works without suggestions */ }
  }, [accessToken, enabled]);

  useEffect(() => { load(); }, [load]);

  return { importable, reload: load };
}

/** The curated list, minus anything already followed. */
export function useSuggestedFeeds(accessToken: string | null, enabled: boolean) {
  const [suggested, setSuggested] = useState<SuggestedFeed[]>([]);
  const [categories, setCategories] = useState<{ name: string; color: string }[]>([]);

  const load = useCallback(async () => {
    if (!accessToken || !enabled) return;
    try {
      const data = await apiGet<{ categories: { name: string; color: string }[]; feeds: SuggestedFeed[] }>(
        '/api/v1/feeds/suggested');
      setCategories(data.categories);
      setSuggested(data.feeds);
    } catch { /* non-essential */ }
  }, [accessToken, enabled]);

  useEffect(() => { load(); }, [load]);

  return { suggested, categories, reload: load };
}
