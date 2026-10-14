import type { Lut3D, Mask, Raster } from '@omnix/imaging';

/**
 * The renderer draws with the standard Canvas 2D API so the same code runs in the
 * browser (HTMLCanvasElement / OffscreenCanvas) and on the server (@napi-rs/canvas,
 * Skia). Hosts provide canvases and already-decoded media.
 */
export type Ctx2D = CanvasRenderingContext2D;

export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): Ctx2D | null;
}

/** Anything drawImage accepts that also reports a size. */
export interface Drawable {
  width: number;
  height: number;
}

export interface RenderHost {
  createCanvas(width: number, height: number): CanvasLike;
  /** A decoded still image (or video poster frame) for an asset, if loaded. */
  image(assetId: string): Drawable | null;
  /** A decoded video frame at a source time (seconds). Falls back to `image` when absent. */
  videoFrame?(assetId: string, time: number): Drawable | null;
  /** A parsed 3D LUT for LUT adjustments. */
  lut?(assetId: string): Lut3D | undefined;
  /** A decoded selection/mask asset. */
  mask?(assetId: string): Mask | undefined;
  /** Default font stack fallback appended to every font family. */
  fontFallback?: string;
  /** Color scheme for chart chrome. */
  scheme?: 'light' | 'dark';
}

export function ctxOf(c: CanvasLike): Ctx2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

export function drawable(d: Drawable | CanvasLike): CanvasImageSource {
  return d as unknown as CanvasImageSource;
}

/** Read a canvas into a Raster (straight alpha). */
export function readRaster(c: CanvasLike): Raster {
  const img = ctxOf(c).getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer.slice(0)) };
}

/** Write a Raster into a canvas (replacing its pixels). */
export function writeRaster(c: CanvasLike, r: Raster): void {
  const ctx = ctxOf(c);
  const img = ctx.createImageData(r.width, r.height);
  img.data.set(r.data);
  ctx.putImageData(img, 0, 0);
}

/** Copy of a canvas (used for snapshots during compositing). */
export function cloneCanvas(host: RenderHost, c: CanvasLike): CanvasLike {
  const out = host.createCanvas(c.width, c.height);
  ctxOf(out).drawImage(drawable(c), 0, 0);
  return out;
}

/** Build a canvas whose alpha is the given mask (for destination-in masking). */
export function maskToCanvas(host: RenderHost, m: Mask): CanvasLike {
  const c = host.createCanvas(m.width, m.height);
  const ctx = ctxOf(c);
  const img = ctx.createImageData(m.width, m.height);
  for (let p = 0; p < m.data.length; p++) {
    img.data[p * 4 + 3] = m.data[p]!;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function fontStack(host: RenderHost, family: string | null | undefined): string {
  const fam = family && family.trim() ? `"${family.replace(/"/g, '')}"` : '';
  const fallback = host.fontFallback ?? 'Inter, "Helvetica Neue", Arial, sans-serif';
  return fam ? `${fam}, ${fallback}` : fallback;
}

/** Draw an image to cover or fit a rectangle. */
export function drawFitted(ctx: Ctx2D, img: Drawable, x: number, y: number, w: number, h: number, mode: 'contain' | 'cover' = 'contain'): void {
  if (!img.width || !img.height) return;
  const s = mode === 'cover' ? Math.max(w / img.width, h / img.height) : Math.min(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  if (mode === 'cover') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(drawable(img), x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(drawable(img), x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
}

/** A checkerboard used behind transparent content in editors and thumbnails. */
export function drawCheckerboard(ctx: Ctx2D, w: number, h: number, size = 8, a = '#ffffff', b = '#e8e8e8'): void {
  ctx.save();
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = b;
  for (let y = 0; y < h; y += size) for (let x = (y / size) % 2 ? size : 0; x < w; x += size * 2) ctx.fillRect(x, y, size, size);
  ctx.restore();
}
