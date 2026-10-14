import type { BlendMode } from '@omnix/core';
import { cloneRaster, type Mask, type Raster } from './raster.js';

/**
 * W3C Compositing and Blending Level 1 blend modes, implemented in software so
 * server-side export, PSD layer export and tests produce the same result as the
 * browser's canvas `globalCompositeOperation`.
 */

type RGB = [number, number, number];

const separable: Partial<Record<BlendMode, (cb: number, cs: number) => number>> = {
  normal: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'hard-light': (b, s) => hardLight(b, s),
  'soft-light': (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

function hardLight(b: number, s: number): number {
  return s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1);
}

const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

function clipColor(c: RGB): RGB {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out: RGB = [...c];
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as RGB;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as RGB;
  return out;
}

function setLum(c: RGB, l: number): RGB {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

const sat = (c: RGB) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c: RGB, s: number): RGB {
  const idx = [0, 1, 2].sort((a, b) => c[a]! - c[b]!);
  const [mn, md, mx] = idx as [number, number, number];
  const out: RGB = [0, 0, 0];
  if (c[mx] > c[mn]) {
    out[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]);
    out[mx] = s;
  }
  out[mn] = 0;
  return out;
}

function nonSeparable(mode: BlendMode, b: RGB, s: RGB): RGB {
  switch (mode) {
    case 'hue':
      return setLum(setSat(s, sat(b)), lum(b));
    case 'saturation':
      return setLum(setSat(b, sat(s)), lum(b));
    case 'color':
      return setLum(s, lum(b));
    case 'luminosity':
      return setLum(b, lum(s));
    default:
      return s;
  }
}

/** Blend one source color over a backdrop color (both 0..1, straight alpha). Returns 0..1 RGBA. */
export function blendPixel(mode: BlendMode, backdrop: [number, number, number, number], source: [number, number, number, number]): [number, number, number, number] {
  const ab = backdrop[3];
  const as = source[3];
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const cb: RGB = [backdrop[0], backdrop[1], backdrop[2]];
  const cs: RGB = [source[0], source[1], source[2]];
  let mixed: RGB;
  const f = separable[mode];
  if (f) mixed = [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])];
  else mixed = nonSeparable(mode, cb, cs);
  const out: [number, number, number, number] = [0, 0, 0, ao];
  for (let c = 0; c < 3; c++) {
    // Cs' = (1 - ab) * Cs + ab * B(Cb, Cs); then source-over.
    const csPrime = (1 - ab) * cs[c]! + ab * mixed[c]!;
    out[c] = (as * csPrime + ab * cb[c]! * (1 - as)) / ao;
  }
  return out;
}

/**
 * Composite `src` onto `dst` at (dx, dy) with a blend mode, opacity and optional mask
 * (mask is in `src` coordinates). Returns a new raster the size of `dst`.
 */
export function composite(dst: Raster, src: Raster, mode: BlendMode = 'normal', opacity = 1, dx = 0, dy = 0, mask?: Mask | null): Raster {
  const out = cloneRaster(dst);
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(dst.width, dx + src.width);
  const y1 = Math.min(dst.height, dy + src.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const sx = x - dx;
      const sy = y - dy;
      const si = (sy * src.width + sx) * 4;
      const m = mask ? mask.data[sy * src.width + sx]! / 255 : 1;
      const a = (src.data[si + 3]! / 255) * opacity * m;
      if (a <= 0) continue;
      const di = (y * dst.width + x) * 4;
      const res = blendPixel(
        mode,
        [out.data[di]! / 255, out.data[di + 1]! / 255, out.data[di + 2]! / 255, out.data[di + 3]! / 255],
        [src.data[si]! / 255, src.data[si + 1]! / 255, src.data[si + 2]! / 255, a],
      );
      out.data[di] = res[0] * 255;
      out.data[di + 1] = res[1] * 255;
      out.data[di + 2] = res[2] * 255;
      out.data[di + 3] = res[3] * 255;
    }
  }
  return out;
}
