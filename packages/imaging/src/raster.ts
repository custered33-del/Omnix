/** RGBA pixels with straight (non-premultiplied) alpha, row-major. Compatible with ImageData. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Single-channel 8-bit coverage mask (0 = unselected, 255 = fully selected). */
export interface Mask {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createRaster(width: number, height: number, fill?: [number, number, number, number]): Raster {
  if (!(width > 0 && height > 0)) throw new Error(`Invalid raster size ${width}x${height}`);
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width, height, data };
}

export function createMask(width: number, height: number, value = 0): Mask {
  const data = new Uint8ClampedArray(width * height);
  if (value) data.fill(value);
  return { width, height, data };
}

export function cloneRaster(r: Raster): Raster {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
}

export function cloneMask(m: Mask): Mask {
  return { width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) };
}

export function getPixel(r: Raster, x: number, y: number): [number, number, number, number] {
  const xi = Math.min(r.width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(r.height - 1, Math.max(0, Math.round(y)));
  const i = (yi * r.width + xi) * 4;
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!, r.data[i + 3]!];
}

export function setPixel(r: Raster, x: number, y: number, p: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const i = (y * r.width + x) * 4;
  r.data[i] = p[0];
  r.data[i + 1] = p[1];
  r.data[i + 2] = p[2];
  r.data[i + 3] = p[3];
}

/** Mean color of the raster (optionally restricted by a mask), alpha-weighted. */
export function meanColor(r: Raster, mask?: Mask): [number, number, number] {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let w = 0;
  for (let p = 0, i = 0; p < r.width * r.height; p++, i += 4) {
    const a = (r.data[i + 3]! / 255) * (mask ? mask.data[p]! / 255 : 1);
    if (a <= 0) continue;
    sr += r.data[i]! * a;
    sg += r.data[i + 1]! * a;
    sb += r.data[i + 2]! * a;
    w += a;
  }
  return w ? [sr / w, sg / w, sb / w] : [0, 0, 0];
}

/** Per-channel histogram (256 bins each) plus luminance. */
export function histogram(r: Raster): { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array } {
  const h = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
  for (let i = 0; i < r.data.length; i += 4) {
    if (r.data[i + 3] === 0) continue;
    const R = r.data[i]!;
    const G = r.data[i + 1]!;
    const B = r.data[i + 2]!;
    h.r[R]!++;
    h.g[G]!++;
    h.b[B]!++;
    h.l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]!++;
  }
  return h;
}

/** Copy a rectangular region (clamped to bounds). */
export function crop(r: Raster, x: number, y: number, w: number, h: number): Raster {
  const out = createRaster(Math.max(1, w), Math.max(1, h));
  for (let yy = 0; yy < h; yy++) {
    const sy = y + yy;
    if (sy < 0 || sy >= r.height) continue;
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx;
      if (sx < 0 || sx >= r.width) continue;
      const si = (sy * r.width + sx) * 4;
      const di = (yy * w + xx) * 4;
      out.data[di] = r.data[si]!;
      out.data[di + 1] = r.data[si + 1]!;
      out.data[di + 2] = r.data[si + 2]!;
      out.data[di + 3] = r.data[si + 3]!;
    }
  }
  return out;
}

/** Blend `next` over `base` using a coverage mask: result = base*(1-m) + next*m. */
export function mixByMask(base: Raster, next: Raster, mask: Mask | null, amount = 1): Raster {
  const out = cloneRaster(base);
  for (let p = 0, i = 0; p < base.width * base.height; p++, i += 4) {
    const m = (mask ? mask.data[p]! / 255 : 1) * amount;
    if (m <= 0) continue;
    for (let c = 0; c < 4; c++) out.data[i + c] = base.data[i + c]! + (next.data[i + c]! - base.data[i + c]!) * m;
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so filters like noise are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
