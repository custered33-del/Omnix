import type { Adjustment } from '@omnix/core';
import { rgbToHsl, hslToRgb } from '@omnix/core';
import { cloneRaster, clamp255, type Raster } from './raster.js';
import { applyLut3D, type Lut3D } from './lut.js';

/**
 * Build a 256-entry tone curve through control points using monotone cubic
 * (Fritsch–Carlson) interpolation, which never overshoots between points.
 */
export function curveLut(points: readonly [number, number][]): Uint8ClampedArray {
  const pts = [...points].map(([x, y]) => [clamp255(x), clamp255(y)] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (pts.length === 0 || pts[0]![0] > 0) pts.unshift([0, pts[0]?.[1] ?? 0]);
  if (pts[pts.length - 1]![0] < 255) pts.push([255, pts[pts.length - 1]![1]]);
  // Remove duplicate x values
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of pts) {
    if (xs.length && xs[xs.length - 1] === x) ys[ys.length - 1] = y;
    else {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  const lut = new Uint8ClampedArray(256);
  if (n === 1) {
    lut.fill(ys[0]!);
    return lut;
  }
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  m.push(d[0]!);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    while (seg < n - 2 && x > xs[seg + 1]!) seg++;
    const x0 = xs[seg]!;
    const x1 = xs[seg + 1]!;
    const h = x1 - x0;
    const t = h === 0 ? 0 : (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[seg]! + (t3 - 2 * t2 + t) * h * m[seg]! + (-2 * t3 + 3 * t2) * ys[seg + 1]! + (t3 - t2) * h * m[seg + 1]!;
    lut[x] = clamp255(Math.round(y));
  }
  return lut;
}

export function levelsLut(inBlack: number, inWhite: number, gamma: number, outBlack: number, outWhite: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const span = Math.max(1, inWhite - inBlack);
  for (let v = 0; v < 256; v++) {
    const n = Math.min(1, Math.max(0, (v - inBlack) / span));
    const g = Math.pow(n, 1 / Math.max(0.01, gamma));
    lut[v] = clamp255(Math.round(outBlack + g * (outWhite - outBlack)));
  }
  return lut;
}

function mapChannels(r: Raster, lr: Uint8ClampedArray, lg: Uint8ClampedArray, lb: Uint8ClampedArray): Raster {
  const out = cloneRaster(r);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lr[d[i]!]!;
    d[i + 1] = lg[d[i + 1]!]!;
    d[i + 2] = lb[d[i + 2]!]!;
  }
  return out;
}

const IDENTITY = (() => {
  const l = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) l[i] = i;
  return l;
})();

/**
 * Apply a non-destructive adjustment. LUT adjustments need the parsed LUT,
 * which callers resolve from the asset library.
 */
export function applyAdjustment(r: Raster, adj: Adjustment, luts?: (assetId: string) => Lut3D | undefined): Raster {
  switch (adj.kind) {
    case 'curves': {
      const c = curveLut(adj.points);
      if (adj.channel === 'rgb') return mapChannels(r, c, c, c);
      return mapChannels(r, adj.channel === 'r' ? c : IDENTITY, adj.channel === 'g' ? c : IDENTITY, adj.channel === 'b' ? c : IDENTITY);
    }
    case 'levels': {
      const l = levelsLut(adj.inBlack, adj.inWhite, adj.gamma, adj.outBlack, adj.outWhite);
      return mapChannels(r, l, l, l);
    }
    case 'brightnessContrast': {
      const b = adj.brightness * 1.28;
      const c = adj.contrast / 100;
      const f = c >= 0 ? 1 / Math.max(0.01, 1 - c * 0.99) : 1 + c;
      const l = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) l[v] = clamp255(Math.round((v - 128) * f + 128 + b));
      return mapChannels(r, l, l, l);
    }
    case 'invert': {
      const l = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) l[v] = 255 - v;
      return mapChannels(r, l, l, l);
    }
    case 'hueSaturation':
      return hueSaturation(r, adj.hue, adj.saturation, adj.lightness);
    case 'colorBalance':
      return colorBalance(r, adj.shadows, adj.midtones, adj.highlights);
    case 'temperature':
      return temperature(r, adj.amount);
    case 'lut': {
      const lut = luts?.(adj.assetId);
      if (!lut) return cloneRaster(r);
      return applyLut3D(r, lut, adj.intensity);
    }
  }
}

export function hueSaturation(r: Raster, hue: number, saturation: number, lightness: number): Raster {
  const out = cloneRaster(r);
  const d = out.data;
  const sMul = 1 + saturation / 100;
  const l = lightness / 100;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let [h, s, li] = rgbToHsl(d[i]!, d[i + 1]!, d[i + 2]!);
    h += hue;
    s = Math.min(1, Math.max(0, s * sMul));
    li = l >= 0 ? li + (1 - li) * l : li * (1 + l);
    const [R, G, B] = hslToRgb(h, s, li);
    d[i] = R;
    d[i + 1] = G;
    d[i + 2] = B;
  }
  return out;
}

/**
 * Color balance: shift (cyan-red, magenta-green, yellow-blue) amounts in -100..100
 * per tonal range, weighted by luminance like classic photo editors.
 */
export function colorBalance(
  r: Raster,
  shadows: readonly [number, number, number],
  midtones: readonly [number, number, number],
  highlights: readonly [number, number, number],
): Raster {
  const out = cloneRaster(r);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
    const ws = Math.max(0, 1 - lum / 0.5) ** 1.5;
    const wh = Math.max(0, (lum - 0.5) / 0.5) ** 1.5;
    const wm = Math.max(0, 1 - Math.abs(lum - 0.5) * 2);
    for (let c = 0; c < 3; c++) {
      const shift = (shadows[c]! * ws + midtones[c]! * wm + highlights[c]! * wh) * 0.6;
      d[i + c] = clamp255(d[i + c]! + shift);
    }
  }
  return out;
}

/** Warm (positive) or cool (negative) white balance shift. */
export function temperature(r: Raster, amount: number): Raster {
  const out = cloneRaster(r);
  const d = out.data;
  const k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp255(d[i]! + 40 * k);
    d[i + 1] = clamp255(d[i + 1]! + 8 * k);
    d[i + 2] = clamp255(d[i + 2]! - 40 * k);
  }
  return out;
}
