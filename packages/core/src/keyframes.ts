/**
 * Keyframes and easing. Shared by the video timeline, the animation maker,
 * slide element animations and transitions.
 */

export type EasingPreset = 'linear' | 'hold' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'back-out' | 'bounce-out';

/** Either a named preset or a CSS-style cubic-bezier(x1, y1, x2, y2). */
export type Easing = EasingPreset | { bezier: [number, number, number, number] };

export interface Keyframe {
  /** Time in seconds, relative to the owner (clip or layer start). */
  time: number;
  value: number;
  /** Easing applied from this keyframe to the next. */
  easing: Easing;
}

const PRESET_BEZIERS: Partial<Record<EasingPreset, [number, number, number, number]>> = {
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/** Solve a cubic bezier timing function (same semantics as CSS cubic-bezier). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // Fall back to bisection for robustness.
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveX(x));
  };
}

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/** Map normalized progress (0..1) through an easing curve. */
export function ease(easing: Easing, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  if (typeof easing === 'object') return cubicBezier(...easing.bezier)(x);
  switch (easing) {
    case 'linear':
      return x;
    case 'hold':
      return x >= 1 ? 1 : 0;
    case 'back-out': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    case 'bounce-out':
      return bounceOut(x);
    default: {
      const b = PRESET_BEZIERS[easing];
      return b ? cubicBezier(...b)(x) : x;
    }
  }
}

/** Sort keyframes by time (stable, returns a new array). */
export function sortKeyframes(keys: readonly Keyframe[]): Keyframe[] {
  return [...keys].sort((a, b) => a.time - b.time);
}

/**
 * Evaluate a keyframed property at time t. Before the first key the first value holds;
 * after the last key the last value holds. With no keys, returns the fallback.
 */
export function evaluateKeyframes(keys: readonly Keyframe[] | undefined, t: number, fallback: number): number {
  if (!keys || keys.length === 0) return fallback;
  const sorted = keys.length > 1 && !isSorted(keys) ? sortKeyframes(keys) : keys;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (t <= first.time) return first.value;
  if (t >= last.time) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      const p = ease(a.easing, (t - a.time) / span);
      return a.value + (b.value - a.value) * p;
    }
  }
  return last.value;
}

function isSorted(keys: readonly Keyframe[]): boolean {
  for (let i = 1; i < keys.length; i++) if (keys[i]!.time < keys[i - 1]!.time) return false;
  return true;
}

/** Insert or replace a keyframe at the same time (within epsilon). Returns a new sorted array. */
export function upsertKeyframe(keys: readonly Keyframe[] | undefined, key: Keyframe, epsilon = 1e-4): Keyframe[] {
  const rest = (keys ?? []).filter((k) => Math.abs(k.time - key.time) > epsilon);
  return sortKeyframes([...rest, key]);
}

/** Evaluate a CSS-like easing curve into sample points (for the curve editor). */
export function sampleEasing(easing: Easing, samples = 32): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    out.push([t, ease(easing, t)]);
  }
  return out;
}

/** Map a playback time through a playback mode (once, loop, pingpong). */
export function playbackTime(mode: 'once' | 'loop' | 'pingpong', t: number, duration: number): number {
  if (duration <= 0) return 0;
  switch (mode) {
    case 'once':
      return Math.min(Math.max(t, 0), duration);
    case 'loop':
      return ((t % duration) + duration) % duration;
    case 'pingpong': {
      const period = duration * 2;
      const p = ((t % period) + period) % period;
      return p <= duration ? p : period - p;
    }
  }
}
