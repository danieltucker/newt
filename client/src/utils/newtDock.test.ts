import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readDock, writeDock, sideForX, DEFAULT_DOCK } from './newtDock';

// Same as visitedArticles.test: neither environment here supplies a working
// localStorage, so the tests bring one. Three methods is all this module uses.
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('sideForX', () => {
  it('parks in whichever half the drag ended in', () => {
    expect(sideForX(100, 1000, 'right')).toBe('left');
    expect(sideForX(900, 1000, 'left')).toBe('right');
  });

  it('puts the midpoint on the right, with the default', () => {
    expect(sideForX(500, 1000, 'left')).toBe('right');
  });

  it('keeps the side it had when there is no viewport to halve', () => {
    // A hidden tab measures zero, and a drag there must not silently move the
    // button to a side the reader never chose.
    expect(sideForX(0, 0, 'left')).toBe('left');
    expect(sideForX(0, 0, 'right')).toBe('right');
  });
});

describe('readDock / writeDock', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to the right', () => {
    expect(DEFAULT_DOCK).toBe('right');
    expect(readDock()).toBe(DEFAULT_DOCK);
  });

  it('round-trips a chosen side', () => {
    writeDock('left');
    expect(readDock()).toBe('left');
    writeDock('right');
    expect(readDock()).toBe('right');
  });

  it('treats anything it does not recognise as the default', () => {
    localStorage.setItem('newt:dockSide', 'sideways');
    expect(readDock()).toBe('right');
  });

  it('survives storage being unavailable', () => {
    // Private browsing, or a browser with storage switched off. The button
    // still has to render somewhere.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(readDock()).toBe('right');
    expect(() => writeDock('left')).not.toThrow();
  });
});
