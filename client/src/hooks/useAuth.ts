import { useState, useEffect, useCallback, useRef } from 'react';
import { setAccessToken, apiFetch } from '../services/api';
import { resetExploreTasks } from '../services/aiTasks';

interface AuthState {
  accessToken: string | null;
  username: string | null;
  isAdmin: boolean;
  loading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ accessToken: null, username: null, isAdmin: false, loading: true });
  const refreshAttempted = useRef(false);

  // Restore session on mount. Guard ref prevents the double-invoke in React Strict Mode
  // from racing with the server's refresh token rotation (second call would get 401).
  useEffect(() => {
    if (refreshAttempted.current) return;
    refreshAttempted.current = true;
    fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.accessToken) {
          setAccessToken(data.accessToken);
          setState({ accessToken: data.accessToken, username: data.username, isAdmin: !!data.isAdmin, loading: false });
        } else {
          setState({ accessToken: null, username: null, isAdmin: false, loading: false });
        }
      })
      .catch(() => setState({ accessToken: null, username: null, isAdmin: false, loading: false }));
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<{ requiresTotp: true; totpToken: string; username: string } | void> => {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    if (data.requiresTotp) {
      return { requiresTotp: true, totpToken: data.totpToken, username: data.username };
    }
    setAccessToken(data.accessToken);
    setState({ accessToken: data.accessToken, username: data.username, isAdmin: !!data.isAdmin, loading: false });
  }, []);

  const verifyTotp = useCallback(async (totpToken: string, code: string) => {
    const res = await fetch('/api/v1/auth/totp-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ totpToken, code }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Verification failed');
    }
    const data = await res.json();
    setAccessToken(data.accessToken);
    setState({ accessToken: data.accessToken, username: data.username, isAdmin: !!data.isAdmin, loading: false });
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Registration failed');
    }
    const data = await res.json();
    setAccessToken(data.accessToken);
    setState({ accessToken: data.accessToken, username: data.username, isAdmin: !!data.isAdmin, loading: false });
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
    setAccessToken(null);
    // Session-scoped caches keyed on who is signed in. Whether this account
    // has AI tasks it may run is exactly the kind of answer that must not
    // survive into the next sign-in on the same tab.
    resetExploreTasks();
    setState({ accessToken: null, username: null, isAdmin: false, loading: false });
  }, []);

  return { ...state, login, register, logout, verifyTotp };
}
