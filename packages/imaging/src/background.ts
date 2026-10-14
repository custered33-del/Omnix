import { normalizeColor, parseColor } from '@omnix/core';
import { cloneRaster, createMask, type Mask, type Raster } from './raster.js';
import { blurMask } from './filters.js';
import { kMeans } from './selection.js';

export interface BackgroundRemovalOptions {
  method: 'chroma' | 'auto';
  /** chroma: the key color (e.g. green screen). */
  keyColor?: string;
  /** 0..1 color distance below which pixels are fully removed. */
  tolerance?: number;
  /** 0..1 width of the soft edge band. */
  softness?: number;
  /** Remove green/blue spill from foreground edges (chroma). */
  despill?: boolean;
}

/**
 * Built-in background removal.
 *
 * - `chroma`: classic keyer with tolerance/softness and spill suppression (video green screens).
 * - `auto`: estimates the background palette from the image border, then removes background
 *   that is connected to the border (so interior regions with similar colors survive).
 *
 * This is a deterministic, model-free fallback. A segmentation model can be plugged in
 * through the AI provider layer for hard cases (hair, busy scenes).
 */
export function removeBackground(r: Raster, options: BackgroundRemovalOptions): { raster: Raster; mask: Mask } {
  const mask = options.method === 'chroma' ? chromaMask(r, options) : autoMask(r, options);
  const out = cloneRaster(r);
  for (let p = 0; p < mask.data.length; p++) out.data[p * 4 + 3] = (r.data[p * 4 + 3]! * mask.data[p]!) / 255;
  if (options.method === 'chroma' && options.despill !== false) despill(out, options.keyColor ?? '#00ff00');
  return { raster: out, mask };
}

function chromaMask(r: Raster, o: BackgroundRemovalOptions): Mask {
  const key = parseColor(normalizeColor(o.keyColor ?? '#00ff00'));
  const tol = (o.tolerance ?? 0.3) * 255;
  const soft = Math.max(1, (o.softness ?? 0.1) * 255);
  const kc = toCbCr(key.r, key.g, key.b);
  const m = createMask(r.width, r.height);
  for (let p = 0; p < m.data.length; p++) {
    const i = p * 4;
    const c = toCbCr(r.data[i]!, r.data[i + 1]!, r.data[i + 2]!);
    const d = Math.hypot(c[0] - kc[0], c[1] - kc[1]);
    m.data[p] = d <= tol ? 0 : d >= tol + soft ? 255 : ((d - tol) / soft) * 255;
  }
  return m;
}

/** Chroma distance in YCbCr ignores brightness, so shadows on the key color still key out. */
function toCbCr(r: number, g: number, b: number): [number, number] {
  return [128 - 0.168736 * r - 0.331264 * g + 0.5 * b, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b];
}

function despill(r: Raster, keyColor: string): void {
  const key = parseColor(normalizeColor(keyColor));
  const greenKey = key.g >= key.b;
  for (let i = 0; i < r.data.length; i += 4) {
    if (r.data[i + 3] === 0) continue;
    if (greenKey) {
      const limit = (r.data[i]! + r.data[i + 2]!) / 2;
      if (r.data[i + 1]! > limit) r.data[i + 1] = limit;
    } else {
      const limit = (r.data[i]! + r.data[i + 1]!) / 2;
      if (r.data[i + 2]! > limit) r.data[i + 2] = limit;
    }
  }
}

function autoMask(r: Raster, o: BackgroundRemovalOptions): Mask {
  const w = r.width;
  const h = r.height;
  const border: number[][] = [];
  const stride = Math.max(1, Math.floor((w + h) / 400));
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    border.push([r.data[i]!, r.data[i + 1]!, r.data[i + 2]!, r.data[i + 3]!]);
  };
  for (let x = 0; x < w; x += stride) {
    sample(x, 0);
    sample(x, h - 1);
  }
  for (let y = 0; y < h; y += stride) {
    sample(0, y);
    sample(w - 1, y);
  }
  const palette = kMeans(border, 3, 10);
  const tol = (o.tolerance ?? 0.18) * 255;
  const dist = (p: number) => {
    const i = p * 4;
    let best = Infinity;
    for (const c of palette) {
      const d = Math.sqrt((r.data[i]! - c[0]!) ** 2 + (r.data[i + 1]! - c[1]!) ** 2 + (r.data[i + 2]! - c[2]!) ** 2);
      if (d < best) best = d;
    }
    return best;
  };
  // Flood from the border through background-like pixels.
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!bg[p] && dist(p) <= tol) {
      bg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const q = stack.pop()!;
    const x = q % w;
    const y = (q - x) / w;
    if (x > 0) push(q - 1);
    if (x < w - 1) push(q + 1);
    if (y > 0) push(q - w);
    if (y < h - 1) push(q + w);
  }
  const m = createMask(w, h);
  for (let p = 0; p < w * h; p++) m.data[p] = bg[p] ? 0 : 255;
  const soft = (o.softness ?? 0.05) * Math.max(w, h) * 0.05;
  return soft > 0.3 ? blurMask(m, soft) : m;
}
