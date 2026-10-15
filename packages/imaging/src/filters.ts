import type { FilterKind } from '@omnix/core';
import { cloneRaster, clamp255, createRaster, seededRandom, type Raster, type Mask } from './raster.js';

/** Gaussian kernel for a given sigma, normalized to sum 1. */
function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/**
 * Separable Gaussian blur on premultiplied alpha (no dark fringes around transparent edges).
 * `radius` is in pixels (sigma = radius / 2). Small radii use the exact kernel; large ones three
 * box blurs, which match a Gaussian closely and cost the same at any radius.
 */
export function gaussianBlur(r: Raster, radius: number): Raster {
  if (radius <= 0.25) return cloneRaster(r);
  const sigma = Math.max(0.3, radius / 2);
  const src = premultiply(r);
  return radius > EXACT_BLUR_MAX_RADIUS ? unpremultiply(boxBlurGauss(src, r.width, r.height, sigma), r.width, r.height) : exactBlur(src, r.width, r.height, sigma);
}

/** Up to this radius the exact kernel is cheap enough and keeps fine detail exact. */
export const EXACT_BLUR_MAX_RADIUS = 3;

function premultiply(r: Raster): Float32Array {
  const n = r.width * r.height;
  const src = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i += 4) {
    const a = r.data[i + 3]! / 255;
    src[i] = r.data[i]! * a;
    src[i + 1] = r.data[i + 1]! * a;
    src[i + 2] = r.data[i + 2]! * a;
    src[i + 3] = r.data[i + 3]!;
  }
  return src;
}

function unpremultiply(buf: Float32Array, w: number, h: number): Raster {
  const out = createRaster(w, h);
  for (let o = 0; o < w * h * 4; o += 4) {
    const a3 = buf[o + 3]!;
    const alpha = a3 / 255;
    out.data[o] = alpha > 0 ? buf[o]! / alpha : 0;
    out.data[o + 1] = alpha > 0 ? buf[o + 1]! / alpha : 0;
    out.data[o + 2] = alpha > 0 ? buf[o + 2]! / alpha : 0;
    out.data[o + 3] = a3;
  }
  return out;
}

/** Box widths whose three passes approximate a Gaussian of this sigma. */
function boxSizes(sigma: number, passes = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4));
  return Array.from({ length: passes }, (_, i) => (i < m ? lower : upper));
}

/** One horizontal box pass of radius r over RGBA rows, edges clamped like the exact kernel. */
function boxPassH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const scale = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    const end = row + (w - 1) * 4;
    let a0 = src[row]! * (r + 1);
    let a1 = src[row + 1]! * (r + 1);
    let a2 = src[row + 2]! * (r + 1);
    let a3 = src[row + 3]! * (r + 1);
    for (let j = 1; j <= r; j++) {
      const i = row + Math.min(w - 1, j) * 4;
      a0 += src[i]!;
      a1 += src[i + 1]!;
      a2 += src[i + 2]!;
      a3 += src[i + 3]!;
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      dst[o] = a0 * scale;
      dst[o + 1] = a1 * scale;
      dst[o + 2] = a2 * scale;
      dst[o + 3] = a3 * scale;
      const add = x + r + 1 < w ? row + (x + r + 1) * 4 : end;
      const sub = x - r > 0 ? row + (x - r) * 4 : row;
      a0 += src[add]! - src[sub]!;
      a1 += src[add + 1]! - src[sub + 1]!;
      a2 += src[add + 2]! - src[sub + 2]!;
      a3 += src[add + 3]! - src[sub + 3]!;
    }
  }
}

/** One vertical box pass, a row at a time with a running sum per column (reads stay sequential). */
function boxPassV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, acc: Float64Array): void {
  const scale = 1 / (2 * r + 1);
  const stride = w * 4;
  for (let i = 0; i < stride; i++) acc[i] = src[i]! * (r + 1);
  for (let j = 1; j <= r; j++) {
    const row = Math.min(h - 1, j) * stride;
    for (let i = 0; i < stride; i++) acc[i]! += src[row + i]!;
  }
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const add = Math.min(h - 1, y + r + 1) * stride;
    const sub = Math.max(0, y - r) * stride;
    for (let i = 0; i < stride; i++) {
      dst[row + i] = acc[i]! * scale;
      acc[i]! += src[add + i]! - src[sub + i]!;
    }
  }
}

function boxBlurGauss(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  let a: Float32Array = src;
  let b: Float32Array = new Float32Array(src.length);
  const acc = new Float64Array(w * 4);
  for (const size of boxSizes(sigma)) {
    const r = (size - 1) / 2;
    boxPassH(a, b, w, h, r);
    [a, b] = [b, a];
    boxPassV(a, b, w, h, r, acc);
    [a, b] = [b, a];
  }
  return a;
}

/** The exact separable Gaussian on a premultiplied buffer. */
export function exactBlur(src: Float32Array, w: number, h: number, sigma: number): Raster {
  const k = gaussianKernel(sigma);
  const kr = (k.length - 1) / 2;
  const stride = w * 4;
  const tmp = new Float32Array(w * h * 4);
  // Rows: taps need clamping only near the left and right edges.
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      const inside = x >= kr && x < w - kr;
      for (let j = -kr; j <= kr; j++) {
        const i = row + (inside ? x + j : Math.min(w - 1, Math.max(0, x + j))) * 4;
        const kv = k[j + kr]!;
        a0 += src[i]! * kv;
        a1 += src[i + 1]! * kv;
        a2 += src[i + 2]! * kv;
        a3 += src[i + 3]! * kv;
      }
      const o = row + x * 4;
      tmp[o] = a0;
      tmp[o + 1] = a1;
      tmp[o + 2] = a2;
      tmp[o + 3] = a3;
    }
  }
  // Columns, a whole row at a time so reads stay sequential.
  const out = createRaster(w, h);
  const acc = new Float32Array(stride);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    for (let j = -kr; j <= kr; j++) {
      const base = Math.min(h - 1, Math.max(0, y + j)) * stride;
      const kv = k[j + kr]!;
      for (let i = 0; i < stride; i++) acc[i]! += tmp[base + i]! * kv;
    }
    const row = y * stride;
    for (let i = 0; i < stride; i += 4) {
      const a3 = acc[i + 3]!;
      const alpha = a3 / 255;
      out.data[row + i] = alpha > 0 ? acc[i]! / alpha : 0;
      out.data[row + i + 1] = alpha > 0 ? acc[i + 1]! / alpha : 0;
      out.data[row + i + 2] = alpha > 0 ? acc[i + 2]! / alpha : 0;
      out.data[row + i + 3] = a3;
    }
  }
  return out;
}

/** Blur a single-channel mask (used for feathering selections). */
export function blurMask(m: Mask, radius: number): Mask {
  if (radius <= 0.25) return { width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) };
  const r = createRaster(m.width, m.height);
  for (let p = 0; p < m.data.length; p++) {
    r.data[p * 4] = m.data[p]!;
    r.data[p * 4 + 3] = 255;
  }
  const b = gaussianBlur(r, radius);
  const out = new Uint8ClampedArray(m.data.length);
  for (let p = 0; p < out.length; p++) out[p] = b.data[p * 4]!;
  return { width: m.width, height: m.height, data: out };
}

/** Unsharp mask: original + amount * (original - blurred). */
export function sharpen(r: Raster, amount = 1, radius = 1.5): Raster {
  const blurred = gaussianBlur(r, radius);
  const out = cloneRaster(r);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(r.data[i + c]! + amount * (r.data[i + c]! - blurred.data[i + c]!));
  }
  return out;
}

export function addNoise(r: Raster, amount = 10, seed = 1, monochrome = true): Raster {
  const out = cloneRaster(r);
  const rnd = seededRandom(seed);
  for (let i = 0; i < out.data.length; i += 4) {
    const n = (rnd() - 0.5) * 2 * amount;
    for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(out.data[i + c]! + (monochrome ? n : (rnd() - 0.5) * 2 * amount));
  }
  return out;
}

export function pixelate(r: Raster, size = 8): Raster {
  const s = Math.max(1, Math.round(size));
  const out = cloneRaster(r);
  for (let by = 0; by < r.height; by += s) {
    for (let bx = 0; bx < r.width; bx += s) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;
      for (let y = by; y < Math.min(r.height, by + s); y++)
        for (let x = bx; x < Math.min(r.width, bx + s); x++) {
          const i = (y * r.width + x) * 4;
          sr += r.data[i]!;
          sg += r.data[i + 1]!;
          sb += r.data[i + 2]!;
          sa += r.data[i + 3]!;
          count++;
        }
      for (let y = by; y < Math.min(r.height, by + s); y++)
        for (let x = bx; x < Math.min(r.width, bx + s); x++) {
          const i = (y * r.width + x) * 4;
          out.data[i] = sr / count;
          out.data[i + 1] = sg / count;
          out.data[i + 2] = sb / count;
          out.data[i + 3] = sa / count;
        }
    }
  }
  return out;
}

export function grayscale(r: Raster, amount = 1): Raster {
  const out = cloneRaster(r);
  for (let i = 0; i < out.data.length; i += 4) {
    const l = 0.2126 * r.data[i]! + 0.7152 * r.data[i + 1]! + 0.0722 * r.data[i + 2]!;
    for (let c = 0; c < 3; c++) out.data[i + c] = r.data[i + c]! + (l - r.data[i + c]!) * amount;
  }
  return out;
}

export function sepia(r: Raster, amount = 1): Raster {
  const out = cloneRaster(r);
  for (let i = 0; i < out.data.length; i += 4) {
    const R = r.data[i]!;
    const G = r.data[i + 1]!;
    const B = r.data[i + 2]!;
    const sr = 0.393 * R + 0.769 * G + 0.189 * B;
    const sg = 0.349 * R + 0.686 * G + 0.168 * B;
    const sb = 0.272 * R + 0.534 * G + 0.131 * B;
    out.data[i] = R + (sr - R) * amount;
    out.data[i + 1] = G + (sg - G) * amount;
    out.data[i + 2] = B + (sb - B) * amount;
  }
  return out;
}

/** Darken toward the edges. amount 0..1, radius as a fraction of the half-diagonal where falloff starts. */
export function vignette(r: Raster, amount = 0.5, radius = 0.6): Raster {
  const out = cloneRaster(r);
  const cx = r.width / 2;
  const cy = r.height / 2;
  const maxD = Math.hypot(cx, cy);
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const t = Math.min(1, Math.max(0, (d - radius) / Math.max(0.01, 1 - radius)));
      const f = 1 - amount * t * t;
      const i = (y * r.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = r.data[i + c]! * f;
    }
  return out;
}

function convolve3(r: Raster, k: number[], bias = 0, gray = false): Raster {
  const out = cloneRaster(r);
  const { width: w, height: h } = r;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let ky = -1; ky <= 1; ky++)
        for (let kx = -1; kx <= 1; kx++) {
          const xx = Math.min(w - 1, Math.max(0, x + kx));
          const yy = Math.min(h - 1, Math.max(0, y + ky));
          const i = (yy * w + xx) * 4;
          const kv = k[(ky + 1) * 3 + (kx + 1)]!;
          a0 += r.data[i]! * kv;
          a1 += r.data[i + 1]! * kv;
          a2 += r.data[i + 2]! * kv;
        }
      const o = (y * w + x) * 4;
      if (gray) {
        const l = clamp255(0.2126 * a0 + 0.7152 * a1 + 0.0722 * a2 + bias);
        out.data[o] = out.data[o + 1] = out.data[o + 2] = l;
      } else {
        out.data[o] = clamp255(a0 + bias);
        out.data[o + 1] = clamp255(a1 + bias);
        out.data[o + 2] = clamp255(a2 + bias);
      }
    }
  return out;
}

export function emboss(r: Raster): Raster {
  return convolve3(r, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 0, true);
}

/** Sobel edge magnitude. */
export function edgeDetect(r: Raster): Raster {
  const gx = convolve3(r, [-1, 0, 1, -2, 0, 2, -1, 0, 1], 128, true);
  const gy = convolve3(r, [-1, -2, -1, 0, 0, 0, 1, 2, 1], 128, true);
  const out = cloneRaster(r);
  for (let i = 0; i < out.data.length; i += 4) {
    const m = clamp255(Math.hypot(gx.data[i]! - 128, gy.data[i]! - 128) * 2);
    out.data[i] = out.data[i + 1] = out.data[i + 2] = m;
  }
  return out;
}

/** Default parameters for each smart filter, shown in the UI and used when params are omitted. */
export const FILTER_DEFAULTS: Record<FilterKind, Record<string, number>> = {
  gaussianBlur: { radius: 4 },
  sharpen: { amount: 1, radius: 1.5 },
  noise: { amount: 12, seed: 1 },
  pixelate: { size: 8 },
  grayscale: { amount: 1 },
  sepia: { amount: 1 },
  vignette: { amount: 0.5, radius: 0.6 },
  emboss: {},
  edgeDetect: {},
};

/** Run a named filter with params (missing params use defaults). */
export function applyFilter(r: Raster, filter: FilterKind, params: Record<string, number> = {}): Raster {
  const p = { ...FILTER_DEFAULTS[filter], ...params };
  switch (filter) {
    case 'gaussianBlur':
      return gaussianBlur(r, p.radius!);
    case 'sharpen':
      return sharpen(r, p.amount!, p.radius!);
    case 'noise':
      return addNoise(r, p.amount!, p.seed!);
    case 'pixelate':
      return pixelate(r, p.size!);
    case 'grayscale':
      return grayscale(r, p.amount!);
    case 'sepia':
      return sepia(r, p.amount!);
    case 'vignette':
      return vignette(r, p.amount!, p.radius!);
    case 'emboss':
      return emboss(r);
    case 'edgeDetect':
      return edgeDetect(r);
  }
}
