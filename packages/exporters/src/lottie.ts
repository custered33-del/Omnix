import type { AnimLayerProps, Easing, Keyframe, ProjectState, SceneNode, Stroke, VectorShape } from '@omnix/core';
import { childrenOf, evaluateRig, forwardKinematics, parseColor, playbackTime, requireNodeOfType, tracksOf } from '@omnix/core';
import { animLayerTransform } from '@omnix/render';

/**
 * Lottie (Bodymovin JSON) export for the animation maker. Vector content stays vector:
 * shapes and brush strokes become shape layers, each drawing frame is a layer visible for
 * its hold time, transforms keep their keyframes and easing, motion paths and IK rigs are
 * sampled per frame. Raster images are embedded as image assets.
 */
export interface LottieImageProvider {
  /** Return a PNG data URI for an asset (optionally a crop of it), with its pixel size. */
  (assetId: string, crop?: { x: number; y: number; w: number; h: number }): { dataUri: string; w: number; h: number } | null;
}

export interface LottieExportResult {
  json: Record<string, unknown>;
  notes: string[];
}

type Val = { a: 0; k: unknown } | { a: 1; k: unknown[] };
const stat = (k: unknown): Val => ({ a: 0, k });

function bezierOf(e: Easing): { o: { x: number[]; y: number[] }; i: { x: number[]; y: number[] }; h?: 1 } {
  if (e === 'hold') return { o: { x: [0], y: [0] }, i: { x: [1], y: [1] }, h: 1 };
  const presets: Record<string, [number, number, number, number]> = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
    'back-out': [0.34, 1.56, 0.64, 1],
    'bounce-out': [0.34, 1.4, 0.64, 1],
  };
  const b = typeof e === 'object' ? e.bezier : presets[e] ?? presets.linear!;
  return { o: { x: [b[0]], y: [b[1]] }, i: { x: [b[2]], y: [b[3]] } };
}

/** Convert keyframes (seconds, relative to the layer start) to a Lottie animated property. */
function animated(keys: Keyframe[] | undefined, fallback: number, map: (v: number) => unknown, fps: number, startFrame: number): Val {
  if (!keys || keys.length === 0) return stat(map(fallback));
  if (keys.length === 1) return stat(map(keys[0]!.value));
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  return {
    a: 1,
    k: sorted.map((k, i) => {
      const frame = startFrame + Math.round(k.time * fps);
      if (i === sorted.length - 1) return { t: frame, s: arr(map(k.value)) };
      return { t: frame, s: arr(map(k.value)), ...bezierOf(k.easing) };
    }),
  };
}

const arr = (v: unknown) => (Array.isArray(v) ? v : [v]);

function sampled(frames: number[], values: unknown[][]): Val {
  if (values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]))) return stat(values[0]);
  return { a: 1, k: frames.map((t, i) => (i === frames.length - 1 ? { t, s: values[i] } : { t, s: values[i], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } })) };
}

function colorArr(c: string | null): number[] {
  if (!c) return [0, 0, 0, 0];
  const p = parseColor(c);
  return [p.r / 255, p.g / 255, p.b / 255, p.a];
}

function shapeItems(s: VectorShape): unknown[] {
  const items: unknown[] = [];
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  switch (s.kind) {
    case 'rect':
      items.push({ ty: 'rc', nm: 'Rect', d: 1, p: stat([cx, cy]), s: stat([s.width, s.height]), r: stat(s.radius ?? 0) });
      break;
    case 'ellipse':
      items.push({ ty: 'el', nm: 'Ellipse', d: 1, p: stat([cx, cy]), s: stat([s.width, s.height]) });
      break;
    case 'polygon':
    case 'line': {
      const pts = s.points ?? [];
      items.push({ ty: 'sh', nm: 'Path', d: 1, ks: stat({ c: s.kind === 'polygon', v: pts.map((p) => [p.x, p.y]), i: pts.map(() => [0, 0]), o: pts.map(() => [0, 0]) }) });
      break;
    }
    case 'path': {
      const a = s.path?.anchors ?? [];
      items.push({
        ty: 'sh',
        nm: 'Path',
        d: 1,
        ks: stat({ c: !!s.path?.closed, v: a.map((p) => [p.x, p.y]), i: a.map((p) => (p.in ? [p.in.x - p.x, p.in.y - p.y] : [0, 0])), o: a.map((p) => (p.out ? [p.out.x - p.x, p.out.y - p.y] : [0, 0])) }),
      });
      break;
    }
  }
  if (s.fill && s.kind !== 'line') items.push({ ty: 'fl', nm: 'Fill', c: stat(colorArr(s.fill).slice(0, 3).concat(1)), o: stat(colorArr(s.fill)[3]! * 100), r: 1 });
  if (s.stroke && s.strokeWidth > 0) items.push({ ty: 'st', nm: 'Stroke', c: stat(colorArr(s.stroke).slice(0, 3).concat(1)), o: stat(colorArr(s.stroke)[3]! * 100), w: stat(s.strokeWidth), lc: 2, lj: 2 });
  items.push({ ty: 'tr', p: stat([0, 0]), a: stat([0, 0]), s: stat([100, 100]), r: stat(0), o: stat(100), sk: stat(0), sa: stat(0) });
  return [{ ty: 'gr', nm: s.kind, it: items }];
}

function strokeItems(st: Stroke): unknown[] {
  if (st.tool === 'eraser' || st.points.length === 0) return [];
  const avgPressure = st.points.reduce((a, p) => a + p.pressure, 0) / st.points.length;
  const width = st.size * (0.25 + 0.75 * avgPressure);
  const pts = st.points.length === 1 ? [st.points[0]!, { ...st.points[0]!, x: st.points[0]!.x + 0.01 }] : st.points;
  return [
    {
      ty: 'gr',
      nm: 'Brush stroke',
      it: [
        { ty: 'sh', d: 1, ks: stat({ c: false, v: pts.map((p) => [p.x, p.y]), i: pts.map(() => [0, 0]), o: pts.map(() => [0, 0]) }) },
        { ty: 'st', c: stat(colorArr(st.color).slice(0, 3).concat(1)), o: stat(st.opacity * 100), w: stat(width), lc: 2, lj: 2 },
        { ty: 'tr', p: stat([0, 0]), a: stat([0, 0]), s: stat([100, 100]), r: stat(0), o: stat(100), sk: stat(0), sa: stat(0) },
      ],
    },
  ];
}

export function exportLottie(state: ProjectState, sequenceId: string, images: LottieImageProvider): LottieExportResult {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  const { fps, width, height, duration, name } = seq.props;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const notes: string[] = [];
  const assets: unknown[] = [];
  const layers: Record<string, unknown>[] = [];
  let ind = 0;
  const assetIds = new Map<string, string>();
  const imageAsset = (assetId: string, crop?: { x: number; y: number; w: number; h: number }) => {
    const key = crop ? `${assetId}@${crop.x},${crop.y},${crop.w},${crop.h}` : assetId;
    const known = assetIds.get(key);
    if (known) return known;
    const img = images(assetId, crop);
    if (!img) return null;
    const id = `img_${assetIds.size}`;
    assets.push({ id, w: img.w, h: img.h, u: '', p: img.dataUri, e: 1 });
    assetIds.set(key, id);
    return id;
  };

  // Tracks are listed top-first; Lottie layers are also listed top-first.
  for (const track of tracksOf(state, sequenceId)) {
    if (track.props.hidden) continue;
    if (track.props.trackType !== 'animation') {
      if (childrenOf(state, track.id).some((c) => c.type === 'clip')) notes.push(`Track "${track.props.name}": video and title clips are not part of Lottie exports.`);
      continue;
    }
    for (const node of childrenOf(state, track.id)) {
      if (node.type !== 'animLayer') continue;
      const p = (node as SceneNode<'animLayer'>).props;
      if (!p.visible) continue;
      const ip = Math.round(p.start * fps);
      const op = Math.min(totalFrames, Math.round((p.start + p.duration) * fps));
      const parentInd = ++ind;
      // A null layer carries the layer transform; content layers are parented to it.
      const frameNums: number[] = [];
      for (let f = ip; f <= op; f++) frameNums.push(f);
      let ks: Record<string, unknown>;
      if (p.motionPath && p.motionPath.path.anchors.length > 1) {
        const tr = frameNums.map((f) => animLayerTransform(p, f / fps));
        ks = {
          o: sampled(frameNums, tr.map((t) => [t.opacity * 100])),
          r: sampled(frameNums, tr.map((t) => [t.rotation])),
          p: sampled(frameNums, tr.map((t) => [t.x, t.y, 0])),
          a: stat([p.anchorX, p.anchorY, 0]),
          s: sampled(frameNums, tr.map((t) => [t.scale * 100, t.scale * 100, 100])),
        };
      } else {
        const posKeys = mergeXY(p, fps, ip);
        ks = {
          o: animated(p.keyframes.opacity, p.opacity, (v) => v * 100, fps, ip),
          r: animated(p.keyframes.rotation, p.rotation, (v) => v, fps, ip),
          p: posKeys,
          a: stat([p.anchorX, p.anchorY, 0]),
          s: animated(p.keyframes.scale, p.scale, (v) => [v * 100, v * 100, 100], fps, ip),
        };
      }
      layers.push({ ddd: 0, ind: parentInd, ty: 3, nm: p.name, sr: 1, ks, ao: 0, ip, op, st: 0, bm: 0 });

      // Frame-by-frame drawings: each frame visible for its hold, cycling through the layer duration.
      if (p.frames.length) {
        const holds = p.frames.map((f) => Math.max(1, f.hold));
        const cycle = holds.reduce((a, b) => a + b, 0);
        let f = ip;
        let k = 0;
        while (f < op) {
          const idx = k % p.frames.length;
          const frame = p.frames[idx]!;
          const end = Math.min(op, f + holds[idx]!);
          const shapes = [...frame.shapes.flatMap(shapeItems), ...frame.strokes.flatMap(strokeItems)].reverse();
          if (shapes.length) layers.push({ ddd: 0, ind: ++ind, ty: 4, nm: `${p.name} frame ${idx + 1}`, parent: parentInd, sr: 1, ks: identityKs(), ao: 0, ip: f, op: end, st: 0, bm: 0, shapes });
          if (frame.assetId) {
            const id = imageAsset(frame.assetId);
            if (id) layers.push({ ddd: 0, ind: ++ind, ty: 2, nm: `${p.name} image ${idx + 1}`, parent: parentInd, refId: id, sr: 1, ks: identityKs(), ao: 0, ip: f, op: end, st: 0, bm: 0 });
          }
          if (frame.strokes.some((s) => s.tool === 'heal' || s.tool === 'clone')) notes.push(`"${p.name}": heal/clone strokes are pixel operations and are skipped in Lottie.`);
          f = end;
          k++;
          if (p.playback === 'once' && k >= p.frames.length) {
            // Hold the last drawing until the layer ends.
            const last = p.frames[p.frames.length - 1]!;
            const lastShapes = [...last.shapes.flatMap(shapeItems), ...last.strokes.flatMap(strokeItems)].reverse();
            if (f < op && lastShapes.length) layers.push({ ddd: 0, ind: ++ind, ty: 4, nm: `${p.name} hold`, parent: parentInd, sr: 1, ks: identityKs(), ao: 0, ip: f, op, st: 0, bm: 0, shapes: lastShapes });
            break;
          }
          if (cycle <= 0) break;
        }
      }

      // Sprite sheets: one image layer per sprite frame.
      if (p.sprite) {
        const sp = p.sprite;
        for (let f = ip, i = 0; f < op; f++, i++) {
          const local = playbackTime(p.playback, (f - ip) / fps, sp.frameCount / fps);
          const idx = Math.min(sp.frameCount - 1, Math.floor(local * fps));
          const id = imageAsset(sp.assetId, { x: (idx % sp.columns) * sp.frameWidth, y: Math.floor(idx / sp.columns) * sp.frameHeight, w: sp.frameWidth, h: sp.frameHeight });
          if (!id) break;
          layers.push({ ddd: 0, ind: ++ind, ty: 2, nm: `${p.name} sprite ${idx}`, parent: parentInd, refId: id, sr: 1, ks: identityKs(), ao: 0, ip: f, op: f + 1, st: 0, bm: 0 });
        }
      }

      // IK rigs: bake each attachment's transform per frame.
      if (p.rig && p.rig.bones.length) {
        for (const bone of p.rig.bones) {
          if (!bone.attachment?.shape) {
            if (bone.attachment?.assetId) notes.push(`"${p.name}": image attachments on bones are exported as their pose per frame only when they have vector shapes.`);
            continue;
          }
          const pos: unknown[][] = [];
          const rot: unknown[][] = [];
          for (const f of frameNums) {
            const local = playbackTime(p.playback, f / fps - p.start, p.duration);
            const world = forwardKinematics(p.rig.bones, evaluateRig(p.rig, local)).get(bone.id)!;
            const ox = bone.attachment.offsetX;
            const oy = bone.attachment.offsetY;
            pos.push([world.start.x + Math.cos(world.angle) * ox - Math.sin(world.angle) * oy, world.start.y + Math.sin(world.angle) * ox + Math.cos(world.angle) * oy, 0]);
            rot.push([(world.angle * 180) / Math.PI]);
          }
          layers.push({
            ddd: 0,
            ind: ++ind,
            ty: 4,
            nm: `${p.name} ${bone.name}`,
            parent: parentInd,
            sr: 1,
            ks: { o: stat(100), r: sampled(frameNums, rot), p: sampled(frameNums, pos), a: stat([0, 0, 0]), s: stat([100, 100, 100]) },
            ao: 0,
            ip,
            op,
            st: 0,
            bm: 0,
            shapes: shapeItems(bone.attachment.shape),
          });
        }
      }
    }
  }
  return {
    json: { v: '5.12.2', fr: fps, ip: 0, op: totalFrames, w: width, h: height, nm: name, ddd: 0, assets, layers, markers: [], meta: { g: 'Omnix' } },
    notes: [...new Set(notes)],
  };
}

function identityKs() {
  return { o: stat(100), r: stat(0), p: stat([0, 0, 0]), a: stat([0, 0, 0]), s: stat([100, 100, 100]) };
}

/** Lottie animates position as one [x, y] property: merge separate x and y keyframes by time. */
function mergeXY(p: AnimLayerProps, fps: number, startFrame: number): Val {
  const xs = p.keyframes.x ?? [];
  const ys = p.keyframes.y ?? [];
  if (!xs.length && !ys.length) return stat([p.x, p.y, 0]);
  const times = [...new Set([...xs, ...ys].map((k) => k.time))].sort((a, b) => a - b);
  const at = (keys: Keyframe[], t: number, fb: number) => {
    if (!keys.length) return fb;
    const sorted = [...keys].sort((a, b) => a.time - b.time);
    if (t <= sorted[0]!.time) return sorted[0]!.value;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (t >= a.time && t <= b.time) return a.value + ((b.value - a.value) * (t - a.time)) / Math.max(1e-9, b.time - a.time);
    }
    return sorted[sorted.length - 1]!.value;
  };
  const easingAt = (t: number): Easing => [...xs, ...ys].find((k) => k.time === t)?.easing ?? 'linear';
  if (times.length === 1) return stat([at(xs, times[0]!, p.x), at(ys, times[0]!, p.y), 0]);
  return {
    a: 1,
    k: times.map((t, i) => {
      const s = [at(xs, t, p.x), at(ys, t, p.y), 0];
      const frame = startFrame + Math.round(t * fps);
      return i === times.length - 1 ? { t: frame, s } : { t: frame, s, ...bezierOf(easingAt(t)) };
    }),
  };
}
