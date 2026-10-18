import type { ClipProps, SceneNode, TrackType } from './nodes.js';
import type { BatchOp, Operation } from './ops.js';
import { OpError } from './ops.js';
import { childrenOf, requireNodeOfType, type ProjectState } from './state.js';
import { makeNode } from './defaults.js';
import { evaluateKeyframes } from './keyframes.js';

/**
 * Timeline maths and edit builders shared by the video editor, the animation maker,
 * the renderer and the MCP tools. Builders never mutate; they return Operations.
 */

type ClipLike = Pick<ClipProps, 'start' | 'in' | 'out' | 'speed' | 'speedRamp' | 'reverse'>;

const EPS = 1e-6;

/** Average of a piecewise-linear speed ramp over normalized time 0..1. */
export function averageRampSpeed(ramp: readonly { t: number; speed: number }[]): number {
  return rampIntegral(ramp, 1);
}

/** Integral of the ramp's speed from 0 to u (normalized time). */
function rampIntegral(ramp: readonly { t: number; speed: number }[], u: number): number {
  const pts = normalizeRamp(ramp);
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (u <= a.t) break;
    const end = Math.min(u, b.t);
    const span = b.t - a.t;
    const sEnd = span > 0 ? a.speed + ((b.speed - a.speed) * (end - a.t)) / span : b.speed;
    acc += ((a.speed + sEnd) / 2) * (end - a.t);
  }
  return acc;
}

function normalizeRamp(ramp: readonly { t: number; speed: number }[]): { t: number; speed: number }[] {
  const pts = [...ramp].filter((p) => p.speed > 0).sort((a, b) => a.t - b.t);
  if (pts.length === 0) return [
    { t: 0, speed: 1 },
    { t: 1, speed: 1 },
  ];
  if (pts[0]!.t > 0) pts.unshift({ t: 0, speed: pts[0]!.speed });
  if (pts[pts.length - 1]!.t < 1) pts.push({ t: 1, speed: pts[pts.length - 1]!.speed });
  return pts;
}

/** How long a clip occupies on the timeline, in seconds. */
export function clipDuration(c: ClipLike): number {
  const src = Math.max(0, c.out - c.in);
  if (c.speedRamp && c.speedRamp.length) return src / Math.max(EPS, averageRampSpeed(c.speedRamp));
  return src / Math.max(EPS, c.speed);
}

export function clipEnd(c: ClipLike): number {
  return c.start + clipDuration(c);
}

/** Map a sequence time to the clip's source media time. Returns null when t is outside the clip. */
export function sourceTimeAt(c: ClipLike, t: number): number | null {
  const d = clipDuration(c);
  const local = t - c.start;
  if (local < -EPS || local > d + EPS) return null;
  const clamped = Math.min(Math.max(local, 0), d);
  let offset: number;
  if (c.speedRamp && c.speedRamp.length && d > 0) offset = d * rampIntegral(c.speedRamp, clamped / d);
  else offset = clamped * c.speed;
  offset = Math.min(offset, c.out - c.in);
  return c.reverse ? c.out - offset : c.in + offset;
}

/** Instantaneous playback rate at sequence time t (for audio pitch/tempo and motion blur). */
export function speedAt(c: ClipLike, t: number): number {
  if (!c.speedRamp || !c.speedRamp.length) return c.speed;
  const d = clipDuration(c);
  const u = d > 0 ? Math.min(1, Math.max(0, (t - c.start) / d)) : 0;
  const pts = normalizeRamp(c.speedRamp);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (u >= a.t && u <= b.t) return b.t > a.t ? a.speed + ((b.speed - a.speed) * (u - a.t)) / (b.t - a.t) : b.speed;
  }
  return pts[pts.length - 1]!.speed;
}

/** The clip's fade-in/out as a 0..1 gain at sequence time t (1 outside the fades). */
export function fadeGainAt(c: Pick<ClipProps, 'start' | 'in' | 'out' | 'speed' | 'speedRamp' | 'reverse' | 'fadeIn' | 'fadeOut'>, t: number): number {
  const local = t - c.start;
  const d = clipDuration(c);
  let g = 1;
  if (c.fadeIn && c.fadeIn > 0) g = Math.min(g, Math.max(0, local / c.fadeIn));
  if (c.fadeOut && c.fadeOut > 0) g = Math.min(g, Math.max(0, (d - local) / c.fadeOut));
  return Math.min(1, g);
}

/** Evaluate a clip's animatable props at sequence time t (keyframe times are relative to clip start). */
export function clipPropsAt(c: ClipProps, t: number): { x: number; y: number; scale: number; rotation: number; opacity: number; volume: number; blur: number } {
  const local = t - c.start;
  return {
    x: evaluateKeyframes(c.keyframes.x, local, c.x),
    y: evaluateKeyframes(c.keyframes.y, local, c.y),
    scale: evaluateKeyframes(c.keyframes.scale, local, c.scale),
    rotation: evaluateKeyframes(c.keyframes.rotation, local, c.rotation),
    opacity: evaluateKeyframes(c.keyframes.opacity, local, c.opacity),
    volume: evaluateKeyframes(c.keyframes.volume, local, c.volume),
    blur: evaluateKeyframes(c.keyframes.blur, local, 0),
  };
}

export function tracksOf(state: ProjectState, sequenceId: string): SceneNode<'track'>[] {
  requireNodeOfType(state, sequenceId, 'sequence');
  return childrenOf(state, sequenceId).filter((n): n is SceneNode<'track'> => n.type === 'track');
}

/** Clips on a track sorted by start time. */
export function clipsOf(state: ProjectState, trackId: string): SceneNode<'clip'>[] {
  return childrenOf(state, trackId)
    .filter((n): n is SceneNode<'clip'> => n.type === 'clip')
    .sort((a, b) => a.props.start - b.props.start);
}

/** Clips intersecting time t, grouped by track (track order = stacking order, first track on top). */
export function activeClipsAt(state: ProjectState, sequenceId: string, t: number): { track: SceneNode<'track'>; clip: SceneNode<'clip'> }[] {
  const out: { track: SceneNode<'track'>; clip: SceneNode<'clip'> }[] = [];
  for (const track of tracksOf(state, sequenceId)) {
    if (track.props.hidden) continue;
    for (const clip of clipsOf(state, track.id)) {
      const p = clip.props;
      if (t >= p.start - EPS && t < clipEnd(p) - EPS) out.push({ track, clip });
    }
  }
  return out;
}

/** The end of the last clip or animation layer in a sequence. */
export function contentDuration(state: ProjectState, sequenceId: string): number {
  let end = 0;
  for (const track of tracksOf(state, sequenceId)) {
    for (const n of childrenOf(state, track.id)) {
      if (n.type === 'clip') end = Math.max(end, clipEnd((n as SceneNode<'clip'>).props));
      if (n.type === 'animLayer') {
        const p = (n as SceneNode<'animLayer'>).props;
        end = Math.max(end, p.start + p.duration);
      }
    }
  }
  return end;
}

/* ------------------------------------------------------------------ */
/* Edit builders                                                       */
/* ------------------------------------------------------------------ */

function clipNode(state: ProjectState, id: string): SceneNode<'clip'> {
  return requireNodeOfType(state, id, 'clip');
}

function siblingsAfter(state: ProjectState, clip: SceneNode<'clip'>): SceneNode<'clip'>[] {
  return clipsOf(state, clip.parentId!).filter((c) => c.id !== clip.id && c.props.start >= clip.props.start - EPS);
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Add a clip. With no start given it is appended after the last clip on the track. */
export function addClipOp(state: ProjectState, trackId: string, props: Partial<ClipProps>, id?: string): Operation {
  const track = requireNodeOfType(state, trackId, 'track');
  const start = props.start ?? clipsOf(state, track.id).reduce((m, c) => Math.max(m, clipEnd(c.props)), 0);
  const node = makeNode('clip', { ...props, start }, id);
  return { kind: 'create', parentId: track.id, nodes: [node] };
}

/** Split a clip at sequence time t into two clips. */
export function splitClipOp(state: ProjectState, clipId: string, t: number, newId?: string): Operation {
  const clip = clipNode(state, clipId);
  const p = clip.props;
  if (t <= p.start + EPS || t >= clipEnd(p) - EPS) throw new OpError('Split point must be inside the clip');
  if (p.speedRamp && p.speedRamp.length) throw new OpError('Remove the speed ramp before splitting this clip');
  const src = sourceTimeAt(p, t)!;
  // The fade-out stays with the second half and the fade-in with the first.
  const first: Partial<ClipProps> = { ...(p.reverse ? { in: round(src) } : { out: round(src) }), transitionOut: null, ...(p.fadeOut ? { fadeOut: 0 } : {}) };
  const second = makeNode(
    'clip',
    {
      ...structuredClone(p),
      name: `${p.name} (2)`,
      start: round(t),
      ...(p.reverse ? { out: round(src) } : { in: round(src) }),
      transitionIn: null,
      ...(p.fadeIn ? { fadeIn: 0 } : {}),
      keyframes: shiftKeyframes(p.keyframes, -(t - p.start)),
    },
    newId,
  );
  const track = state.nodes[clip.parentId!]!;
  return {
    kind: 'batch',
    ops: [
      { kind: 'update', id: clip.id, set: first },
      { kind: 'create', parentId: track.id, index: track.children.indexOf(clip.id) + 1, nodes: [second] },
    ],
  };
}

function shiftKeyframes(k: ClipProps['keyframes'], dt: number): ClipProps['keyframes'] {
  const out: ClipProps['keyframes'] = {};
  for (const [prop, keys] of Object.entries(k)) {
    if (keys) out[prop as keyof typeof out] = keys.map((kf) => ({ ...kf, time: round(kf.time + dt) }));
  }
  return out;
}

/** Delete a clip and close the gap by shifting later clips on the same track left. */
export function rippleDeleteOp(state: ProjectState, clipId: string): Operation {
  const clip = clipNode(state, clipId);
  const d = clipDuration(clip.props);
  const ops: Operation[] = siblingsAfter(state, clip).map((c) => ({ kind: 'update', id: c.id, set: { start: round(c.props.start - d) } }));
  ops.unshift({ kind: 'delete', id: clip.id });
  return { kind: 'batch', ops };
}

/**
 * Ripple trim: change a clip's in or out point by `delta` seconds of timeline time and shift
 * every later clip on the track so no gap or overlap is created.
 */
export function rippleTrimOp(state: ProjectState, clipId: string, edge: 'in' | 'out', delta: number): Operation {
  const clip = clipNode(state, clipId);
  const p = clip.props;
  const srcDelta = delta * p.speed;
  const ops: Operation[] = [];
  const before = clipDuration(p);
  let next: Partial<ClipProps>;
  if (edge === 'out') {
    const out = clampSource(p, p.out + srcDelta);
    if (out - p.in < EPS) throw new OpError('Trim would make the clip empty');
    next = { out: round(out) };
  } else {
    const inn = clampSource(p, p.in + srcDelta);
    if (p.out - inn < EPS) throw new OpError('Trim would make the clip empty');
    next = { in: round(inn) };
  }
  ops.push({ kind: 'update', id: clip.id, set: next });
  const after = clipDuration({ ...p, ...next });
  const shift = after - before;
  for (const c of siblingsAfter(state, clip)) ops.push({ kind: 'update', id: c.id, set: { start: round(c.props.start + shift) } });
  return { kind: 'batch', ops };
}

/** Plain trim without ripple (gaps may open). */
export function trimOp(state: ProjectState, clipId: string, edge: 'in' | 'out', delta: number): Operation {
  const clip = clipNode(state, clipId);
  const p = clip.props;
  const srcDelta = delta * p.speed;
  if (edge === 'out') {
    const out = clampSource(p, p.out + srcDelta);
    if (out - p.in < EPS) throw new OpError('Trim would make the clip empty');
    return { kind: 'update', id: clip.id, set: { out: round(out) } };
  }
  const inn = clampSource(p, p.in + srcDelta);
  if (p.out - inn < EPS) throw new OpError('Trim would make the clip empty');
  return { kind: 'update', id: clip.id, set: { in: round(inn), start: round(p.start + delta) } };
}

function clampSource(p: ClipProps, t: number): number {
  const max = p.sourceDuration > 0 ? p.sourceDuration : Infinity;
  return Math.min(Math.max(0, t), max);
}

/** Roll edit: move the cut between two adjacent clips; total duration is unchanged. */
export function rollEditOp(state: ProjectState, leftClipId: string, rightClipId: string, delta: number): Operation {
  const a = clipNode(state, leftClipId);
  const b = clipNode(state, rightClipId);
  if (a.parentId !== b.parentId) throw new OpError('Roll edits need two clips on the same track');
  if (Math.abs(clipEnd(a.props) - b.props.start) > 1e-3) throw new OpError('Roll edits need adjacent clips');
  const aOut = clampSource(a.props, a.props.out + delta * a.props.speed);
  const bIn = clampSource(b.props, b.props.in + delta * b.props.speed);
  if (aOut - a.props.in < EPS || b.props.out - bIn < EPS) throw new OpError('Roll would make a clip empty');
  return {
    kind: 'batch',
    ops: [
      { kind: 'update', id: a.id, set: { out: round(aOut) } },
      { kind: 'update', id: b.id, set: { in: round(bIn), start: round(b.props.start + delta) } },
    ],
  };
}

/** Slip edit: change which part of the source is shown without moving the clip on the timeline. */
export function slipEditOp(state: ProjectState, clipId: string, delta: number): Operation {
  const c = clipNode(state, clipId);
  const p = c.props;
  let d = delta * p.speed;
  if (p.in + d < 0) d = -p.in;
  if (p.sourceDuration > 0 && p.out + d > p.sourceDuration) d = p.sourceDuration - p.out;
  return { kind: 'update', id: c.id, set: { in: round(p.in + d), out: round(p.out + d) } };
}

/**
 * Slide edit: move a clip between its neighbours. The previous clip's out point and the next clip's
 * in point adjust so the overall sequence length is unchanged.
 */
export function slideEditOp(state: ProjectState, clipId: string, delta: number): Operation {
  const c = clipNode(state, clipId);
  const clips = clipsOf(state, c.parentId!);
  const i = clips.findIndex((x) => x.id === c.id);
  const prev = clips[i - 1];
  const next = clips[i + 1];
  const ops: Operation[] = [{ kind: 'update', id: c.id, set: { start: round(c.props.start + delta) } }];
  if (prev && Math.abs(clipEnd(prev.props) - c.props.start) < 1e-3) {
    const out = clampSource(prev.props, prev.props.out + delta * prev.props.speed);
    if (out - prev.props.in < EPS) throw new OpError('Slide would make the previous clip empty');
    ops.push({ kind: 'update', id: prev.id, set: { out: round(out) } });
  }
  if (next && Math.abs(clipEnd(c.props) - next.props.start) < 1e-3) {
    const inn = clampSource(next.props, next.props.in + delta * next.props.speed);
    if (next.props.out - inn < EPS) throw new OpError('Slide would make the next clip empty');
    ops.push({ kind: 'update', id: next.id, set: { in: round(inn), start: round(next.props.start + delta) } });
  }
  return { kind: 'batch', ops };
}

/** Move a clip to a new start time (and optionally another track). */
export function moveClipOp(state: ProjectState, clipId: string, start: number, trackId?: string): Operation {
  const c = clipNode(state, clipId);
  const ops: Operation[] = [];
  if (trackId && trackId !== c.parentId) {
    requireNodeOfType(state, trackId, 'track');
    ops.push({ kind: 'move', id: c.id, parentId: trackId });
  }
  ops.push({ kind: 'update', id: c.id, set: { start: round(Math.max(0, start)) } });
  return ops.length === 1 ? ops[0]! : { kind: 'batch', ops };
}

/** Change clip speed; with ripple, later clips shift to keep the edit tight. */
export function setSpeedOp(state: ProjectState, clipId: string, speed: number, options: { reverse?: boolean; ripple?: boolean } = {}): Operation {
  if (!(speed > 0) || speed > 100) throw new OpError('Speed must be between 0 and 100');
  const c = clipNode(state, clipId);
  const before = clipDuration(c.props);
  const set: Partial<ClipProps> = { speed, speedRamp: null };
  if (options.reverse !== undefined) set.reverse = options.reverse;
  const ops: Operation[] = [{ kind: 'update', id: c.id, set }];
  if (options.ripple) {
    const shift = clipDuration({ ...c.props, ...set }) - before;
    for (const s of siblingsAfter(state, c)) ops.push({ kind: 'update', id: s.id, set: { start: round(s.props.start + shift) } });
  }
  return { kind: 'batch', ops };
}

/** Clips that overlap on the same track (used by validation and UI warnings). */
export function findOverlaps(state: ProjectState, trackId: string): [string, string][] {
  const clips = clipsOf(state, trackId);
  const out: [string, string][] = [];
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i]!;
    const b = clips[i + 1]!;
    if (clipEnd(a.props) - b.props.start > 1e-3) out.push([a.id, b.id]);
  }
  return out;
}

export function isBatch(op: Operation): op is BatchOp {
  return op.kind === 'batch';
}

/** The track types allowed to hold media clips. */
export const CLIP_TRACK_TYPES: readonly TrackType[] = ['video', 'audio', 'title', 'effect'];
