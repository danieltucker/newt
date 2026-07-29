import { describe, it, expect } from 'vitest';
import {
  coverHue, coverStyle, coverGradientFor, coverThemeById, COVER_THEMES, COVER_AUTO,
} from './coverGradient';

describe('coverHue', () => {
  it('is stable for the same username', () => {
    expect(coverHue('samwichgamgee')).toBe(coverHue('samwichgamgee'));
  });

  it('ignores case, so @Sam and @sam get the same cover', () => {
    expect(coverHue('Sam')).toBe(coverHue('sam'));
    expect(coverHue('SAMWICH')).toBe(coverHue('samwich'));
  });

  it('always lands inside the hue wheel', () => {
    const names = ['a', 'sam', 'daniel', '', 'zzzzzzzzzzzzzzzzzzzz', '田中', 'user-42'];
    for (const n of names) {
      const h = coverHue(n);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('spreads different usernames across the wheel', () => {
    const names = ['sam', 'daniel', 'alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
    const hues = new Set(names.map(coverHue));
    // Not a uniformity proof - just that it isn't collapsing everyone onto one colour.
    expect(hues.size).toBeGreaterThan(names.length / 2);
  });
});

describe('coverStyle', () => {
  it('produces a two-stop gradient', () => {
    const { background } = coverStyle('sam');
    expect(background).toMatch(/^linear-gradient\(115deg, hsl\(/);
    expect(background.match(/hsl\(/g)).toHaveLength(2);
  });

  it('offsets the second stop by 48 degrees, wrapping past 360', () => {
    const stops = (name: string) =>
      [...coverStyle(name).background.matchAll(/hsl\((\d+)/g)].map(m => Number(m[1]));

    for (const name of ['sam', 'daniel', 'alice', 'zebra', 'q']) {
      const [a, b] = stops(name);
      expect(b).toBe((a + 48) % 360);
      expect(b).toBeLessThan(360);
    }
  });

  it('is deterministic', () => {
    expect(coverStyle('daniel')).toEqual(coverStyle('daniel'));
  });

  it('paints a chosen theme instead of the derived one', () => {
    const themed = coverStyle('sam', 'ember');
    expect(themed.background).toBe(coverThemeById('ember')!.gradient);
    expect(themed.background).not.toBe(coverStyle('sam').background);
  });

  it('falls back to the derived gradient for auto, for none, and for an unknown id', () => {
    const auto = coverStyle('sam').background;
    for (const theme of [COVER_AUTO, null, undefined, '', 'a-theme-from-a-later-build']) {
      expect(coverStyle('sam', theme).background).toBe(auto);
    }
  });

  it('layers an uploaded image over the gradient, so the gradient covers the load', () => {
    const style = coverStyle('sam', 'ember', '/api/v1/images/abc123');
    expect(style.backgroundImage).toBe('url("/api/v1/images/abc123")');
    expect(style.background).toBe(coverThemeById('ember')!.gradient);
    expect(style.backgroundSize).toBe('cover');
  });

  it('names no image when there is none', () => {
    expect(coverStyle('sam', 'ember', null).backgroundImage).toBeUndefined();
    expect(coverStyle('sam', 'ember', '').backgroundImage).toBeUndefined();
  });
});

describe('COVER_THEMES', () => {
  it('leads with auto, the state every profile starts in', () => {
    expect(COVER_THEMES[0].id).toBe(COVER_AUTO);
    expect(COVER_THEMES[0].gradient).toBeUndefined();
  });

  it('has unique ids in the shape the server will accept', () => {
    const ids = COVER_THEMES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,23}$/);
  });

  it('gives every theme but auto a gradient', () => {
    for (const t of COVER_THEMES.slice(1)) {
      expect(t.gradient).toMatch(/^linear-gradient\(/);
      expect(coverGradientFor('sam', t.id)).toBe(t.gradient);
    }
  });
});
