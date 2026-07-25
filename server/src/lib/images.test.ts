import { describe, it, expect } from 'vitest';
import { sniffImageMime, imageSize, imagePathFor } from './images';

// Minimal but structurally real headers — enough for the sniffer and the size
// readers, which is all these functions look at.
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(16);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

// SOI, then an APP0 segment to be skipped, then SOF0 carrying the dimensions.
function jpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.writeUInt16BE(0xffd8, 0);          // SOI
  b.writeUInt16BE(0xffe0, 2);          // APP0
  b.writeUInt16BE(8, 4);               // segment length
  b.writeUInt16BE(0xffc0, 12);         // SOF0
  b.writeUInt16BE(17, 14);             // segment length
  b[16] = 8;                           // sample precision
  b.writeUInt16BE(height, 17);
  b.writeUInt16BE(width, 19);
  return b;
}

describe('sniffImageMime', () => {
  it('recognises the four supported raster formats', () => {
    expect(sniffImageMime(png(1, 1))).toBe('image/png');
    expect(sniffImageMime(jpeg(1, 1))).toBe('image/jpeg');
    expect(sniffImageMime(gif(1, 1))).toBe('image/gif');
    expect(sniffImageMime(webpLossy(1, 1))).toBe('image/webp');
  });

  it('rejects SVG — it is a scriptable document, not a raster image', () => {
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  // The upload route only reaches the sniffer for an image/* content type, so
  // this is the case where a client lies about what it is sending.
  it('rejects HTML dressed up as an image', () => {
    expect(sniffImageMime(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
  });

  it('rejects a truncated header rather than guessing', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  it('does not mistake a bare RIFF container for WebP', () => {
    const wav = Buffer.alloc(16);
    wav.write('RIFF', 0, 'latin1');
    wav.write('WAVE', 8, 'latin1');
    expect(sniffImageMime(wav)).toBeNull();
  });
});

describe('imageSize', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(imageSize(png(1280, 720), 'image/png')).toEqual({ width: 1280, height: 720 });
  });

  it('reads GIF dimensions from the logical screen descriptor', () => {
    expect(imageSize(gif(640, 480), 'image/gif')).toEqual({ width: 640, height: 480 });
  });

  it('reads lossy WebP dimensions', () => {
    expect(imageSize(webpLossy(800, 600), 'image/webp')).toEqual({ width: 800, height: 600 });
  });

  it('walks JPEG segments past APP0 to reach SOF0', () => {
    expect(imageSize(jpeg(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 });
  });

  // Dimensions are informational (they only let the client reserve layout
  // space), so an unparseable header must not fail the upload.
  it('reports 0x0 rather than throwing on a header it cannot parse', () => {
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')).toEqual({ width: 0, height: 0 });
    expect(imageSize(Buffer.alloc(2), 'image/png')).toEqual({ width: 0, height: 0 });
  });
});

describe('imagePathFor', () => {
  // Site-relative on purpose: the same stored HTML has to resolve on localhost,
  // a LAN address and the public domain without anyone rewriting bodies.
  it('builds a site-relative path, not an absolute URL', () => {
    expect(imagePathFor('abc123')).toBe('/api/v1/images/abc123');
  });
});
