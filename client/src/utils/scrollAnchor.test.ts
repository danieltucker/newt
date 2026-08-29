// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module reads CSS.supports once, at import, so each case needs a fresh
// import with the capability stubbed the way that engine reports it.
async function load(supportsAnchor: boolean) {
  vi.resetModules();
  vi.stubGlobal('CSS', { supports: () => supportsAnchor });
  return import('./scrollAnchor');
}

function boxAt(top: number, height: number) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    top, height, bottom: top + height, left: 0, right: 0, width: 100, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect;
  return el;
}

describe('hideWithoutMovingThePage', () => {
  let scrollBy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hides the element either way', async () => {
    const { hideWithoutMovingThePage } = await load(true);
    const el = boxAt(-300, 170);
    hideWithoutMovingThePage(el);
    expect(el.style.display).toBe('none');
  });

  // The engine is already holding the viewport still. Compensating on top of
  // that would double the jump rather than cancel it.
  it('leaves the scroll alone where the engine anchors', async () => {
    const { hideWithoutMovingThePage } = await load(true);
    hideWithoutMovingThePage(boxAt(-300, 170));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  // The case the fix exists for: a hero that failed after its card scrolled by.
  it('gives back the full height of a box entirely above the viewport', async () => {
    const { hideWithoutMovingThePage } = await load(false);
    hideWithoutMovingThePage(boxAt(-300, 170));
    expect(scrollBy).toHaveBeenCalledWith(0, -170);
  });

  // Only the hidden part displaces anything; the rest was on screen and the
  // reader watches it go.
  it('counts only the part that was above the fold', async () => {
    const { hideWithoutMovingThePage } = await load(false);
    hideWithoutMovingThePage(boxAt(-60, 170));
    expect(scrollBy).toHaveBeenCalledWith(0, -60);
  });

  it('does nothing for a box below the fold', async () => {
    const { hideWithoutMovingThePage } = await load(false);
    hideWithoutMovingThePage(boxAt(400, 170));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  // A card scrolled far past must not ask for more back than it is giving.
  it('never gives back more than the box was worth', async () => {
    const { hideWithoutMovingThePage } = await load(false);
    hideWithoutMovingThePage(boxAt(-5000, 170));
    expect(scrollBy).toHaveBeenCalledWith(0, -170);
  });
});
