import { createMask, createRaster, type Mask, type Raster } from './raster.js';

export interface PixelDiff {
  /** Pixels that differ by more than the threshold. */
  changed: number;
  total: number;
  /** changed / total, 0..1 */
  fraction: number;
  /** Smallest box holding every changed pixel, or null when nothing changed. */
  bbox: { x: number; y: number; width: number; height: number } | null;
  /** 255 where the pixel changed. */
  mask: Mask;
  width: number;
  height: number;
}

/**
 * Compare two renders pixel by pixel (top-left aligned; a size change counts the new area as
 * changed). Colors are compared premultiplied, so invisible pixels never count, and small
 * differences under `threshold` (0..255, default 24) are ignored as anti-aliasing noise.
 */
export function pixelDiff(a: Raster, b: Raster, options: { threshold?: number } = {}): PixelDiff {
  const threshold = options.threshold ?? 24;
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const mask = createMask(width, height);
  let changed = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  const px = (r: Raster, x: number, y: number, out: number[]) => {
    if (x >= r.width || y >= r.height) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return;
    }
    const i = (y * r.width + x) * 4;
    const al = r.data[i + 3]!;
    out[0] = (r.data[i]! * al) / 255;
    out[1] = (r.data[i + 1]! * al) / 255;
    out[2] = (r.data[i + 2]! * al) / 255;
    out[3] = al;
  };
  const pa = [0, 0, 0, 0];
  const pb = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      px(a, x, y, pa);
      px(b, x, y, pb);
      const d = Math.max(Math.abs(pa[0]! - pb[0]!), Math.abs(pa[1]! - pb[1]!), Math.abs(pa[2]! - pb[2]!), Math.abs(pa[3]! - pb[3]!));
      if (d > threshold) {
        mask.data[y * width + x] = 255;
        changed++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  const total = width * height;
  return { changed, total, fraction: total ? changed / total : 0, bbox: changed ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null, mask, width, height };
}

/**
 * A picture of what changed: the newer render faded to gray, with changed pixels in a strong
 * highlight color (default magenta, which rarely occurs in artwork) and a thin outline around
 * the changed area so small edits are easy to spot.
 */
export function diffOverlay(after: Raster, diff: PixelDiff, color: [number, number, number] = [226, 0, 116]): Raster {
  const { width, height, mask } = diff;
  const out = createRaster(width, height, [255, 255, 255, 255]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 255;
      let g = 255;
      let b = 255;
      if (x < after.width && y < after.height) {
        const i = (y * after.width + x) * 4;
        const al = after.data[i + 3]! / 255;
        const lum = 0.299 * after.data[i]! + 0.587 * after.data[i + 1]! + 0.114 * after.data[i + 2]!;
        // Gray, lightened, over white.
        const v = 255 - (255 - (lum * 0.55 + 255 * 0.45)) * al;
        r = g = b = v;
      }
      if (mask.data[y * width + x]) {
        r = r * 0.15 + color[0] * 0.85;
        g = g * 0.15 + color[1] * 0.85;
        b = b * 0.15 + color[2] * 0.85;
      }
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
    }
  }
  if (diff.bbox) {
    const pad = Math.max(2, Math.round(Math.min(width, height) * 0.01));
    const bx0 = Math.max(0, diff.bbox.x - pad);
    const by0 = Math.max(0, diff.bbox.y - pad);
    const bx1 = Math.min(width - 1, diff.bbox.x + diff.bbox.width - 1 + pad);
    const by1 = Math.min(height - 1, diff.bbox.y + diff.bbox.height - 1 + pad);
    const dot = (x: number, y: number) => {
      // Dashed outline.
      if (((x + y) >> 2) % 2) return;
      const o = (y * width + x) * 4;
      out.data[o] = color[0];
      out.data[o + 1] = color[1];
      out.data[o + 2] = color[2];
    };
    for (let x = bx0; x <= bx1; x++) {
      dot(x, by0);
      dot(x, by1);
    }
    for (let y = by0; y <= by1; y++) {
      dot(bx0, y);
      dot(bx1, y);
    }
  }
  return out;
}

/**
 * Perceptual "difference hash" of a picture: 64 bits saying whether each pixel of a 9×8
 * grayscale thumbnail is brighter than its right neighbour, as 16 hex characters. Resized,
 * re-encoded or lightly edited copies of a picture land within a few bits of each other.
 */
export function differenceHash(gray9x8: Uint8Array | Uint8ClampedArray): string {
  if (gray9x8.length !== 72) throw new Error('differenceHash needs a 9×8 grayscale image');
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (gray9x8[y * 9 + x]! > gray9x8[y * 9 + x + 1]! ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Bits that differ between two hex hashes of the same length. */
export function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

/** A plain color word for an sRGB color (for automatic tags and search). */
export function colorWord(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 510;
  const s = max === min ? 0 : (max - min) / (l > 0.5 ? 510 - max - min : max + min);
  if (l < 0.13) return 'black';
  if (l > 0.9 && s < 0.5) return 'white';
  if (s < 0.15) return 'gray';
  let h = 0;
  const d = max - min;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h < 15 || h >= 345) return l < 0.35 && s < 0.6 ? 'brown' : h >= 345 && l > 0.65 ? 'pink' : 'red';
  if (h < 40) return l < 0.45 ? 'brown' : 'orange';
  if (h < 65) return 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}
