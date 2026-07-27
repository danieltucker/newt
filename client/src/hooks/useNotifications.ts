import { useState, useEffect, useCallback, useRef } from 'react';
import { apiGet, apiPost } from '../services/api';
import { AppNotification } from '../types';

const POLL_MS = 60_000;

// The top-bar People badge polls a cheap count endpoint; the full list is only
// fetched when the modal opens (loadList).
export function useNotifications(accessToken: string | null) {
  const [unread, setUnread] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshCount = useCallback(async () => {
    if (!accessToken) return;
    try {
      const data = await apiGet<{ unread: number }>('/api/v1/notifications/count');
      setUnread(data.unread ?? 0);
    } catch { /* transient - next poll retries */ }
  }, [accessToken]);

  const loadList = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const data = await apiGet<{ notifications: AppNotification[]; unread: number }>('/api/v1/notifications');
      setNotifications(data.notifications ?? []);
      setUnread(data.unread ?? 0);
    } catch { /* leave prior list in place */ }
    finally { setLoading(false); }
  }, [accessToken]);

  const markAllRead = useCallback(async () => {
    setUnread(0);
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    try { await apiPost('/api/v1/notifications/read-all', {}); } catch { /* re-syncs on next poll */ }
  }, []);

  // Poll the badge count while signed in
  const savedRefresh = useRef(refreshCount);
  useEffect(() => { savedRefresh.current = refreshCount; }, [refreshCount]);
  useEffect(() => {
    if (!accessToken) return;
    savedRefresh.current();
    const id = setInterval(() => savedRefresh.current(), POLL_MS);
    return () => clearInterval(id);
  }, [accessToken]);

  return { unread, notifications, loading, refreshCount, loadList, markAllRead };
}
