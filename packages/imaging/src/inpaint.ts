import { cloneRaster, createRaster, seededRandom, type Mask, type Raster } from './raster.js';
import { maskBounds } from './selection.js';
import { resizeBilinear, resizeMask } from './resize.js';

/**
 * Content-aware fill (exemplar-based inpainting).
 *
 * The hole is filled from the outside in ("onion peel"). For each boundary pixel we
 * search for the source patch whose known pixels best match the known pixels around
 * the target, using PatchMatch-style candidates: offsets propagated from already
 * filled neighbours plus random samples. The center pixel is copied from the best
 * source. This reproduces texture (grass, sky, walls) rather than just smearing.
 */
export interface InpaintOptions {
  /** Patch radius in pixels (patch is (2r+1)^2). */
  patchRadius?: number;
  /** Random candidates tried per pixel. */
  randomSamples?: number;
  /** Search margin around the hole, as a multiple of the hole size. */
  searchMargin?: number;
  seed?: number;
}

export function contentAwareFill(src: Raster, hole: Mask, options: InpaintOptions = {}): Raster {
  const bounds = maskBounds(hole, 128);
  if (!bounds) return cloneRaster(src);
  let holeCount = 0;
  for (const v of hole.data) if (v >= 128) holeCount++;
  // Large holes are filled at reduced resolution, then upsampled into place (keeps it interactive).
  const MAX_HOLE = 60_000;
  if (holeCount > MAX_HOLE) {
    const f = Math.sqrt(holeCount / MAX_HOLE);
    const sw = Math.max(8, Math.round(src.width / f));
    const sh = Math.max(8, Math.round(src.height / f));
    const smallSrc = resizeBilinear(src, sw, sh);
    const smallHole = resizeMask(hole, sw, sh);
    const filled = fillAtScale(smallSrc, smallHole, options);
    const up = resizeBilinear(filled, src.width, src.height);
    const out = cloneRaster(src);
    for (let p = 0; p < hole.data.length; p++) {
      if (hole.data[p]! < 128) continue;
      out.data.set(up.data.subarray(p * 4, p * 4 + 4), p * 4);
    }
    return out;
  }
  return fillAtScale(src, hole, options);
}

function fillAtScale(src: Raster, hole: Mask, options: InpaintOptions): Raster {
  const { patchRadius = 3, randomSamples = 24, searchMargin = 1.5, seed = 7 } = options;
  const bounds = maskBounds(hole, 128)!;
  const w = src.width;
  const h = src.height;
  const out = cloneRaster(src);
  const rnd = seededRandom(seed);
  const inHole = (p: number) => hole.data[p]! >= 128;

  const known = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) known[p] = inHole(p) ? 0 : 1;

  const margin = Math.ceil(Math.max(bounds.width, bounds.height) * searchMargin) + patchRadius * 2;
  const sx0 = Math.max(patchRadius, bounds.x - margin);
  const sy0 = Math.max(patchRadius, bounds.y - margin);
  const sx1 = Math.min(w - 1 - patchRadius, bounds.x + bounds.width + margin);
  const sy1 = Math.min(h - 1 - patchRadius, bounds.y + bounds.height + margin);

  // A source patch must lie entirely outside the original hole, so only real image content is copied.
  // A summed-area table of the hole makes this an O(1) check.
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += inHole(y * w + x) ? 1 : 0;
      sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)]! + row;
    }
  }
  const holeSum = (x0: number, y0: number, x1: number, y1: number) =>
    sat[(y1 + 1) * (w + 1) + (x1 + 1)]! - sat[y0 * (w + 1) + (x1 + 1)]! - sat[(y1 + 1) * (w + 1) + x0]! + sat[y0 * (w + 1) + x0]!;
  const sourceOk = (x: number, y: number): boolean => {
    if (x < sx0 || y < sy0 || x > sx1 || y > sy1) return false;
    return holeSum(x - patchRadius, y - patchRadius, x + patchRadius, y + patchRadius) === 0;
  };

  const patchCost = (tx: number, ty: number, sx: number, sy: number, limit: number): number => {
    let cost = 0;
    let n = 0;
    for (let dy = -patchRadius; dy <= patchRadius; dy++) {
      const ty2 = ty + dy;
      if (ty2 < 0 || ty2 >= h) continue;
      for (let dx = -patchRadius; dx <= patchRadius; dx++) {
        const tx2 = tx + dx;
        if (tx2 < 0 || tx2 >= w) continue;
        const tp = ty2 * w + tx2;
        if (!known[tp]) continue;
        const ti = tp * 4;
        const si = ((sy + dy) * w + (sx + dx)) * 4;
        const dr = out.data[ti]! - src.data[si]!;
        const dg = out.data[ti + 1]! - src.data[si + 1]!;
        const db = out.data[ti + 2]! - src.data[si + 2]!;
        const da = out.data[ti + 3]! - src.data[si + 3]!;
        cost += dr * dr + dg * dg + db * db + da * da;
        n++;
      }
      if (n > 4 && cost / n > limit) return Infinity;
    }
    return n ? cost / n : Infinity;
  };

  // Pool of valid source centers for random search.
  const pool: number[] = [];
  const area = Math.max(1, (sx1 - sx0) * (sy1 - sy0));
  const step = Math.max(1, Math.floor(Math.sqrt(area / 40000)));
  for (let y = sy0; y <= sy1; y += step) for (let x = sx0; x <= sx1; x += step) if (sourceOk(x, y)) pool.push(y * w + x);
  if (pool.length === 0) return diffuseFill(out, hole);

  // Onion-peel order: multi-source BFS distance from the known region (8-connected).
  const order: number[] = [];
  const dist = new Int32Array(w * h).fill(-1);
  const queue: number[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.height; y++)
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const p = y * w + x;
      if (known[p]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && known[yy * w + xx] && dist[p] === -1) {
            dist[p] = 0;
            queue.push(p);
          }
        }
    }
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head]!;
    order.push(p);
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (!known[q] && dist[q] === -1) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
  }

  const offsetX = new Int32Array(w * h);
  const offsetY = new Int32Array(w * h);
  const hasOffset = new Uint8Array(w * h);

  for (const p of order) {
    const x = p % w;
    const y = (p - x) / w;
    let bestCost = Infinity;
    let best = -1;
    const tryCenter = (cx: number, cy: number) => {
      if (!sourceOk(cx, cy)) return;
      const c = patchCost(x, y, cx, cy, bestCost);
      if (c < bestCost) {
        bestCost = c;
        best = cy * w + cx;
      }
    };
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (hasOffset[q]) tryCenter(x + offsetX[q]!, y + offsetY[q]!);
      }
    for (let k = 0; k < randomSamples; k++) {
      const c = pool[Math.floor(rnd() * pool.length)]!;
      tryCenter(c % w, Math.floor(c / w));
    }
    if (best >= 0) {
      const bx = best % w;
      const by = (best - bx) / w;
      for (let rad = 8; rad >= 1; rad = Math.floor(rad / 2)) tryCenter(bx + Math.round((rnd() * 2 - 1) * rad), by + Math.round((rnd() * 2 - 1) * rad));
    }
    if (best < 0) best = pool[Math.floor(rnd() * pool.length)]!;
    const sx = best % w;
    const sy = (best - sx) / w;
    out.data.set(src.data.subarray(best * 4, best * 4 + 4), p * 4);
    offsetX[p] = sx - x;
    offsetY[p] = sy - y;
    hasOffset[p] = 1;
    known[p] = 1;
  }
  return smoothSeams(out, hole);
}

/** Fallback when no source patches exist (hole covers nearly everything): average-diffuse inward. */
export function diffuseFill(r: Raster, hole: Mask, iterations = 200): Raster {
  const out = cloneRaster(r);
  const w = r.width;
  const h = r.height;
  const unknown: number[] = [];
  for (let p = 0; p < w * h; p++) if (hole.data[p]! >= 128) unknown.push(p);
  for (let it = 0; it < iterations; it++) {
    for (const p of unknown) {
      const x = p % w;
      const y = (p - x) / w;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let n = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const i = (yy * w + xx) * 4;
        s0 += out.data[i]!;
        s1 += out.data[i + 1]!;
        s2 += out.data[i + 2]!;
        s3 += out.data[i + 3]!;
        n++;
      }
      const i = p * 4;
      out.data[i] = s0 / n;
      out.data[i + 1] = s1 / n;
      out.data[i + 2] = s2 / n;
      out.data[i + 3] = s3 / n;
    }
  }
  return out;
}

/** Light blur along the filled region's edge to hide seams. */
function smoothSeams(r: Raster, hole: Mask): Raster {
  const out = cloneRaster(r);
  const w = r.width;
  const h = r.height;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const inside = hole.data[p]! >= 128;
      let edge = false;
      for (const q of [p - 1, p + 1, p - w, p + w]) if (hole.data[q]! >= 128 !== inside) edge = true;
      if (!edge) continue;
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += r.data[((y + dy) * w + (x + dx)) * 4 + c]!;
        out.data[p * 4 + c] = s / 9;
      }
    }
  return out;
}

/**
 * Healing dab: copy a source patch, then shift its colors so the patch border matches the
 * destination border (a cheap, robust approximation of Poisson blending).
 */
export function healDab(r: Raster, cx: number, cy: number, radius: number, source: { x: number; y: number }): Raster {
  const out = cloneRaster(r);
  const w = r.width;
  const h = r.height;
  const rr = Math.max(1, Math.round(radius));
  const sumDst = [0, 0, 0];
  const sumSrc = [0, 0, 0];
  let n = 0;
  for (let a = 0; a < 32; a++) {
    const t = (a / 32) * Math.PI * 2;
    const dx = Math.round(cx + Math.cos(t) * (rr + 1));
    const dy = Math.round(cy + Math.sin(t) * (rr + 1));
    const sx = Math.round(source.x + Math.cos(t) * (rr + 1));
    const sy = Math.round(source.y + Math.sin(t) * (rr + 1));
    if (dx < 0 || dy < 0 || dx >= w || dy >= h || sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const di = (dy * w + dx) * 4;
    const si = (sy * w + sx) * 4;
    for (let c = 0; c < 3; c++) {
      sumDst[c]! += r.data[di + c]!;
      sumSrc[c]! += r.data[si + c]!;
    }
    n++;
  }
  const shift = n ? [0, 1, 2].map((c) => (sumDst[c]! - sumSrc[c]!) / n) : [0, 0, 0];
  for (let y = -rr; y <= rr; y++)
    for (let x = -rr; x <= rr; x++) {
      const d = Math.hypot(x, y);
      if (d > rr) continue;
      const tx = Math.round(cx + x);
      const ty = Math.round(cy + y);
      const sx = Math.round(source.x + x);
      const sy = Math.round(source.y + y);
      if (tx < 0 || ty < 0 || tx >= w || ty >= h || sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const fall = Math.min(1, (rr - d) / Math.max(1, rr * 0.35));
      const ti = (ty * w + tx) * 4;
      const si = (sy * w + sx) * 4;
      for (let c = 0; c < 3; c++) {
        const v = r.data[si + c]! + shift[c]!;
        out.data[ti + c] = r.data[ti + c]! + (v - r.data[ti + c]!) * fall;
      }
    }
  return out;
}

/** Extend the canvas (outpainting) by tiling-free texture synthesis into the new border. */
export function extendCanvas(r: Raster, pad: { top: number; right: number; bottom: number; left: number }, options: InpaintOptions = {}): Raster {
  const w = r.width + pad.left + pad.right;
  const h = r.height + pad.top + pad.bottom;
  const big = createRaster(w, h);
  const hole = { width: w, height: h, data: new Uint8ClampedArray(w * h).fill(255) };
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const si = (y * r.width + x) * 4;
      const p = (y + pad.top) * w + (x + pad.left);
      big.data.set(r.data.subarray(si, si + 4), p * 4);
      hole.data[p] = 0;
    }
  return contentAwareFill(big, hole, { searchMargin: 3, ...options });
}
