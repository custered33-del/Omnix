import { createMask, createRaster, clamp255, type Mask, type Raster } from './raster.js';
import { sharpen } from './filters.js';

/** Bilinear resize on premultiplied alpha. */
export function resizeBilinear(r: Raster, w: number, h: number): Raster {
  const out = createRaster(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const sx = r.width / out.width;
  const sy = r.height / out.height;
  for (let y = 0; y < out.height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(r.height - 1, Math.floor(fy));
    const y1 = Math.min(r.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < out.width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(r.width - 1, Math.floor(fx));
      const x1 = Math.min(r.width - 1, x0 + 1);
      const tx = fx - x0;
      const idx = [(y0 * r.width + x0) * 4, (y0 * r.width + x1) * 4, (y1 * r.width + x0) * 4, (y1 * r.width + x1) * 4];
      const wts = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      let a = 0;
      const c = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const al = (r.data[idx[k]! + 3]! / 255) * wts[k]!;
        a += al;
        for (let ch = 0; ch < 3; ch++) c[ch]! += r.data[idx[k]! + ch]! * al;
      }
      const o = (y * out.width + x) * 4;
      out.data[o] = a > 0 ? c[0]! / a : 0;
      out.data[o + 1] = a > 0 ? c[1]! / a : 0;
      out.data[o + 2] = a > 0 ? c[2]! / a : 0;
      out.data[o + 3] = a * 255;
    }
  }
  return out;
}

export function resizeMask(m: Mask, w: number, h: number): Mask {
  const out = createMask(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const sx = m.width / out.width;
  const sy = m.height / out.height;
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const fx = Math.min(m.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const fy = Math.min(m.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(m.width - 1, x0 + 1);
      const y1 = Math.min(m.height - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const v =
        m.data[y0 * m.width + x0]! * (1 - tx) * (1 - ty) +
        m.data[y0 * m.width + x1]! * tx * (1 - ty) +
        m.data[y1 * m.width + x0]! * (1 - tx) * ty +
        m.data[y1 * m.width + x1]! * tx * ty;
      out.data[y * out.width + x] = v;
    }
  return out;
}

function lanczos(x: number, a = 3): number {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/** Separable Lanczos-3 resampling (high quality, used for upscaling and export resizing). */
export function resizeLanczos(r: Raster, w: number, h: number): Raster {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const pass = (src: Float32Array, sw: number, sh: number, dw: number, horizontal: boolean): Float32Array => {
    const dh = horizontal ? sh : dw;
    const outW = horizontal ? dw : sw;
    const out = new Float32Array(outW * dh * 4);
    const srcLen = horizontal ? sw : sh;
    const dstLen = horizontal ? dw : dh;
    const scale = srcLen / dstLen;
    const support = Math.max(1, scale) * 3;
    for (let d = 0; d < dstLen; d++) {
      const center = (d + 0.5) * scale - 0.5;
      const lo = Math.max(0, Math.floor(center - support));
      const hi = Math.min(srcLen - 1, Math.ceil(center + support));
      const weights: number[] = [];
      let wsum = 0;
      for (let s = lo; s <= hi; s++) {
        const wv = lanczos((s - center) / Math.max(1, scale));
        weights.push(wv);
        wsum += wv;
      }
      const lines = horizontal ? sh : sw;
      for (let line = 0; line < lines; line++) {
        const acc = [0, 0, 0, 0];
        for (let s = lo; s <= hi; s++) {
          const si = horizontal ? (line * sw + s) * 4 : (s * sw + line) * 4;
          const wv = weights[s - lo]! / wsum;
          for (let c = 0; c < 4; c++) acc[c]! += src[si + c]! * wv;
        }
        const oi = horizontal ? (line * dw + d) * 4 : (d * sw + line) * 4;
        for (let c = 0; c < 4; c++) out[oi + c] = acc[c]!;
      }
    }
    return out;
  };
  // Premultiply
  const pre = new Float32Array(r.data.length);
  for (let i = 0; i < r.data.length; i += 4) {
    const a = r.data[i + 3]! / 255;
    pre[i] = r.data[i]! * a;
    pre[i + 1] = r.data[i + 1]! * a;
    pre[i + 2] = r.data[i + 2]! * a;
    pre[i + 3] = r.data[i + 3]!;
  }
  const hpass = pass(pre, r.width, r.height, W, true);
  const vpass = pass(hpass, W, r.height, H, false);
  const out = createRaster(W, H);
  for (let i = 0; i < out.data.length; i += 4) {
    const a = clamp255(vpass[i + 3]!);
    const af = a / 255;
    out.data[i] = af > 0 ? clamp255(vpass[i]! / af) : 0;
    out.data[i + 1] = af > 0 ? clamp255(vpass[i + 1]! / af) : 0;
    out.data[i + 2] = af > 0 ? clamp255(vpass[i + 2]! / af) : 0;
    out.data[i + 3] = a;
  }
  return out;
}

/**
 * Built-in upscaler: Lanczos resampling followed by a gentle unsharp mask.
 * A model-based upscaler can be plugged in through the AI provider layer.
 */
export function upscale(r: Raster, factor: number): Raster {
  const f = Math.min(8, Math.max(1, factor));
  const big = resizeLanczos(r, r.width * f, r.height * f);
  return sharpen(big, 0.35 * Math.log2(f + 1), Math.max(1, f * 0.6));
}

/** Fit (w, h) into a bounding box keeping aspect ratio. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
