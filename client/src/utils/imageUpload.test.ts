import { describe, it, expect } from 'vitest';
import { fitDimensions, MAX_UPLOAD_DIMENSION } from './imageUpload';

describe('fitDimensions', () => {
  it('leaves an image already within the limit untouched', () => {
    expect(fitDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  // Upscaling would only blur it, so the boundary case is a no-op too
  it('does not scale an image sitting exactly on the limit', () => {
    expect(fitDimensions(1600, 900, 1600)).toEqual({ width: 1600, height: 900 });
  });

  it('scales the longest edge down to the limit, preserving aspect ratio', () => {
    expect(fitDimensions(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it('measures the longest edge, so a tall image scales by its height', () => {
    expect(fitDimensions(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('never collapses an edge to zero on an extreme aspect ratio', () => {
    const { width, height } = fitDimensions(10000, 3, 1600);
    expect(width).toBe(1600);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it('tolerates a zero dimension rather than dividing by it', () => {
    expect(fitDimensions(0, 0, 1600)).toEqual({ width: 0, height: 0 });
  });

  it('defaults to the shared MAX_UPLOAD_DIMENSION', () => {
    expect(fitDimensions(4000, 4000)).toEqual({
      width: MAX_UPLOAD_DIMENSION,
      height: MAX_UPLOAD_DIMENSION,
    });
  });
});
