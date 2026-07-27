import { describe, it, expect } from 'vitest';
import { coverHue, coverStyle } from './coverGradient';

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
});
