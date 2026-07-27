import { describe, it, expect } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  it('leaves sub-kilobyte sizes in bytes', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps up a unit at each 1024 boundary', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('keeps one decimal below 10 of a unit and rounds above it', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(9.94 * 1024)).toBe('9.9 KB');
    expect(formatBytes(12.4 * 1024)).toBe('12 KB');
    expect(formatBytes(847.3 * 1024 ** 2)).toBe('847 MB');
  });

  it('caps at the largest known unit rather than inventing one', () => {
    expect(formatBytes(1024 ** 6)).toBe('1024 PB');
  });

  it('treats zero, negative and non-finite input as empty', () => {
    for (const n of [0, -1, NaN, Infinity]) {
      expect(formatBytes(n)).toBe('0 B');
    }
  });
});
