import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadVisited, markVisited, clearVisited } from './visitedArticles';

const KEY = 'newt:rl-visited';

// Neither the node environment nor happy-dom supplies a working localStorage
// here (node's own is an unavailable experimental global, and happy-dom leaves
// window.localStorage undefined), so the tests bring their own. It only needs
// the four methods this module touches.
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

let store: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  store = memoryStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => vi.unstubAllGlobals());

describe('visitedArticles', () => {
  it('starts empty', () => {
    expect(loadVisited().size).toBe(0);
  });

  it('records an open and reads it back', () => {
    markVisited('a');
    expect(loadVisited().has('a')).toBe(true);
  });

  it('survives a reload - the whole point of not using sessionStorage', () => {
    markVisited('a');
    markVisited('b');
    expect(loadVisited()).toEqual(new Set(['a', 'b']));
  });

  it('reports a repeat open as null so callers can skip the re-render', () => {
    expect(markVisited('a')).not.toBeNull();
    expect(markVisited('a')).toBeNull();
  });

  it('does not duplicate a repeat open in storage', () => {
    markVisited('a');
    markVisited('a');
    expect(JSON.parse(store.getItem(KEY)!)).toEqual(['a']);
  });

  it('trims the oldest entries past the limit', () => {
    for (let i = 0; i < 850; i++) markVisited(`id-${i}`);
    const kept = loadVisited();
    expect(kept.size).toBe(800);
    // The 50 oldest went; the newest are all still there.
    expect(kept.has('id-0')).toBe(false);
    expect(kept.has('id-49')).toBe(false);
    expect(kept.has('id-50')).toBe(true);
    expect(kept.has('id-849')).toBe(true);
  });

  it('clears', () => {
    markVisited('a');
    clearVisited();
    expect(loadVisited().size).toBe(0);
  });

  it('ignores junk in the key rather than throwing', () => {
    store.setItem(KEY, 'not json');
    expect(loadVisited().size).toBe(0);
    markVisited('a');
    expect(loadVisited().has('a')).toBe(true);
  });

  it('ignores non-string entries left by an older or foreign writer', () => {
    store.setItem(KEY, JSON.stringify(['a', 7, null, 'b']));
    expect(loadVisited()).toEqual(new Set(['a', 'b']));
  });

  it('survives storage that throws - private mode, or a full quota', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(() => loadVisited()).not.toThrow();
    expect(loadVisited().size).toBe(0);
    expect(() => markVisited('a')).not.toThrow();
    expect(() => clearVisited()).not.toThrow();
  });
});
