import { useRef } from 'react';
import { useStore } from 'zustand';
import type { AnimFrame, AnimLayerProps, Bone, Point, ProjectState, SceneNode, Stroke, VectorShape } from '@omnix/core';
import { childrenOf, evaluateRig, forwardKinematics, newId, pathFromPoints, playbackTime, solveIK, tracksOf } from '@omnix/core';
import { animLayerTransform, frameIndexAt, strokeDabs } from '@omnix/render';
import { useProject } from '../../state/project.js';
import { toast } from '../../ui/toast.js';
import type { StageHandlers } from '../video/Stage.js';
import type { TimelineCtx } from '../video/timelineOps.js';

/** The animation layer being edited: the selected one, or the first on the timeline. */
export function activeAnimLayer(state: ProjectState, sequenceId: string, selected: string[]): SceneNode<'animLayer'> | null {
  const sel = selected.map((id) => state.nodes[id]).find((n) => n?.type === 'animLayer');
  if (sel) return sel as SceneNode<'animLayer'>;
  for (const tr of tracksOf(state, sequenceId)) for (const n of childrenOf(state, tr.id)) if (n.type === 'animLayer') return n as SceneNode<'animLayer'>;
  return null;
}

/** Map a sequence point into the layer's drawing space at time t (inverse of the layer transform). */
export function toLayer(p: AnimLayerProps, t: number, pt: Point): Point {
  const tr = animLayerTransform(p, t);
  let x = pt.x - tr.x;
  let y = pt.y - tr.y;
  const a = (-tr.rotation * Math.PI) / 180;
  [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  return { x: x / (tr.scale || 1) + p.anchorX, y: y / (tr.scale || 1) + p.anchorY };
}

/** Map a layer-space point to sequence coordinates. */
export function fromLayer(p: AnimLayerProps, t: number, pt: Point): Point {
  const tr = animLayerTransform(p, t);
  const x = (pt.x - p.anchorX) * tr.scale;
  const y = (pt.y - p.anchorY) * tr.scale;
  const a = (tr.rotation * Math.PI) / 180;
  return { x: tr.x + x * Math.cos(a) - y * Math.sin(a), y: tr.y + x * Math.sin(a) + y * Math.cos(a) };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Pointer handling for the animation stage: drawing, shapes, bones, posing and motion paths. */
export function useAnimationStage(ctx: TimelineCtx): { handlers: StageHandlers; editor: { onionSkin: boolean; showBones: boolean } } {
  const { ed, store } = ctx;
  const tool = useStore(ed, (s) => s.animTool);
  const showBones = useStore(ed, (s) => s.showBones);
  const selected = useStore(ed, (s) => s.selectedClips);
  const time = useStore(ed, (s) => s.time);
  const playing = useStore(ed, (s) => s.playing);
  const state = useProject((s) => s.state)!;
  const canEdit = useProject((s) => s.meta?.role !== 'viewer' && !s.preview);
  const layer = activeAnimLayer(state, ctx.sequenceId, selected);
  const seq = state.nodes[ctx.sequenceId] as SceneNode<'sequence'>;
  const fps = seq.props.fps;
  const live = useRef<{ kind: string; points: Point[]; start: Point; bone?: string; angles?: Record<string, number>; parent?: string | null } | null>(null);
  const s = store.getState();

  const local = layer ? time - layer.props.start : 0;
  const frameIdx = layer && layer.props.frames.length ? frameIndexAt(layer.props, Math.max(0, local), fps) : -1;

  const commitFrame = (mutate: (f: AnimFrame) => Partial<AnimFrame>, label: string) => {
    if (!layer) return;
    const frames = layer.props.frames;
    if (frameIdx < 0) {
      const f: AnimFrame = { id: newId('frm'), hold: 1, shapes: [], strokes: [], assetId: null };
      s.commit({ kind: 'listInsert', id: layer.id, prop: 'frames', items: [{ ...f, ...mutate(f) }] }, label);
      return;
    }
    const f = frames[frameIdx]!;
    s.commit({ kind: 'listUpdate', id: layer.id, prop: 'frames', itemId: f.id, set: mutate(f) }, label);
  };

  const currentAngles = (): Record<string, number> => (layer?.props.rig ? evaluateRig(layer.props.rig, playbackTime(layer.props.playback, Math.max(0, local), layer.props.duration)) : {});

  const handlers: StageHandlers = {
    cursor: tool === 'select' ? 'move' : tool === 'pose' ? 'grab' : 'crosshair',
    onDown: (p, e) => {
      if (!layer || !canEdit) {
        if (!layer) toast.info('Add an animation layer first.');
        return;
      }
      if (playing) ed.getState().set({ playing: false });
      const lp = toLayer(layer.props, time, p);
      const pressure = e.pointerType === 'pen' ? e.pressure : 1;
      switch (tool) {
        case 'select':
          live.current = { kind: 'move', points: [p], start: { x: layer.props.x, y: layer.props.y } };
          return;
        case 'brush':
        case 'eraser':
          live.current = { kind: tool, points: [{ ...lp, pressure } as Point], start: lp };
          return;
        case 'rect':
        case 'ellipse':
          live.current = { kind: tool, points: [lp, lp], start: lp };
          return;
        case 'bone': {
          // Start at the tip of a nearby bone to chain onto it.
          const bones = layer.props.rig?.bones ?? [];
          const world = forwardKinematics(bones, currentAngles());
          let parent: string | null = null;
          let start = lp;
          for (const w of world.values()) {
            if (Math.hypot(w.end.x - lp.x, w.end.y - lp.y) < 12 / (animLayerTransform(layer.props, time).scale || 1)) {
              parent = w.id;
              start = w.end;
            }
          }
          live.current = { kind: 'bone', points: [start, lp], start, parent };
          return;
        }
        case 'pose': {
          const bones = layer.props.rig?.bones ?? [];
          const angles = currentAngles();
          const world = forwardKinematics(bones, angles);
          let best: string | undefined;
          let bestD = 16;
          for (const w of world.values()) {
            const d = Math.hypot(w.end.x - lp.x, w.end.y - lp.y);
            if (d < bestD) {
              bestD = d;
              best = w.id;
            }
          }
          if (!best) {
            toast.info('Drag the end of a bone to pose it.');
            return;
          }
          live.current = { kind: 'pose', points: [lp], start: lp, bone: best, angles };
          ed.getState().set({ activeBone: best });
          return;
        }
        case 'path': {
          const draft = ed.getState().pathDraft ?? [];
          if (e.detail >= 2 && draft.length >= 2) {
            finishPath(draft);
            return;
          }
          ed.getState().set({ pathDraft: [...draft, { x: round(p.x), y: round(p.y) }] });
          return;
        }
      }
    },
    onMove: (p, e) => {
      const L = live.current;
      if (!L || !layer) return;
      const lp = toLayer(layer.props, time, p);
      switch (L.kind) {
        case 'move':
          s.setTransient(layer.id, { x: Math.round(L.start.x + p.x - L.points[0]!.x), y: Math.round(L.start.y + p.y - L.points[0]!.y) });
          return;
        case 'brush':
        case 'eraser': {
          const pressure = e.pointerType === 'pen' ? e.pressure : 1;
          L.points.push({ ...lp, pressure } as Point);
          return;
        }
        case 'rect':
        case 'ellipse':
        case 'bone':
          L.points[1] = lp;
          return;
        case 'pose': {
          const rig = layer.props.rig!;
          L.angles = solveIK(rig.bones, L.bone!, lp, { angles: currentAngles(), chainLength: 3 });
          L.points[0] = lp;
          return;
        }
      }
    },
    onUp: () => {
      const L = live.current;
      live.current = null;
      if (!L || !layer) return;
      const st = ed.getState();
      switch (L.kind) {
        case 'move': {
          const tr = s.transient[layer.id] as { x?: number; y?: number } | undefined;
          if (tr && (tr.x !== layer.props.x || tr.y !== layer.props.y)) s.commitTransient('Move layer');
          else s.clearTransient(layer.id);
          return;
        }
        case 'brush':
        case 'eraser': {
          if (L.points.length < 1) return;
          const stroke: Stroke = {
            id: newId('st'),
            tool: L.kind === 'eraser' ? 'eraser' : 'brush',
            color: st.brush.color,
            size: st.brush.size,
            hardness: st.brush.hardness,
            opacity: st.brush.opacity,
            tip: 'round',
            spacing: 0.12,
            points: L.points.map((q) => ({ x: round(q.x), y: round(q.y), pressure: Math.round(((q as Point & { pressure?: number }).pressure ?? 1) * 1000) / 1000 })),
          };
          commitFrame((f) => ({ strokes: [...f.strokes, stroke] }), L.kind === 'eraser' ? 'Erase on frame' : 'Draw on frame');
          return;
        }
        case 'rect':
        case 'ellipse': {
          const [a, b] = L.points as [Point, Point];
          const w = Math.abs(b.x - a.x);
          const h = Math.abs(b.y - a.y);
          if (w < 2 || h < 2) return;
          const shape: VectorShape = { id: newId('shp'), kind: L.kind, x: round(Math.min(a.x, b.x)), y: round(Math.min(a.y, b.y)), width: round(w), height: round(h), fill: st.shapeFill, stroke: null, strokeWidth: 0 };
          commitFrame((f) => ({ shapes: [...f.shapes, shape] }), `Draw ${L.kind}`);
          return;
        }
        case 'bone': {
          const [a, b] = L.points as [Point, Point];
          const length = Math.hypot(b.x - a.x, b.y - a.y);
          if (length < 4) return;
          const rig = layer.props.rig ?? { bones: [], poses: [] };
          const abs = Math.atan2(b.y - a.y, b.x - a.x);
          const parentWorld = L.parent ? forwardKinematics(rig.bones).get(L.parent) : undefined;
          const bone: Bone = {
            id: newId('bone'),
            name: `Bone ${rig.bones.length + 1}`,
            parentId: L.parent ?? null,
            length: round(length),
            angle: Math.round((abs - (parentWorld?.angle ?? 0)) * 10000) / 10000,
            x: L.parent ? 0 : round(a.x),
            y: L.parent ? 0 : round(a.y),
            attachment: null,
          };
          s.commit({ kind: 'update', id: layer.id, set: { rig: { ...rig, bones: [...rig.bones, bone] } } }, 'Add bone');
          return;
        }
        case 'pose': {
          ed.getState().set({ activeBone: null });
          if (!L.angles) return;
          const rig = layer.props.rig!;
          const tl = Math.round(Math.max(0, local) * 1000) / 1000;
          const poses = rig.poses.filter((q) => Math.abs(q.time - tl) > 1e-3);
          const angles = Object.fromEntries(Object.entries(L.angles).map(([k, v]) => [k, Math.round(v * 10000) / 10000]));
          s.commit({ kind: 'update', id: layer.id, set: { rig: { ...rig, poses: [...poses, { time: tl, angles, easing: 'ease-in-out' }].sort((x, y) => x.time - y.time) } } }, 'Pose rig');
          return;
        }
      }
    },
    overlay: (g, geo) => {
      if (!layer) return;
      const px = 1 / geo.k;
      const L = live.current;
      const lp = layer.props;
      g.save();
      // Motion path (sequence space).
      if (lp.motionPath && lp.motionPath.path.anchors.length > 1) {
        g.strokeStyle = 'rgba(232,123,164,0.9)';
        g.lineWidth = 2 * px;
        g.setLineDash([6 * px, 4 * px]);
        g.beginPath();
        lp.motionPath.path.anchors.forEach((a, i) => (i ? g.lineTo(a.x, a.y) : g.moveTo(a.x, a.y)));
        g.stroke();
        g.setLineDash([]);
      }
      const draft = ed.getState().pathDraft;
      if (draft?.length) {
        g.strokeStyle = '#e87ba4';
        g.fillStyle = '#e87ba4';
        g.lineWidth = 2 * px;
        g.beginPath();
        draft.forEach((a, i) => (i ? g.lineTo(a.x, a.y) : g.moveTo(a.x, a.y)));
        g.stroke();
        for (const a of draft) {
          g.beginPath();
          g.arc(a.x, a.y, 4 * px, 0, Math.PI * 2);
          g.fill();
        }
      }
      // Live strokes, shapes and bones (layer space).
      if (L && L.kind !== 'move') {
        const st = ed.getState();
        g.save();
        const tr = animLayerTransform(lp, time);
        g.translate(tr.x, tr.y);
        g.rotate((tr.rotation * Math.PI) / 180);
        g.scale(tr.scale, tr.scale);
        g.translate(-lp.anchorX, -lp.anchorY);
        if (L.kind === 'brush' || L.kind === 'eraser') {
          g.fillStyle = L.kind === 'eraser' ? 'rgba(255,255,255,0.8)' : st.brush.color;
          g.globalAlpha = st.brush.opacity;
          for (const d of strokeDabs({ points: L.points.map((q) => ({ x: q.x, y: q.y, pressure: (q as Point & { pressure?: number }).pressure ?? 1 })), size: st.brush.size, spacing: 0.15 })) {
            g.beginPath();
            g.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
            g.fill();
          }
        } else if (L.kind === 'rect' || L.kind === 'ellipse') {
          const [a, b] = L.points as [Point, Point];
          g.strokeStyle = '#3b5bdb';
          g.lineWidth = 1.5 * px;
          g.beginPath();
          if (L.kind === 'rect') g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          else g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
          g.stroke();
        } else if (L.kind === 'bone') {
          const [a, b] = L.points as [Point, Point];
          g.strokeStyle = '#6250d6';
          g.lineWidth = 4 * px;
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        } else if (L.kind === 'pose' && L.angles && lp.rig) {
          const world = forwardKinematics(lp.rig.bones, L.angles);
          g.strokeStyle = '#6250d6';
          g.lineWidth = 5 * px;
          for (const w of world.values()) {
            g.beginPath();
            g.moveTo(w.start.x, w.start.y);
            g.lineTo(w.end.x, w.end.y);
            g.stroke();
          }
        }
        g.restore();
      }
      g.restore();
    },
  };

  const finishPath = (pts: Point[]) => {
    if (!layer || pts.length < 2) return;
    s.commit({ kind: 'update', id: layer.id, set: { motionPath: { path: pathFromPoints(pts), orientToPath: layer.props.motionPath?.orientToPath ?? false, easing: layer.props.motionPath?.easing ?? 'ease-in-out' } } }, 'Set motion path');
    ed.getState().set({ pathDraft: null });
  };

  return { handlers, editor: { onionSkin: !playing, showBones: showBones && !playing } };
}
