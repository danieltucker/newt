import { describe, it, expect } from 'vitest';
import { saveCountLabel, EXACT_FROM } from './saveCount';

describe('saveCountLabel', () => {
  it('says nothing when nobody has saved it', () => {
    expect(saveCountLabel(0)).toBeNull();
    expect(saveCountLabel(undefined)).toBeNull();
    expect(saveCountLabel(null)).toBeNull();
  });

  it('states one exactly rather than calling it multiple', () => {
    expect(saveCountLabel(1)).toBe('1 save');
  });

  it('collapses everything below the threshold', () => {
    expect(saveCountLabel(2)).toBe('multiple saves');
    expect(saveCountLabel(EXACT_FROM - 1)).toBe('multiple saves');
  });

  it('prints the figure from the threshold up', () => {
    expect(saveCountLabel(EXACT_FROM)).toBe('10 saves');
    expect(saveCountLabel(248)).toBe('248 saves');
  });

  // A count arriving negative would mean the optimistic adjustment in
  // useSaveCounts had underflowed; clamping there is the fix, but the label
  // must not render "-1 saves" if it ever does.
  it('says nothing for a nonsense count', () => {
    expect(saveCountLabel(-1)).toBeNull();
    expect(saveCountLabel(NaN)).toBeNull();
  });
});
