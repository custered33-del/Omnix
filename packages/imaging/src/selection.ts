import type { Point, Selection } from '@omnix/core';
import { createMask, type Mask, type Raster } from './raster.js';
import { blurMask } from './filters.js';

/**
 * Selections. Geometric selections are rasterized to coverage masks with 4x4
 * supersampling for anti-aliased edges; pixel-based tools (magic wand, quick and
 * object select) produce masks directly.
 */

const SS = 4;

/** Rasterize a polygon into a coverage mask using a supersampled even-odd scanline fill. */
export function rasterizePolygon(points: readonly Point[], width: number, height: number): Mask {
  const mask = createMask(width, height);
  if (points.length < 3) return mask;
  const acc = new Uint16Array(width * height);
  const n = points.length;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let py = y0; py <= y1; py++) {
    for (let sy = 0; sy < SS; sy++) {
      const y = py + (sy + 0.5) / SS;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = points[i]!;
        const b = points[j]!;
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, xs[k]!);
        const xb = Math.min(width, xs[k + 1]!);
        for (let sx = 0; sx < SS; sx++) {
          const off = (sx + 0.5) / SS;
          const start = Math.max(0, Math.ceil(xa - off));
          const end = Math.min(width - 1, Math.floor(xb - off - 1e-9));
          for (let x = start; x <= end; x++) acc[py * width + x]!++;
        }
      }
    }
  }
  const full = SS * SS;
  for (let i = 0; i < acc.length; i++) mask.data[i] = Math.round((Math.min(acc[i]!, full) / full) * 255);
  return mask;
}

export function ellipsePoints(x: number, y: number, w: number, h: number, segments = 96): Point[] {
  const pts: Point[] = [];
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(t) * (w / 2), y: cy + Math.sin(t) * (h / 2) });
  }
  return pts;
}

/** Rasterize a geometric selection (mask selections need their asset decoded by the caller). */
export function rasterizeSelection(sel: Selection, width: number, height: number, maskAsset?: Mask): Mask {
  let m: Mask;
  switch (sel.kind) {
    case 'rect':
      m = rasterizePolygon(
        [
          { x: sel.x, y: sel.y },
          { x: sel.x + sel.width, y: sel.y },
          { x: sel.x + sel.width, y: sel.y + sel.height },
          { x: sel.x, y: sel.y + sel.height },
        ],
        width,
        height,
      );
      break;
    case 'ellipse':
      m = rasterizePolygon(ellipsePoints(sel.x, sel.y, sel.width, sel.height), width, height);
      break;
    case 'polygon':
      m = rasterizePolygon(sel.points, width, height);
      break;
    case 'mask':
      m = maskAsset && maskAsset.width === width && maskAsset.height === height ? maskAsset : createMask(width, height);
      break;
  }
  return sel.feather && sel.feather > 0 ? blurMask(m, sel.feather) : m;
}

export function invertMask(m: Mask): Mask {
  const out = createMask(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) out.data[i] = 255 - m.data[i]!;
  return out;
}

export function combineMasks(a: Mask, b: Mask, mode: 'add' | 'subtract' | 'intersect'): Mask {
  const out = createMask(a.width, a.height);
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i]!;
    const y = b.data[i] ?? 0;
    out.data[i] = mode === 'add' ? Math.max(x, y) : mode === 'subtract' ? Math.max(0, x - y) : Math.min(x, y);
  }
  return out;
}

export function maskBounds(m: Mask, threshold = 1): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++)
      if (m.data[y * m.width + x]! >= threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function maskCoverage(m: Mask): number {
  let s = 0;
  for (const v of m.data) s += v;
  return s / (255 * m.data.length);
}

function colorDistance(r: Raster, i: number, ref: readonly number[]): number {
  const dr = r.data[i]! - ref[0]!;
  const dg = r.data[i + 1]! - ref[1]!;
  const db = r.data[i + 2]! - ref[2]!;
  const da = r.data[i + 3]! - ref[3]!;
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 + da * da * 0.5);
}

/**
 * Magic wand: select pixels similar to the clicked pixel. `tolerance` is 0..255.
 * Contiguous mode flood-fills from the seed; otherwise selects globally.
 */
export function magicWand(r: Raster, x: number, y: number, tolerance = 32, contiguous = true): Mask {
  const mask = createMask(r.width, r.height);
  const sx = Math.min(r.width - 1, Math.max(0, Math.round(x)));
  const sy = Math.min(r.height - 1, Math.max(0, Math.round(y)));
  const si = (sy * r.width + sx) * 4;
  const ref = [r.data[si]!, r.data[si + 1]!, r.data[si + 2]!, r.data[si + 3]!];
  if (!contiguous) {
    for (let p = 0; p < r.width * r.height; p++) if (colorDistance(r, p * 4, ref) <= tolerance) mask.data[p] = 255;
    return mask;
  }
  const stack = [sy * r.width + sx];
  const seen = new Uint8Array(r.width * r.height);
  seen[stack[0]!] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    if (colorDistance(r, p * 4, ref) > tolerance) continue;
    mask.data[p] = 255;
    const px = p % r.width;
    const py = (p - px) / r.width;
    const nb = [px > 0 ? p - 1 : -1, px < r.width - 1 ? p + 1 : -1, py > 0 ? p - r.width : -1, py < r.height - 1 ? p + r.width : -1];
    for (const q of nb) {
      if (q >= 0 && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return mask;
}

/**
 * Quick select: grow a region from brushed seed points using the running color
 * statistics of the region (adapts to gradients better than a single-color wand).
 */
export function quickSelect(r: Raster, seeds: readonly Point[], brushRadius = 8, tolerance = 40): Mask {
  const mask = createMask(r.width, r.height);
  const w = r.width;
  const h = r.height;
  const queue: number[] = [];
  let sum = [0, 0, 0];
  let count = 0;
  const add = (p: number) => {
    mask.data[p] = 255;
    const i = p * 4;
    sum = [sum[0]! + r.data[i]!, sum[1]! + r.data[i + 1]!, sum[2]! + r.data[i + 2]!];
    count++;
    queue.push(p);
  };
  for (const s of seeds) {
    for (let dy = -brushRadius; dy <= brushRadius; dy++)
      for (let dx = -brushRadius; dx <= brushRadius; dx++) {
        if (dx * dx + dy * dy > brushRadius * brushRadius) continue;
        const x = Math.round(s.x + dx);
        const y = Math.round(s.y + dy);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const p = y * w + x;
        if (!mask.data[p]) add(p);
      }
  }
  let head = 0;
  while (head < queue.length) {
    const p = queue[head++]!;
    const mean = [sum[0]! / count, sum[1]! / count, sum[2]! / count, 255];
    const px = p % w;
    const py = (p - px) / w;
    const nb = [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, py > 0 ? p - w : -1, py < h - 1 ? p + w : -1];
    for (const q of nb) {
      if (q < 0 || mask.data[q]) continue;
      // Compare against both the local neighbour and the region mean for stable growth.
      const local = [r.data[p * 4]!, r.data[p * 4 + 1]!, r.data[p * 4 + 2]!, r.data[p * 4 + 3]!];
      if (colorDistance(r, q * 4, mean) <= tolerance && colorDistance(r, q * 4, local) <= tolerance * 0.6) add(q);
    }
  }
  return mask;
}

/**
 * Object select: given a rough box around a subject, separate it from the background.
 * The background color model is estimated from the box border; pixels inside the box that
 * differ from it are foreground. Keeps the largest connected component and fills holes.
 */
export function objectSelect(r: Raster, box: { x: number; y: number; width: number; height: number }, tolerance = 48): Mask {
  const w = r.width;
  const h = r.height;
  const bx0 = Math.max(0, Math.floor(box.x));
  const by0 = Math.max(0, Math.floor(box.y));
  const bx1 = Math.min(w - 1, Math.ceil(box.x + box.width));
  const by1 = Math.min(h - 1, Math.ceil(box.y + box.height));
  const border: number[][] = [];
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    border.push([r.data[i]!, r.data[i + 1]!, r.data[i + 2]!, r.data[i + 3]!]);
  };
  for (let x = bx0; x <= bx1; x++) {
    sample(x, by0);
    sample(x, by1);
  }
  for (let y = by0; y <= by1; y++) {
    sample(bx0, y);
    sample(bx1, y);
  }
  const palette = kMeans(border, Math.min(4, border.length), 8);
  const fg = createMask(w, h);
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      const i = (y * w + x) * 4;
      let best = Infinity;
      for (const c of palette) best = Math.min(best, colorDistance(r, i, c));
      if (best > tolerance) fg.data[y * w + x] = 255;
    }
  const largest = largestComponent(fg);
  return fillHoles(largest);
}

/** Simple k-means for small color sets. */
export function kMeans(colors: number[][], k: number, iterations = 10): number[][] {
  if (colors.length === 0) return [[0, 0, 0, 255]];
  const centers: number[][] = [];
  for (let i = 0; i < k; i++) centers.push([...colors[Math.floor((i * colors.length) / k)]!]);
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => [0, 0, 0, 0, 0]);
    for (const c of colors) {
      let bi = 0;
      let bd = Infinity;
      centers.forEach((ctr, j) => {
        const d = (c[0]! - ctr[0]!) ** 2 + (c[1]! - ctr[1]!) ** 2 + (c[2]! - ctr[2]!) ** 2 + (c[3]! - ctr[3]!) ** 2;
        if (d < bd) {
          bd = d;
          bi = j;
        }
      });
      const s = sums[bi]!;
      for (let ch = 0; ch < 4; ch++) s[ch]! += c[ch]!;
      s[4]!++;
    }
    sums.forEach((s, j) => {
      if (s[4]! > 0) centers[j] = [s[0]! / s[4]!, s[1]! / s[4]!, s[2]! / s[4]!, s[3]! / s[4]!];
    });
  }
  return centers;
}

/** Keep only the largest 4-connected component of a binary mask. */
export function largestComponent(m: Mask): Mask {
  const { width: w, height: h } = m;
  const labels = new Int32Array(w * h).fill(-1);
  let bestLabel = -1;
  let bestSize = 0;
  let label = 0;
  const stack: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (m.data[p]! < 128 || labels[p] !== -1) continue;
    let size = 0;
    stack.push(p);
    labels[p] = label;
    while (stack.length) {
      const q = stack.pop()!;
      size++;
      const x = q % w;
      const y = (q - x) / w;
      const nb = [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1];
      for (const n of nb) {
        if (n >= 0 && labels[n] === -1 && m.data[n]! >= 128) {
          labels[n] = label;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
    label++;
  }
  const out = createMask(w, h);
  for (let p = 0; p < w * h; p++) if (labels[p] === bestLabel) out.data[p] = 255;
  return out;
}

/** Fill enclosed holes: anything not reachable from the border through unselected pixels becomes selected. */
export function fillHoles(m: Mask): Mask {
  const { width: w, height: h } = m;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!outside[p] && m.data[p]! < 128) {
      outside[p] = 1;
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
  const out = createMask(w, h);
  for (let p = 0; p < w * h; p++) out.data[p] = outside[p] ? 0 : Math.max(m.data[p]!, 255);
  return out;
}

/** Apply a mask to a raster's alpha channel (returns a new raster). */
export function applyMaskToAlpha(r: Raster, m: Mask): Raster {
  const out = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
  for (let p = 0; p < m.data.length; p++) out.data[p * 4 + 3] = (out.data[p * 4 + 3]! * m.data[p]!) / 255;
  return out;
}
