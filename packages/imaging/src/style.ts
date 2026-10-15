import { cloneRaster, clamp255, type Raster } from './raster.js';
import { lutFromFunction, type Lut3D } from './lut.js';
import { addNoise, gaussianBlur } from './filters.js';

/**
 * Style reference: transfer the color palette, tonal range and grain of a reference
 * image onto a target. Color and tone use Reinhard et al.'s statistics transfer in
 * the decorrelated lαβ space; texture is approximated by matching high-frequency energy.
 */

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = Math.max(1e-4, r / 255);
  const G = Math.max(1e-4, g / 255);
  const B = Math.max(1e-4, b / 255);
  const L = 0.3811 * R + 0.5783 * G + 0.0402 * B;
  const M = 0.1967 * R + 0.7244 * G + 0.0782 * B;
  const S = 0.0241 * R + 0.1288 * G + 0.8444 * B;
  const l = Math.log10(Math.max(1e-6, L));
  const m = Math.log10(Math.max(1e-6, M));
  const s = Math.log10(Math.max(1e-6, S));
  return [(l + m + s) / Math.sqrt(3), (l + m - 2 * s) / Math.sqrt(6), (l - m) / Math.sqrt(2)];
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = L / Math.sqrt(3) + a / Math.sqrt(6) + b / Math.sqrt(2);
  const m = L / Math.sqrt(3) + a / Math.sqrt(6) - b / Math.sqrt(2);
  const s = L / Math.sqrt(3) - (2 * a) / Math.sqrt(6);
  const LL = Math.pow(10, l);
  const MM = Math.pow(10, m);
  const SS = Math.pow(10, s);
  const R = 4.4679 * LL - 3.5873 * MM + 0.1193 * SS;
  const G = -1.2186 * LL + 2.3809 * MM - 0.1624 * SS;
  const B = 0.0497 * LL - 0.2439 * MM + 1.2045 * SS;
  return [R * 255, G * 255, B * 255];
}

export interface StyleStats {
  mean: [number, number, number];
  std: [number, number, number];
}

type Stats = StyleStats;

/** Color statistics of an image in the decorrelated lαβ space (what style transfer matches). */
export function labStats(r: Raster): Stats {
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let n = 0;
  const step = Math.max(1, Math.floor((r.width * r.height) / 200000));
  for (let p = 0; p < r.width * r.height; p += step) {
    const i = p * 4;
    if (r.data[i + 3]! < 16) continue;
    const lab = rgbToLab(r.data[i]!, r.data[i + 1]!, r.data[i + 2]!);
    for (let c = 0; c < 3; c++) {
      sum[c]! += lab[c]!;
      sq[c]! += lab[c]! * lab[c]!;
    }
    n++;
  }
  if (!n) return { mean: [0, 0, 0], std: [1, 1, 1] };
  const mean = sum.map((s) => s / n) as [number, number, number];
  const std = sq.map((s, c) => Math.sqrt(Math.max(1e-8, s / n - mean[c]! * mean[c]!))) as [number, number, number];
  return { mean, std };
}

/** Measure grain: mean absolute difference between an image and its blur. */
export function grainLevel(r: Raster): number {
  const b = gaussianBlur(r, 1.5);
  let s = 0;
  let n = 0;
  for (let i = 0; i < r.data.length; i += 4) {
    s += Math.abs(r.data[i]! - b.data[i]!) + Math.abs(r.data[i + 1]! - b.data[i + 1]!) + Math.abs(r.data[i + 2]! - b.data[i + 2]!);
    n += 3;
  }
  return n ? s / n : 0;
}

export interface StyleTransferOptions {
  /** 0..1 how strongly to apply the reference's color and tone. */
  strength?: number;
  /** Which aspects to transfer. */
  color?: boolean;
  tone?: boolean;
  texture?: boolean;
}

export function transferStyle(target: Raster, reference: Raster, options: StyleTransferOptions = {}): Raster {
  const { strength = 0.8, color = true, tone = true, texture = true } = options;
  const ts = labStats(target);
  const rs = labStats(reference);
  let out = cloneRaster(target);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const lab = rgbToLab(d[i]!, d[i + 1]!, d[i + 2]!);
    const res: [number, number, number] = [...lab];
    if (tone) res[0] = ((lab[0] - ts.mean[0]) * rs.std[0]) / ts.std[0] + rs.mean[0];
    if (color) {
      res[1] = ((lab[1] - ts.mean[1]) * rs.std[1]) / ts.std[1] + rs.mean[1];
      res[2] = ((lab[2] - ts.mean[2]) * rs.std[2]) / ts.std[2] + rs.mean[2];
    }
    const rgb = labToRgb(res[0], res[1], res[2]);
    for (let c = 0; c < 3; c++) d[i + c] = clamp255(d[i + c]! + (rgb[c]! - d[i + c]!) * strength);
  }
  if (texture) {
    const want = grainLevel(reference);
    const have = grainLevel(out);
    if (want > have + 0.5) out = addNoise(out, (want - have) * 2.2 * strength, 11);
  }
  return out;
}

/**
 * The color and tone part of a style transfer as a 3D LUT, so it can be applied non-destructively
 * (an adjustment layer in the image editor, a color grade on a video clip) and tuned or removed later.
 */
export function styleLut(target: Raster | StyleStats, reference: Raster | StyleStats, options: { color?: boolean; tone?: boolean; strength?: number; size?: number } = {}): Lut3D {
  const { color = true, tone = true, strength = 1, size = 33 } = options;
  const ts = 'mean' in target ? target : labStats(target);
  const rs = 'mean' in reference ? reference : labStats(reference);
  return lutFromFunction(
    size,
    (r, g, b) => {
      const lab = rgbToLab(r * 255, g * 255, b * 255);
      const res: [number, number, number] = [...lab];
      if (tone) res[0] = ((lab[0] - ts.mean[0]) * rs.std[0]) / ts.std[0] + rs.mean[0];
      if (color) {
        res[1] = ((lab[1] - ts.mean[1]) * rs.std[1]) / ts.std[1] + rs.mean[1];
        res[2] = ((lab[2] - ts.mean[2]) * rs.std[2]) / ts.std[2] + rs.mean[2];
      }
      const out = labToRgb(res[0], res[1], res[2]);
      const mix = (v: number, i: number) => Math.max(0, Math.min(1, (v * 255 + (out[i]! - v * 255) * strength) / 255));
      return [mix(r, 0), mix(g, 1), mix(b, 2)];
    },
    'Style reference',
  );
}

/** Dominant colors of an image, most common first (for palettes from a reference). */
export function dominantColors(r: Raster, k = 5): { color: [number, number, number]; share: number }[] {
  const pts: number[][] = [];
  const step = Math.max(1, Math.floor((r.width * r.height) / 6000));
  for (let p = 0; p < r.width * r.height; p += step) {
    const i = p * 4;
    if (r.data[i + 3]! < 128) continue;
    pts.push([r.data[i]!, r.data[i + 1]!, r.data[i + 2]!]);
  }
  if (!pts.length) return [];
  const centers: number[][] = [];
  for (let i = 0; i < k; i++) centers.push([...pts[Math.floor(((i + 0.5) * pts.length) / k)]!]);
  const counts = new Array(k).fill(0);
  for (let it = 0; it < 12; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    counts.fill(0);
    for (const c of pts) {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((ctr, j) => {
        const d = (c[0]! - ctr[0]!) ** 2 + (c[1]! - ctr[1]!) ** 2 + (c[2]! - ctr[2]!) ** 2;
        if (d < bd) {
          bd = d;
          bi = j;
        }
      });
      const s = sums[bi]!;
      s[0]! += c[0]!;
      s[1]! += c[1]!;
      s[2]! += c[2]!;
      s[3]!++;
      counts[bi]++;
    }
    sums.forEach((s, j) => {
      if (s[3]! > 0) centers[j] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    });
  }
  return centers
    .map((c, j) => ({ color: [Math.round(c[0]!), Math.round(c[1]!), Math.round(c[2]!)] as [number, number, number], share: counts[j] / pts.length }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);
}
