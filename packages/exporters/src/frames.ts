import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import UPNG from 'upng-js';
import type { Raster } from '@omnix/imaging';

/**
 * Animated image encoders for the animation maker. Frames are full RGBA rasters of equal size.
 */

export interface AnimatedEncodeOptions {
  fps: number;
  /** 0 = loop forever, n = play n times (GIF/APNG semantics). */
  loops?: number;
}

/** GIF with a shared palette built from sampled frames (stable colors, no flicker) and 1-bit transparency. */
export function encodeGif(frames: Raster[], options: AnimatedEncodeOptions): Buffer {
  if (!frames.length) throw new Error('No frames to encode');
  const { width, height } = frames[0]!;
  const sampleCount = Math.min(frames.length, 12);
  const sampleSize = width * height * 4;
  const sample = new Uint8ClampedArray(sampleSize * sampleCount);
  for (let i = 0; i < sampleCount; i++) sample.set(frames[Math.floor((i * frames.length) / sampleCount)]!.data, i * sampleSize);
  const hasAlpha = frames.some((f) => {
    for (let i = 3; i < f.data.length; i += 4 * 7) if (f.data[i]! < 128) return true;
    return false;
  });
  const palette = quantize(sample, 256, { format: hasAlpha ? 'rgba4444' : 'rgb565', oneBitAlpha: hasAlpha });
  const transparentIndex = hasAlpha ? palette.findIndex((c) => c.length > 3 && c[3] === 0) : -1;
  const gif = GIFEncoder();
  const delay = Math.round(1000 / Math.max(1, options.fps));
  frames.forEach((f, i) => {
    const index = applyPalette(f.data, palette, hasAlpha ? 'rgba4444' : 'rgb565');
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay,
      repeat: i === 0 ? (options.loops === undefined ? 0 : options.loops === 0 ? 0 : options.loops) : undefined,
      ...(transparentIndex >= 0 ? { transparent: true, transparentIndex, dispose: 2 } : {}),
    });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** Lossless animated PNG (full 8-bit alpha). */
export function encodeApng(frames: Raster[], options: AnimatedEncodeOptions): Buffer {
  if (!frames.length) throw new Error('No frames to encode');
  const { width, height } = frames[0]!;
  const bufs = frames.map((f) => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer);
  const delays = frames.map(() => Math.round(1000 / Math.max(1, options.fps)));
  const out = Buffer.from(UPNG.encode(bufs, width, height, 0, delays));
  // UPNG writes num_plays = 0 (infinite). Patch acTL when a finite loop count is requested.
  if (options.loops && options.loops > 0) {
    const i = out.indexOf('acTL');
    if (i > 0) out.writeUInt32BE(options.loops, i + 8);
  }
  return out;
}

/** Decode an APNG/PNG back into frames (used by tests and sprite import). */
export function decodeApng(data: Buffer): { width: number; height: number; frames: Raster[]; delays: number[] } {
  const img = UPNG.decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const rgba = UPNG.toRGBA8(img);
  return { width: img.width, height: img.height, frames: rgba.map((b) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(b) })), delays: img.frames.map((f) => f.delay) };
}
