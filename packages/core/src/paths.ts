import type { Point } from './types.js';

/** An anchor point with optional absolute bezier handles. */
export interface PathAnchor {
  x: number;
  y: number;
  in?: Point;
  out?: Point;
}

export interface BezierPath {
  closed: boolean;
  anchors: PathAnchor[];
}

export function pathFromPoints(points: Point[], closed = false): BezierPath {
  return { closed, anchors: points.map((p) => ({ x: p.x, y: p.y })) };
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Each segment as four control points. */
export function pathSegments(path: BezierPath): [Point, Point, Point, Point][] {
  const segs: [Point, Point, Point, Point][] = [];
  const n = path.anchors.length;
  const count = path.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = path.anchors[i]!;
    const b = path.anchors[(i + 1) % n]!;
    segs.push([{ x: a.x, y: a.y }, a.out ?? { x: a.x, y: a.y }, b.in ?? { x: b.x, y: b.y }, { x: b.x, y: b.y }]);
  }
  return segs;
}

/** Flatten a path into a polyline with `stepsPerSegment` samples per segment. */
export function flattenPath(path: BezierPath, stepsPerSegment = 24): Point[] {
  const segs = pathSegments(path);
  if (segs.length === 0) return path.anchors.length ? [{ x: path.anchors[0]!.x, y: path.anchors[0]!.y }] : [];
  const out: Point[] = [segs[0]![0]];
  for (const s of segs) {
    for (let i = 1; i <= stepsPerSegment; i++) out.push(cubicPoint(s[0], s[1], s[2], s[3], i / stepsPerSegment));
  }
  return out;
}

export function polylineLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return len;
}

export function pathLength(path: BezierPath): number {
  return polylineLength(flattenPath(path));
}

/**
 * Point and tangent angle (radians) at normalized arc length u (0..1).
 * Uses arc-length parameterization so motion along the path has even speed.
 */
export function pointAtLength(path: BezierPath, u: number): { x: number; y: number; angle: number } {
  const pts = flattenPath(path, 48);
  if (pts.length === 0) return { x: 0, y: 0, angle: 0 };
  if (pts.length === 1) return { x: pts[0]!.x, y: pts[0]!.y, angle: 0 };
  const total = polylineLength(pts);
  const target = Math.min(Math.max(u, 0), 1) * total;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= target || i === pts.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, (target - acc) / seg);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1]!;
  return { x: last.x, y: last.y, angle: 0 };
}

/** SVG path data for a bezier path. */
export function pathToSvg(path: BezierPath): string {
  if (path.anchors.length === 0) return '';
  const first = path.anchors[0]!;
  let d = `M${fmt(first.x)} ${fmt(first.y)}`;
  for (const [, c1, c2, p] of pathSegments(path)) {
    d += ` C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p.x)} ${fmt(p.y)}`;
  }
  if (path.closed) d += ' Z';
  return d;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Bounding box of a set of points. */
export function boundsOf(points: Point[]): { x: number; y: number; width: number; height: number } {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
