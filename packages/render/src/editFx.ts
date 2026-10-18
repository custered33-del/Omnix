import type { EditFxKind } from '@omnix/core';
import { EDIT_FX_DEFAULTS } from '@omnix/core';
import { ctxOf, drawable, readRaster, writeRaster, type CanvasLike, type Ctx2D, type RenderHost } from './host.js';

/**
 * Moving effects for edits (Recense). Each works on a finished picture in place, at `local` seconds
 * into an effect that lasts `length` seconds. Hits (shake, punch, flash) are strongest at the start
 * and fade out, so they land on the beat.
 */
export function applyEditFx(host: RenderHost, canvas: CanvasLike, effect: EditFxKind, params: Record<string, number>, local: number, length: number): void {
  const p = { ...EDIT_FX_DEFAULTS[effect], ...params };
  const amount = Math.max(0, Math.min(1, p.amount ?? 0.5));
  if (amount <= 0) return;
  const W = canvas.width;
  const H = canvas.height;
  const u = length > 0 ? Math.min(1, Math.max(0, local / length)) : 0;
  const fade = (1 - u) * (1 - u);
  const ctx = ctxOf(canvas);
  switch (effect) {
    case 'shake': {
      const sp = p.speed ?? 18;
      const k = amount * fade;
      const dx = W * 0.05 * k * Math.sin(local * sp * 6.1 + 1.3) * Math.cos(local * sp * 2.3);
      const dy = H * 0.04 * k * Math.sin(local * sp * 5.3 + 0.4);
      const rot = 0.05 * k * Math.sin(local * sp * 3.7);
      transformInPlace(host, canvas, { dx, dy, rot, scale: 1 + 0.08 * k });
      break;
    }
    case 'zoomPunch': {
      // In fast, ease back out; a little zoom blur at the peak.
      const k = amount * (u < 0.15 ? u / 0.15 : ((1 - u) / 0.85) ** 2);
      const s = 1 + 0.35 * Math.min(1, k);
      transformInPlace(host, canvas, { scale: s, ghosts: k > 0.3 ? 3 : 0, ghostSpread: 0.04 * k });
      break;
    }
    case 'flash': {
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${(amount * fade).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      break;
    }
    case 'strobe': {
      const rate = p.rate ?? 8;
      if (Math.floor(local * rate * 2) % 2 === 0) {
        ctx.save();
        ctx.fillStyle = `rgba(255,255,255,${(amount * 0.85).toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      break;
    }
    case 'letterbox': {
      const bar = Math.round(H * Math.min(0.4, amount));
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
      ctx.restore();
      break;
    }
    case 'rgbSplit': {
      const off = Math.max(1, Math.round(W * 0.015 * amount * (0.35 + 0.65 * fade)));
      writeRaster(canvas, splitChannels(readRaster(canvas), off));
      break;
    }
    case 'glitch': {
      const frame = Math.floor(local * 15) + (p.seed ?? 1) * 7919;
      writeRaster(canvas, glitchSlices(readRaster(canvas), amount * (0.4 + 0.6 * fade), frame));
      break;
    }
    case 'vhs': {
      const r = splitChannels(readRaster(canvas), Math.max(1, Math.round(W * 0.004 * amount)));
      // Scanlines, a soft rolling band and a little colour bleed.
      const band = ((local * 0.35) % 1) * H;
      const d = r.data;
      for (let y = 0; y < H; y++) {
        const dark = y % 3 === 0 ? 1 - 0.18 * amount : 1;
        const inBand = Math.abs(y - band) < H * 0.03;
        const shift = inBand ? Math.round(W * 0.01 * amount) : 0;
        const row = y * W * 4;
        if (shift) d.copyWithin(row + shift * 4, row, row + (W - shift) * 4);
        for (let x = 0; x < W; x++) {
          const i = row + x * 4;
          d[i] = d[i]! * dark;
          d[i + 1] = d[i + 1]! * dark * 0.97;
          d[i + 2] = d[i + 2]! * dark;
        }
      }
      writeRaster(canvas, r);
      break;
    }
  }
}

interface Move {
  dx?: number;
  dy?: number;
  rot?: number;
  scale?: number;
  /** Extra faint copies, slightly bigger, for a zoom blur. */
  ghosts?: number;
  ghostSpread?: number;
}

function transformInPlace(host: RenderHost, canvas: CanvasLike, m: Move): void {
  const W = canvas.width;
  const H = canvas.height;
  const copy = host.createCanvas(W, H);
  ctxOf(copy).drawImage(drawable(canvas), 0, 0);
  const ctx = ctxOf(canvas);
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const draw = (scale: number, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2 + (m.dx ?? 0), H / 2 + (m.dy ?? 0));
    if (m.rot) ctx.rotate(m.rot);
    ctx.scale(scale, scale);
    ctx.drawImage(drawable(copy), -W / 2, -H / 2, W, H);
    ctx.restore();
  };
  draw(m.scale ?? 1, 1);
  for (let g = 1; g <= (m.ghosts ?? 0); g++) draw((m.scale ?? 1) * (1 + (m.ghostSpread ?? 0) * g), 0.22);
  ctx.restore();
}

/** Red one way, blue the other. */
function splitChannels(r: { width: number; height: number; data: Uint8ClampedArray }, off: number) {
  const { width: W, height: H, data } = r;
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4;
      const xr = Math.min(W - 1, x + off);
      const xb = Math.max(0, x - off);
      out[i] = data[row + xr * 4]!;
      out[i + 2] = data[row + xb * 4 + 2]!;
    }
  }
  return { width: W, height: H, data: out };
}

function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Bands of rows pushed sideways, some with their colours split. Changes every few frames. */
function glitchSlices(r: { width: number; height: number; data: Uint8ClampedArray }, k: number, seed: number) {
  const { width: W, height: H, data } = r;
  const out = new Uint8ClampedArray(data);
  const rnd = rand(seed);
  const bands = 3 + Math.floor(rnd() * 6 * k + 2);
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor(rnd() * H);
    const h = Math.max(2, Math.floor(rnd() * H * 0.08 * (0.3 + k)));
    const shift = Math.round((rnd() - 0.5) * 2 * W * 0.1 * k);
    const split = rnd() < 0.5 ? Math.round(W * 0.02 * k) : 0;
    for (let y = y0; y < Math.min(H, y0 + h); y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        const sx = Math.min(W - 1, Math.max(0, x - shift));
        const i = row + x * 4;
        const j = row + sx * 4;
        out[i] = data[row + Math.min(W - 1, Math.max(0, sx + split)) * 4]!;
        out[i + 1] = data[j + 1]!;
        out[i + 2] = data[row + Math.min(W - 1, Math.max(0, sx - split)) * 4 + 2]!;
      }
    }
  }
  return { width: W, height: H, data: out };
}

/** Draw `draw` with a sideways move and faint copies trailing behind it (motion blur). */
export function drawWithMotion(ctx: Ctx2D, draw: (c: Ctx2D) => void, dx: number, blur: number, copies = 4): void {
  for (let k = copies; k >= 0; k--) {
    ctx.save();
    ctx.globalAlpha *= k === 0 ? 1 : 0.18;
    ctx.translate(dx - Math.sign(dx || 1) * blur * (k / copies), 0);
    draw(ctx);
    ctx.restore();
  }
}
