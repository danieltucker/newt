let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

async function refreshSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    accessToken = data.accessToken;
    return true;
  } catch {
    return false;
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  let res = await fetch(path, { ...init, headers, credentials: 'include' });

  if (res.status === 401 && accessToken) {
    const ok = await refreshSession();
    if (ok) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(path, { ...init, headers, credentials: 'include' });
    }
  }

  return res;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, { method: 'PUT', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * The readable message out of an api* rejection.
 *
 * The helpers above reject with `new Error(await res.text())`, so `.message` is
 * the raw JSON body - showing it to a user puts `{"error":"…"}` on screen. This
 * unwraps it, falling back for a body that isn't the shape the server promises
 * (a proxy's HTML 502, an empty response).
 */
export function apiErrorText(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    try { return (JSON.parse(e.message).error as string) || fallback; } catch { /* not JSON */ }
  }
  return fallback;
}
