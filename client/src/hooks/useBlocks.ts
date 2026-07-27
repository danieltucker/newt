import { useState, useCallback } from 'react';
import { apiGet, apiPost, apiDelete } from '../services/api';
import { BlockedUser } from '../types';

// The blocked list, and the two actions that change it. Mirrors useFriends'
// shape - load into state, act, reload - because the Blocked section sits
// beside the friends list and behaves the same way.

// Pulls the readable message out of an apiPost/apiDelete rejection, whose
// Error.message is the raw JSON error body.
function errText(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    try { return (JSON.parse(e.message).error as string) || fallback; } catch { /* not JSON */ }
  }
  return fallback;
}

export function useBlocks(accessToken: string | null) {
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const data = await apiGet<{ blocked: BlockedUser[] }>('/api/v1/blocks');
      setBlocked(data.blocked ?? []);
    } catch { /* leave prior state */ }
    finally { setLoading(false); }
  }, [accessToken]);

  const block = useCallback(async (username: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await apiPost('/api/v1/blocks', { username });
      await load();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e, 'Could not block this person') };
    }
  }, [load]);

  const unblock = useCallback(async (userId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await apiDelete(`/api/v1/blocks/${userId}`);
      await load();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e, 'Could not unblock this person') };
    }
  }, [load]);

  return { blocked, loading, load, block, unblock };
}
