import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// The real template, read from the client source rather than a fixture. The
// markers live in a file in another workspace that nothing here imports, so a
// fixture would have gone stale silently the first time someone tidied
// index.html — which is the exact failure this is here to catch.
const REAL_SHELL = readFileSync(
  join(__dirname, '..', '..', '..', 'client', 'index.html'),
  'utf8',
);

const fetchMock = vi.fn();
vi.mock('node-fetch', () => ({ default: (...args: unknown[]) => fetchMock(...args) }));

import { renderShell, clearShellCache } from './htmlShell';

function ok(body: string) {
  return { ok: true, status: 200, text: async () => body };
}

beforeEach(() => {
  clearShellCache();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok(REAL_SHELL));
});

describe('renderShell against the real index.html', () => {
  it('finds both markers in the template as it is actually written', () => {
    expect(REAL_SHELL).toContain('<!--SSR-HEAD-->');
    expect(REAL_SHELL).toContain('<!--SSR-BODY-->');
  });

  it('injects the head where the marker is', async () => {
    const out = await renderShell('<title>Mine</title>');
    expect(out).toContain('<title>Mine</title>');
    expect(out).not.toContain('<!--SSR-HEAD-->');
  });

  it('leaves exactly one title, so the browser cannot pick the wrong one', async () => {
    const out = await renderShell('<title>Mine</title>');
    expect(out.match(/<title>/g)).toHaveLength(1);
    expect(out).not.toContain('a new tab worth opening');
  });

  it('keeps the static title when nothing is injected over it', async () => {
    // renderShell is only called with a head, but the stripping must key off the
    // injection rather than run unconditionally — a route that someday serves the
    // bare shell should not lose the title.
    const out = await renderShell('');
    expect(out).toContain('<title>');
  });

  it('injects the body content after the root div', async () => {
    const out = await renderShell('<title>T</title>', '<noscript><p>Hi</p></noscript>');
    expect(out.indexOf('id="root"')).toBeLessThan(out.indexOf('<noscript>'));
    expect(out).not.toContain('<!--SSR-BODY-->');
  });

  it('keeps the pre-paint theme script, whose CSP hash covers its exact bytes', async () => {
    const out = await renderShell('<title>T</title>');
    expect(out).toContain("localStorage.getItem('theme')");
  });

  it('does not escape what it is given — both sides would double-encode', async () => {
    const out = await renderShell('<meta name="description" content="a &amp; b">');
    expect(out).toContain('content="a &amp; b"');
  });
});

describe('shell caching', () => {
  it('fetches once and serves the rest from memory', async () => {
    await renderShell('<title>A</title>');
    await renderShell('<title>B</title>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a valid document when the template cannot be fetched', async () => {
    fetchMock.mockRejectedValue(new Error('nginx is gone'));

    const out = await renderShell('<title>Still here</title>');

    // Degraded, not 502: for the crawler and the unfurler that mostly reach these
    // routes, the head *is* the response.
    expect(out).toContain('<!DOCTYPE html>');
    expect(out).toContain('<title>Still here</title>');
  });

  it('keeps serving a stale template rather than falling back on a failed refetch', async () => {
    await renderShell('<title>A</title>');
    fetchMock.mockRejectedValue(new Error('transient'));
    clearShellCacheTtlByAdvancingTime();

    const out = await renderShell('<title>B</title>');

    // A minute-old shell names asset files that are almost certainly still
    // valid; the fallback names none at all.
    expect(out).toContain('id="root"');
  });
});

// The cache is time-based and there is no seam to reach into, so this moves the
// clock instead of the cache.
function clearShellCacheTtlByAdvancingTime() {
  const realNow = Date.now;
  const t = realNow() + 120_000;
  vi.spyOn(Date, 'now').mockImplementation(() => t);
}
