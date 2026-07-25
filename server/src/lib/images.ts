// Pure helpers for uploaded images. Kept free of Express and Prisma so they can
// be unit-tested directly, the way comments.ts and blog.ts are.

// The client downscales before upload (see uploadImage in the client's
// utils/imageUpload.ts), so anything approaching this cap is either an
// exceptionally large photo or someone bypassing the UI. It is a safety limit,
// not a target.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Total stored bytes one user may hold. Generous for a personal app — roughly a
// thousand downscaled photos — while still bounding what a single account can
// cost the database.
export const USER_IMAGE_QUOTA = 200 * 1024 * 1024;

// The path an uploaded image is served from. Stored in post/comment HTML as a
// site-relative URL rather than an absolute one, so it keeps working across the
// dev origin, a LAN address and the eventual public domain without a rewrite.
export const IMAGE_PATH_PREFIX = '/api/v1/images/';

export function imagePathFor(id: string): string {
  return `${IMAGE_PATH_PREFIX}${id}`;
}

// Raster formats only, and deliberately no SVG: an SVG is a document that can
// carry <script> and external references, so serving user-supplied SVG from our
// own origin would be a stored-XSS vector no sanitizer of the *embedding* HTML
// could catch.
const MAGIC: ReadonlyArray<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png',  test: b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif',  test: b => b.length > 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a') },
  { mime: 'image/webp', test: b => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

// The stored content type comes from the bytes, never from the upload's own
// Content-Type header or filename. A client that claims image/png while sending
// HTML would otherwise get that HTML served back from our origin as a document.
export function sniffImageMime(buf: Buffer): string | null {
  for (const { mime, test } of MAGIC) if (test(buf)) return mime;
  return null;
}

// Intrinsic dimensions, read from the format's own header. Used only to record
// what was stored (so a client can reserve layout space); a format whose header
// we cannot parse is still a valid upload, it just reports 0x0.
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } {
  try {
    if (mime === 'image/png') {
      // IHDR is always the first chunk: 8-byte signature, 4 length, 4 type
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/webp') return webpSize(buf);
    if (mime === 'image/jpeg') return jpegSize(buf);
  } catch {
    // A truncated or unusual header is not worth rejecting the upload over
  }
  return { width: 0, height: 0 };
}

// WebP comes in three flavours and each stores its dimensions differently.
function webpSize(buf: Buffer): { width: number; height: number } {
  const kind = buf.subarray(12, 16).toString('latin1');
  if (kind === 'VP8X') {
    // 24-bit little-endian, stored as (dimension - 1)
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  if (kind === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ') {
    // Lossy: 3-byte start code, then 14-bit width and height
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return { width: 0, height: 0 };
}

// Walk the JPEG marker segments to the start-of-frame, which carries the size.
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15 — every frame type except the
    // non-dimensional markers interleaved among them (DHT, JPGx, DAC, RSTn)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}
