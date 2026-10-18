import type { ClipProps, Operation, ProjectState, SceneNode, TrackType } from '@omnix/core';
import { clipEnd, clipsOf, makeNode, splitClipOp, rippleDeleteOp, tracksOf, childrenOf } from '@omnix/core';
import type { ProjectStore } from '../../state/project.js';
import type { AssetSummary } from '../../lib/api.js';
import { toast } from '../../ui/toast.js';
import type { TimelineEditorStore } from './timelineState.js';

export interface TimelineCtx {
  store: ProjectStore;
  ed: TimelineEditorStore;
  sequenceId: string;
}

export const TRACK_COLORS: Record<TrackType, string> = {
  video: '#2a78d6',
  audio: '#1baf7a',
  title: '#6250d6',
  effect: '#eda100',
  animation: '#e87ba4',
};

export const TRACK_HEIGHT: Record<TrackType, number> = { video: 58, audio: 54, title: 40, effect: 34, animation: 52 };

export function state(c: TimelineCtx): ProjectState {
  return c.store.getState().state!;
}

export function seqProps(c: TimelineCtx) {
  return (state(c).nodes[c.sequenceId] as SceneNode<'sequence'>).props;
}

/** Preview an op without committing: every update in it becomes a transient override. */
export function previewOp(c: TimelineCtx, op: Operation | null): void {
  const s = c.store.getState();
  s.clearTransient();
  if (!op) return;
  const visit = (o: Operation) => {
    if (o.kind === 'update') s.setTransient(o.id, o.set);
    else if (o.kind === 'batch') o.ops.forEach(visit);
  };
  visit(op);
}

/** Commit an op built from the pre-drag state, dropping any preview first. */
export function commitOp(c: TimelineCtx, op: Operation | null, label: string): boolean {
  const s = c.store.getState();
  s.clearTransient();
  if (!op) return false;
  return !!s.commit(op, label);
}

/** Try an edit builder, turning its validation errors into a toast. */
export function tryOp(build: () => Operation): Operation | null {
  try {
    return build();
  } catch (e) {
    toast.error((e as Error).message);
    return null;
  }
}

export function trackFor(c: TimelineCtx, kind: AssetSummary['kind']): SceneNode<'track'> | undefined {
  const want: TrackType = kind === 'audio' ? 'audio' : 'video';
  const open = tracksOf(state(c), c.sequenceId).filter((t) => t.props.trackType === want && !t.props.locked);
  // In an edit, new shots go on the main track, not the overlay track above it.
  return open.find((t) => t.props.name !== 'Overlays') ?? open[0];
}

/** Clip props for placing an asset on the timeline. */
export function clipFromAsset(a: AssetSummary, start: number): Partial<ClipProps> {
  const isStill = a.kind === 'image';
  const dur = isStill ? 5 : a.duration ?? 5;
  return { name: a.name.replace(/\.[^.]+$/, ''), assetId: a.id, start, in: 0, out: dur, sourceDuration: isStill ? 0 : dur };
}

export function addAssetClip(c: TimelineCtx, a: AssetSummary, trackId?: string, start?: number): string | null {
  const s = state(c);
  const track = trackId ? (s.nodes[trackId] as SceneNode<'track'>) : trackFor(c, a.kind);
  if (!track) {
    toast.error(a.kind === 'audio' ? 'Add an audio track first.' : 'Add a video track first.');
    return null;
  }
  const at = start ?? clipsOf(s, track.id).reduce((m, x) => Math.max(m, clipEnd(x.props)), 0);
  const node = makeNode('clip', clipFromAsset(a, at));
  const ops: Operation[] = [{ kind: 'create', parentId: track.id, nodes: [node] }];
  // Grow the sequence so the new clip fits.
  const end = at + ((node.props as ClipProps).out - (node.props as ClipProps).in);
  if (end > seqProps(c).duration) ops.push({ kind: 'update', id: c.sequenceId, set: { duration: Math.ceil(end) } });
  if (!c.store.getState().commit(ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, `Add ${a.name}`)) return null;
  c.ed.getState().set({ selectedClips: [node.id] });
  return node.id;
}

export function addTitle(c: TimelineCtx, caption = false): void {
  const s = state(c);
  let track = tracksOf(s, c.sequenceId).find((t) => t.props.trackType === 'title');
  const ops: Operation[] = [];
  if (!track) {
    track = makeNode('track', { name: 'Titles', trackType: 'title' });
    ops.push({ kind: 'create', parentId: c.sequenceId, index: 0, nodes: [track] });
  }
  const t = c.ed.getState().time;
  const node = makeNode('clip', {
    name: caption ? 'Caption' : 'Title',
    start: t,
    in: 0,
    out: caption ? 3 : 4,
    title: { text: caption ? 'Caption text' : 'Your title', fontFamily: 'Inter', fontSize: caption ? 44 : 96, fontWeight: caption ? 600 : 750, color: '#ffffff', background: caption ? '#00000099' : null, align: 'center', caption },
    transitionIn: caption ? null : { kind: 'crossfade', duration: 0.4, easing: 'ease-out' },
    transitionOut: caption ? null : { kind: 'crossfade', duration: 0.4, easing: 'ease-in' },
  });
  ops.push({ kind: 'create', parentId: track.id, nodes: [node] });
  if (c.store.getState().commit(ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, caption ? 'Add caption' : 'Add title')) c.ed.getState().set({ selectedClips: [node.id] });
}

export function addTrack(c: TimelineCtx, type: TrackType): void {
  const s = state(c);
  const count = tracksOf(s, c.sequenceId).filter((t) => t.props.trackType === type).length;
  const names: Record<TrackType, string> = { video: 'Video', audio: 'Audio', title: 'Titles', effect: 'Effects', animation: 'Animation' };
  const node = makeNode('track', { name: `${names[type]} ${count + 1}`, trackType: type });
  // Visual tracks go on top (index 0 = top of the stack); audio at the bottom.
  const index = type === 'audio' ? s.nodes[c.sequenceId]!.children.length : 0;
  c.store.getState().commit({ kind: 'create', parentId: c.sequenceId, index, nodes: [node] }, `Add ${names[type].toLowerCase()} track`);
}

export function splitAtPlayhead(c: TimelineCtx): void {
  const s = state(c);
  const t = c.ed.getState().time;
  const sel = c.ed.getState().selectedClips;
  // Split the selected clips, or every unlocked clip under the playhead when nothing is selected.
  const targets: string[] = [];
  for (const track of tracksOf(s, c.sequenceId)) {
    if (track.props.locked) continue;
    for (const clip of clipsOf(s, track.id)) if ((sel.length === 0 || sel.includes(clip.id)) && t > clip.props.start + 1e-3 && t < clipEnd(clip.props) - 1e-3) targets.push(clip.id);
  }
  if (!targets.length) return;
  // Splits on different clips are independent, so each is built from the same state.
  const ops: Operation[] = [];
  for (const id of targets) {
    const op = tryOp(() => splitClipOp(s, id, t));
    if (!op) return;
    ops.push(op);
  }
  c.store.getState().commit(ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, ops.length === 1 ? 'Split clip' : `Split ${ops.length} clips`);
}

export function deleteSelected(c: TimelineCtx, ripple: boolean): void {
  const ids = c.ed.getState().selectedClips.filter((id) => state(c).nodes[id]);
  if (!ids.length) return;
  if (ripple && ids.length === 1) {
    const op = tryOp(() => rippleDeleteOp(state(c), ids[0]!));
    if (op) c.store.getState().commit(op, 'Ripple delete');
  } else {
    c.store.getState().commit(ids.length === 1 ? { kind: 'delete', id: ids[0]! } : { kind: 'batch', ops: ids.map((id) => ({ kind: 'delete' as const, id })) }, ids.length === 1 ? 'Delete clip' : `Delete ${ids.length} clips`);
  }
  c.ed.getState().set({ selectedClips: [] });
}

export function duplicateSelected(c: TimelineCtx): void {
  const s = state(c);
  const ops: Operation[] = [];
  const ids: string[] = [];
  for (const id of c.ed.getState().selectedClips) {
    const n = s.nodes[id];
    if (!n || n.type !== 'clip') continue;
    const p = (n as SceneNode<'clip'>).props;
    const end = clipsOf(s, n.parentId!).reduce((m, x) => Math.max(m, clipEnd(x.props)), 0);
    const copy = makeNode('clip', { ...structuredClone(p), name: `${p.name} copy`, start: end });
    ids.push(copy.id);
    ops.push({ kind: 'create', parentId: n.parentId!, nodes: [copy] });
  }
  if (ops.length && c.store.getState().commit(ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, 'Duplicate clip')) c.ed.getState().set({ selectedClips: ids });
}

/** Every edit point (clip edges, layer edges, playhead) for snapping, excluding some items. */
export function snapPoints(state: ProjectState, sequenceId: string, playhead: number, exclude: ReadonlySet<string>): number[] {
  const pts = [0, playhead];
  for (const track of tracksOf(state, sequenceId))
    for (const n of childrenOf(state, track.id)) {
      if (exclude.has(n.id)) continue;
      if (n.type === 'clip') {
        const p = (n as SceneNode<'clip'>).props;
        pts.push(p.start, clipEnd(p));
      } else if (n.type === 'animLayer') {
        const p = (n as SceneNode<'animLayer'>).props;
        pts.push(p.start, p.start + p.duration);
      }
    }
  // Beats of the music, so cuts land on them.
  const beats = (state.nodes[sequenceId] as SceneNode<'sequence'> | undefined)?.props.beats;
  if (beats) pts.push(...beats);
  return pts;
}

/** Snap time t to the nearest point within `px` pixels; returns the snapped time and the target. */
export function snap(t: number, points: number[], pxPerSec: number, px = 8): { t: number; to: number | null } {
  let best: number | null = null;
  let bestD = px / pxPerSec;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best === null ? { t, to: null } : { t: best, to: best };
}
