import type { BezierPath, VectorShape } from '@omnix/core';
import { pathSegments } from '@omnix/core';
import type { Ctx2D } from './host.js';

/** Trace a bezier path into the current context path. */
export function tracePath(ctx: Ctx2D, path: BezierPath): void {
  if (path.anchors.length === 0) return;
  const first = path.anchors[0]!;
  ctx.moveTo(first.x, first.y);
  for (const [, c1, c2, p] of pathSegments(path)) ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
  if (path.closed) ctx.closePath();
}

export function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Draw one vector shape (rect, ellipse, polygon, bezier path or line). */
export function drawShape(ctx: Ctx2D, s: VectorShape): void {
  ctx.beginPath();
  switch (s.kind) {
    case 'rect':
      if (s.radius) roundedRectPath(ctx, s.x, s.y, s.width, s.height, s.radius);
      else ctx.rect(s.x, s.y, s.width, s.height);
      break;
    case 'ellipse':
      ctx.ellipse(s.x + s.width / 2, s.y + s.height / 2, Math.abs(s.width / 2), Math.abs(s.height / 2), 0, 0, Math.PI * 2);
      break;
    case 'polygon':
    case 'line': {
      const pts = s.points ?? [];
      if (pts.length) {
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
        if (s.kind === 'polygon') ctx.closePath();
      }
      break;
    }
    case 'path':
      if (s.path) tracePath(ctx, s.path);
      break;
  }
  if (s.fill && s.kind !== 'line') {
    ctx.fillStyle = s.fill;
    ctx.fill();
  }
  if (s.stroke && s.strokeWidth > 0) {
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}
