import { cloneRaster, clamp255, type Raster } from './raster.js';
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

interface Stats {
  mean: [number, number, number];
  std: [number, number, number];
}

function labStats(r: Raster): Stats {
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
