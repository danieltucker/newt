import { apiFetch } from '../services/api';

// Longest edge an uploaded image is reduced to. Wide enough to stay sharp on a
// high-DPI screen at the ~780px column notes, comments and posts are read in,
// while turning a 12-megapixel phone photo into a couple of hundred kilobytes.
export const MAX_UPLOAD_DIMENSION = 1600;

// What the file picker will consider. Deliberately no image/svg+xml: an SVG is a
// scriptable document, and the server rejects it too - this only spares the user
// picking a file that would fail.
export const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

// Ceiling on what leaves the browser, matching MAX_IMAGE_BYTES on the server.
// Downscaling normally brings a file far under this; the check catches the cases
// it cannot help with, like an already-small-dimension but enormous PNG.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

// Animated GIFs are passed through as-is: a canvas only ever sees the first
// frame, so re-encoding one would silently throw the animation away.
const PASS_THROUGH = new Set(['image/gif']);

export type UploadedImage = {
  id: string;
  url: string;
  mime: string;
  width: number;
  height: number;
  size: number;
};

// Scale a box down to fit within `max` on its longest edge, preserving aspect
// ratio. Anything already small enough is returned untouched rather than being
// resampled - upscaling a small image would only blur it.
export function fitDimensions(
  width: number,
  height: number,
  max: number = MAX_UPLOAD_DIMENSION,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const scale = max / longest;
  // Round up so a very wide image never collapses an edge to zero
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadBitmap(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read')); };
    img.src = url;
  });
}

// Re-encode through a canvas at no more than MAX_UPLOAD_DIMENSION. A useful side
// effect: the canvas copies pixels only, so EXIF metadata - including any GPS
// coordinates the camera wrote - does not survive into the upload.
async function downscale(file: File): Promise<Blob> {
  const img = await loadBitmap(file);
  const { width, height } = fitDimensions(img.naturalWidth, img.naturalHeight);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not process that image');
  ctx.drawImage(img, 0, 0, width, height);

  // WebP keeps transparency (so a PNG screenshot survives intact) and is
  // markedly smaller than JPEG at the same visual quality.
  const blob = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, 'image/webp', 0.85));
  if (!blob) throw new Error('Your browser could not process that image');

  // Re-encoding is not guaranteed to win - a flat graphic can come out larger
  // than a well-optimised original. Keep whichever is smaller, as long as the
  // original was not itself oversized.
  if (blob.size >= file.size && file.size <= MAX_UPLOAD_BYTES) return file;
  return blob;
}

// Downscale, then POST the raw bytes. The response's `url` is site-relative and
// is what gets written into the editor's HTML.
export async function uploadImage(file: File): Promise<UploadedImage> {
  const body = PASS_THROUGH.has(file.type) ? file : await downscale(file);

  if (body.size > MAX_UPLOAD_BYTES) {
    throw new Error('That image is too large - try one under 4 MB');
  }

  // Raw bytes rather than base64 in JSON: base64 inflates by a third and the
  // app's JSON body limit is 256kb.
  const res = await apiFetch('/api/v1/images', {
    method: 'POST',
    headers: { 'Content-Type': body.type || 'application/octet-stream' },
    body,
  });

  if (!res.ok) {
    let message = 'Upload failed';
    try {
      const data = await res.json();
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // Non-JSON error (a proxy's own 413 page, say) - keep the generic message
    }
    throw new Error(message);
  }

  return res.json();
}
