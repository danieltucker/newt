import { useState, useCallback } from 'react';
import { apiGet, apiPost, apiDelete } from '../services/api';
import { PublicUser, FriendRequests, FriendSearchResult } from '../types';

// Pulls the readable message out of an apiPost/apiDelete rejection, whose
// Error.message is the raw JSON error body.
function errText(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    try { return (JSON.parse(e.message).error as string) || fallback; } catch { /* not JSON */ }
  }
  return fallback;
}

export function useFriends(accessToken: string | null) {
  const [friends, setFriends] = useState<PublicUser[]>([]);
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] });
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const [f, r] = await Promise.all([
        apiGet<{ friends: PublicUser[] }>('/api/v1/friends'),
        apiGet<FriendRequests>('/api/v1/friends/requests'),
      ]);
      setFriends(f.friends ?? []);
      setRequests({ incoming: r.incoming ?? [], outgoing: r.outgoing ?? [] });
    } catch { /* leave prior state */ }
    finally { setLoading(false); }
  }, [accessToken]);

  const search = useCallback(async (q: string): Promise<FriendSearchResult[]> => {
    if (!accessToken || q.trim().length < 2) return [];
    try {
      const data = await apiGet<{ results: FriendSearchResult[] }>(
        `/api/v1/friends/search?q=${encodeURIComponent(q.trim())}`
      );
      return data.results ?? [];
    } catch { return []; }
  }, [accessToken]);

  const sendRequest = useCallback(async (username: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await apiPost('/api/v1/friends/requests', { username });
      await load();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e, 'Could not send request') };
    }
  }, [load]);

  const accept = useCallback(async (id: string) => {
    try { await apiPost(`/api/v1/friends/requests/${id}/accept`, {}); } catch { /* ignore */ }
    await load();
  }, [load]);

  const decline = useCallback(async (id: string) => {
    try { await apiPost(`/api/v1/friends/requests/${id}/decline`, {}); } catch { /* ignore */ }
    await load();
  }, [load]);

  const unfriend = useCallback(async (userId: string) => {
    try { await apiDelete(`/api/v1/friends/${userId}`); } catch { /* ignore */ }
    await load();
  }, [load]);

  return { friends, requests, loading, load, search, sendRequest, accept, decline, unfriend };
}
