import { blurMask, createMask, removeBackground, type Mask, type Raster } from '@omnix/imaging';

/**
 * Named image regions for commands like "make the sky warmer": deterministic masks computed from
 * the pixels, so the change lands as an ordinary masked adjustment layer the user can inspect.
 */

function downscale(r: Raster, max: number): { r: Raster; f: number } {
  const f = Math.min(1, max / Math.max(r.width, r.height));
  if (f === 1) return { r, f };
  const w = Math.max(1, Math.round(r.width * f));
  const h = Math.max(1, Math.round(r.height * f));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(r.width - 1, Math.floor(x / f));
      const sy = Math.min(r.height - 1, Math.floor(y / f));
      const si = (sy * r.width + sx) * 4;
      const di = (y * w + x) * 4;
      data[di] = r.data[si]!;
      data[di + 1] = r.data[si + 1]!;
      data[di + 2] = r.data[si + 2]!;
      data[di + 3] = r.data[si + 3]!;
    }
  return { r: { width: w, height: h, data }, f };
}

function upscaleMask(m: Mask, width: number, height: number): Mask {
  if (m.width === width && m.height === height) return m;
  const out = createMask(width, height);
  const fx = m.width / width;
  const fy = m.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(m.height - 1, (y + 0.5) * fy - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(m.height - 1, y0 + 1);
    const ty = Math.max(0, sy - y0);
    for (let x = 0; x < width; x++) {
      const sx = Math.min(m.width - 1, (x + 0.5) * fx - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(m.width - 1, x0 + 1);
      const tx = Math.max(0, sx - x0);
      const a = m.data[y0 * m.width + x0]! * (1 - tx) + m.data[y0 * m.width + x1]! * tx;
      const b = m.data[y1 * m.width + x0]! * (1 - tx) + m.data[y1 * m.width + x1]! * tx;
      out.data[y * width + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/**
 * Sky: grow a region from the top edge through smoothly changing, reasonably bright colors that stay
 * close to the colors along the top of the frame. Returns null when no sky-like region is found.
 */
export function skyMask(full: Raster): Mask | null {
  const { r } = downscale(full, 480);
  const { width: w, height: h, data } = r;
  const band = Math.max(1, Math.round(h * 0.04));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let y = 0; y < band; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3]! < 128) continue;
      sr += data[i]!;
      sg += data[i + 1]!;
      sb += data[i + 2]!;
      n++;
    }
  if (!n) return null;
  const seed = [sr / n, sg / n, sb / n];
  const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  const seedLum = 0.2126 * seed[0]! + 0.7152 * seed[1]! + 0.0722 * seed[2]!;
  if (seedLum < 50) return null; // a dark top edge is rarely sky
  const near = (i: number, j: number) => Math.abs(data[i]! - data[j]!) + Math.abs(data[i + 1]! - data[j + 1]!) + Math.abs(data[i + 2]! - data[j + 2]!) < 30;
  const likeSeed = (i: number) => Math.abs(data[i]! - seed[0]!) + Math.abs(data[i + 1]! - seed[1]!) + Math.abs(data[i + 2]! - seed[2]!) < 150 && lum(i) > seedLum * 0.55;
  const m = createMask(w, h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    const i = x * 4;
    if (data[i + 3]! >= 128 && likeSeed(i)) {
      m.data[x] = 255;
      stack.push(x);
    }
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    const visit = (q: number) => {
      if (m.data[q]) return;
      if (near(p * 4, q * 4) && likeSeed(q * 4)) {
        m.data[q] = 255;
        stack.push(q);
      }
    };
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (y > 0) visit(p - w);
    if (y < h - 1) visit(p + w);
  }
  let covered = 0;
  for (const v of m.data) if (v) covered++;
  if (covered < w * h * 0.03) return null;
  return upscaleMask(blurMask(m, 1.5), full.width, full.height);
}

/** The main subject (person, product) as a mask; the background is its inverse. */
export function subjectMask(r: Raster): Mask | null {
  const small = downscale(r, 640);
  const { mask } = removeBackground(small.r, { method: 'auto' });
  let kept = 0;
  for (const v of mask.data) kept += v > 127 ? 1 : 0;
  if (kept < mask.data.length * 0.01 || kept > mask.data.length * 0.97) return null;
  return upscaleMask(mask, r.width, r.height);
}

export function invertMask(m: Mask): Mask {
  const out = createMask(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) out.data[i] = 255 - m.data[i]!;
  return out;
}
