import type { Stroke, StrokePoint } from '@omnix/core';
import { healDab } from '@omnix/imaging';
import { ctxOf, drawable, readRaster, writeRaster, type CanvasLike, type RenderHost } from './host.js';

export interface Dab {
  x: number;
  y: number;
  radius: number;
  pressure: number;
}

/** Size scaling from stylus pressure. A light touch still leaves a visible mark. */
export function pressureScale(p: number): number {
  return 0.25 + 0.75 * Math.min(1, Math.max(0, p));
}

/** Turn stroke points into evenly spaced brush dabs (spacing is a fraction of the dab size). */
export function strokeDabs(stroke: Pick<Stroke, 'points' | 'size' | 'spacing'>): Dab[] {
  const pts = stroke.points;
  if (pts.length === 0) return [];
  const dabs: Dab[] = [];
  const radiusAt = (p: StrokePoint) => (stroke.size / 2) * pressureScale(p.pressure);
  const first = pts[0]!;
  const firstRadius = radiusAt(first);
  dabs.push({ x: first.x, y: first.y, radius: firstRadius, pressure: first.pressure });
  // Distance along the path until the next dab is due.
  let next = Math.max(0.5, firstRadius * 2 * stroke.spacing);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg === 0) continue;
    let pos = next;
    while (pos <= seg) {
      const t = pos / seg;
      const pressure = a.pressure + (b.pressure - a.pressure) * t;
      const r = (stroke.size / 2) * pressureScale(pressure);
      dabs.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, radius: r, pressure });
      pos += Math.max(0.5, r * 2 * stroke.spacing);
    }
    next = pos - seg;
  }
  return dabs;
}

function tintedTip(host: RenderHost, stroke: Stroke): CanvasLike | null {
  if (typeof stroke.tip !== 'object') return null;
  const img = host.image(stroke.tip.assetId);
  if (!img) return null;
  const size = Math.max(4, Math.ceil(stroke.size));
  const c = host.createCanvas(size, size);
  const ctx = ctxOf(c);
  ctx.drawImage(drawable(img), 0, 0, size, size);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = stroke.color;
  ctx.fillRect(0, 0, size, size);
  return c;
}

function stampDabs(host: RenderHost, target: CanvasLike, stroke: Stroke, dabs: Dab[], color: string): void {
  const ctx = ctxOf(target);
  const tip = tintedTip(host, stroke);
  for (const d of dabs) {
    if (tip) {
      ctx.drawImage(drawable(tip), d.x - d.radius, d.y - d.radius, d.radius * 2, d.radius * 2);
    } else if (stroke.tip === 'square') {
      ctx.fillStyle = color;
      ctx.fillRect(d.x - d.radius, d.y - d.radius, d.radius * 2, d.radius * 2);
    } else {
      const hard = Math.min(0.999, Math.max(0, stroke.hardness));
      if (hard >= 0.98) {
        ctx.fillStyle = color;
      } else {
        const g = ctx.createRadialGradient(d.x, d.y, d.radius * hard, d.x, d.y, d.radius);
        g.addColorStop(0, color);
        g.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = g;
      }
      ctx.beginPath();
      ctx.arc(d.x, d.y, Math.max(0.5, d.radius), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Paint strokes onto a layer canvas (layer-local coordinates). Each stroke is built on its own
 * buffer so overlapping dabs never exceed the stroke's opacity, like a real brush with flow 100%.
 */
export function renderStrokes(host: RenderHost, layer: CanvasLike, strokes: readonly Stroke[], clipMask?: (sel: NonNullable<Stroke['clip']>) => CanvasLike | null): void {
  const ctx = ctxOf(layer);
  for (const stroke of strokes) {
    const dabs = strokeDabs(stroke);
    if (dabs.length === 0) continue;
    if (stroke.tool === 'heal') {
      let r = readRaster(layer);
      const off = stroke.sourceOffset ?? { x: 20, y: 0 };
      const step = Math.max(1, Math.ceil(dabs.length / 400));
      for (let i = 0; i < dabs.length; i += step) {
        const d = dabs[i]!;
        r = healDab(r, d.x, d.y, d.radius, { x: d.x + off.x, y: d.y + off.y });
      }
      writeRaster(layer, r);
      continue;
    }
    const buf = host.createCanvas(layer.width, layer.height);
    const bctx = ctxOf(buf);
    stampDabs(host, buf, stroke, dabs, stroke.tool === 'eraser' ? '#000000' : stroke.color);
    if (stroke.tool === 'clone') {
      const off = stroke.sourceOffset ?? { x: 20, y: 0 };
      const snapshot = host.createCanvas(layer.width, layer.height);
      ctxOf(snapshot).drawImage(drawable(layer), 0, 0);
      bctx.globalCompositeOperation = 'source-in';
      bctx.drawImage(drawable(snapshot), -off.x, -off.y);
    }
    if (stroke.clip && clipMask) {
      const m = clipMask(stroke.clip);
      if (m) {
        bctx.save();
        bctx.globalCompositeOperation = 'destination-in';
        bctx.drawImage(drawable(m), 0, 0);
        bctx.restore();
      }
    }
    ctx.save();
    ctx.globalAlpha = stroke.opacity;
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.drawImage(drawable(buf), 0, 0);
    ctx.restore();
  }
}
