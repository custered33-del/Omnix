import type { AnimLayerProps, Bone } from '@omnix/core';
import { evaluateKeyframes, evaluateRig, forwardKinematics, playbackTime, pointAtLength, ease } from '@omnix/core';
import { ctxOf, drawable, type CanvasLike, type Ctx2D, type RenderHost } from './host.js';
import { drawShape } from './shapes.js';
import { renderStrokes } from './strokes.js';

/** Which drawing frame is visible at local time t (seconds) given per-frame holds. */
export function frameIndexAt(p: Pick<AnimLayerProps, 'frames' | 'playback' | 'duration'>, localTime: number, fps: number): number {
  const frames = p.frames;
  if (frames.length === 0) return -1;
  const totalFrames = frames.reduce((a, f) => a + Math.max(1, f.hold), 0);
  const cycle = totalFrames / fps;
  const t = playbackTime(p.playback === 'once' ? 'once' : p.playback, localTime, cycle);
  let tick = Math.floor(t * fps + 1e-6);
  if (p.playback === 'once') tick = Math.min(tick, totalFrames - 1);
  tick = ((tick % totalFrames) + totalFrames) % totalFrames;
  for (let i = 0; i < frames.length; i++) {
    tick -= Math.max(1, frames[i]!.hold);
    if (tick < 0) return i;
  }
  return frames.length - 1;
}

/** Evaluated transform of an animation layer at sequence time t. */
export function animLayerTransform(p: AnimLayerProps, t: number): { x: number; y: number; scale: number; rotation: number; opacity: number } {
  const local = t - p.start;
  let x = evaluateKeyframes(p.keyframes.x, local, p.x);
  let y = evaluateKeyframes(p.keyframes.y, local, p.y);
  let rotation = evaluateKeyframes(p.keyframes.rotation, local, p.rotation);
  if (p.motionPath && p.motionPath.path.anchors.length > 1 && p.duration > 0) {
    const u = ease(p.motionPath.easing, playbackTime(p.playback, local, p.duration) / p.duration);
    const pt = pointAtLength(p.motionPath.path, u);
    x = pt.x;
    y = pt.y;
    if (p.motionPath.orientToPath) rotation += (pt.angle * 180) / Math.PI;
  }
  return {
    x,
    y,
    rotation,
    scale: evaluateKeyframes(p.keyframes.scale, local, p.scale),
    opacity: evaluateKeyframes(p.keyframes.opacity, local, p.opacity),
  };
}

/** Draw a 2D rig: attachments follow their bones; bones are drawn when `showBones` is set (editor). */
export function drawRig(host: RenderHost, ctx: Ctx2D, bones: readonly Bone[], angles: Record<string, number>, showBones = false): void {
  const world = forwardKinematics(bones, angles);
  for (const b of bones) {
    const w = world.get(b.id)!;
    if (b.attachment) {
      ctx.save();
      ctx.translate(w.start.x, w.start.y);
      ctx.rotate(w.angle);
      ctx.translate(b.attachment.offsetX, b.attachment.offsetY);
      if (b.attachment.shape) drawShape(ctx, b.attachment.shape);
      if (b.attachment.assetId) {
        const img = host.image(b.attachment.assetId);
        if (img) ctx.drawImage(drawable(img), 0, -img.height / 2);
      }
      ctx.restore();
    }
  }
  if (showBones) {
    for (const b of bones) {
      const w = world.get(b.id)!;
      const len = Math.max(1, b.length);
      ctx.save();
      ctx.translate(w.start.x, w.start.y);
      ctx.rotate(w.angle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len * 0.15, -len * 0.08);
      ctx.lineTo(len, 0);
      ctx.lineTo(len * 0.15, len * 0.08);
      ctx.closePath();
      ctx.fillStyle = 'rgba(59, 91, 219, 0.35)';
      ctx.strokeStyle = '#3b5bdb';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#3b5bdb';
      ctx.fill();
      ctx.restore();
    }
  }
}

/** Draw a single frame's content (shapes, strokes, image) in layer-local space. */
export function drawFrameContent(host: RenderHost, ctx: Ctx2D, p: AnimLayerProps, index: number, seqW: number, seqH: number): void {
  const frame = p.frames[index];
  if (!frame) return;
  if (frame.assetId) {
    const img = host.image(frame.assetId);
    if (img) ctx.drawImage(drawable(img), 0, 0);
  }
  for (const s of frame.shapes) drawShape(ctx, s);
  if (frame.strokes.length) {
    const buf: CanvasLike = host.createCanvas(seqW, seqH);
    renderStrokes(host, buf, frame.strokes);
    ctx.drawImage(drawable(buf), 0, 0);
  }
}

/** Draw an animation layer at sequence time t into a context already set up in sequence coordinates. */
export function drawAnimLayer(
  host: RenderHost,
  ctx: Ctx2D,
  p: AnimLayerProps,
  t: number,
  fps: number,
  seqW: number,
  seqH: number,
  editor: { onionSkin?: boolean; showBones?: boolean } = {},
): void {
  if (!p.visible) return;
  const local = t - p.start;
  if (local < 0 || local > p.duration + 1e-6) return;
  const tr = animLayerTransform(p, t);
  ctx.save();
  ctx.globalAlpha *= Math.max(0, Math.min(1, tr.opacity));
  ctx.translate(tr.x, tr.y);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(tr.scale, tr.scale);
  ctx.translate(-p.anchorX, -p.anchorY);

  if (p.sprite) {
    const img = host.image(p.sprite.assetId);
    if (img) {
      const fakeFrames = Array.from({ length: p.sprite.frameCount }, (_, i) => ({ id: String(i), hold: 1, shapes: [], strokes: [], assetId: null }));
      const i = frameIndexAt({ frames: fakeFrames, playback: p.playback, duration: p.duration }, local, fps);
      const col = i % p.sprite.columns;
      const row = Math.floor(i / p.sprite.columns);
      ctx.drawImage(drawable(img), col * p.sprite.frameWidth, row * p.sprite.frameHeight, p.sprite.frameWidth, p.sprite.frameHeight, 0, 0, p.sprite.frameWidth, p.sprite.frameHeight);
    }
  }

  if (p.frames.length) {
    const idx = frameIndexAt(p, local, fps);
    if (editor.onionSkin && p.onionSkin.enabled) {
      for (let k = p.onionSkin.before; k >= 1; k--) {
        if (idx - k < 0) continue;
        ctx.save();
        ctx.globalAlpha *= 0.25 / k;
        drawFrameContent(host, ctx, p, idx - k, seqW, seqH);
        ctx.restore();
      }
      for (let k = 1; k <= p.onionSkin.after; k++) {
        if (idx + k >= p.frames.length) continue;
        ctx.save();
        ctx.globalAlpha *= 0.2 / k;
        drawFrameContent(host, ctx, p, idx + k, seqW, seqH);
        ctx.restore();
      }
    }
    drawFrameContent(host, ctx, p, idx, seqW, seqH);
  }

  if (p.rig && p.rig.bones.length) {
    const angles = evaluateRig(p.rig, playbackTime(p.playback, local, p.duration));
    drawRig(host, ctx, p.rig.bones, angles, editor.showBones);
  }
  ctx.restore();
}

/** Render every frame of an animation layer into a sprite sheet canvas. */
export function renderSpriteSheet(
  host: RenderHost,
  p: AnimLayerProps,
  fps: number,
  frameW: number,
  frameH: number,
  columns?: number,
): { canvas: CanvasLike; columns: number; rows: number; frameCount: number } {
  const count = Math.max(1, p.frames.length ? p.frames.reduce((a, f) => a + Math.max(1, f.hold), 0) : Math.round(p.duration * fps));
  const cols = columns ?? Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const sheet = host.createCanvas(cols * frameW, rows * frameH);
  const ctx = ctxOf(sheet);
  for (let i = 0; i < count; i++) {
    ctx.save();
    ctx.translate((i % cols) * frameW, Math.floor(i / cols) * frameH);
    ctx.beginPath();
    ctx.rect(0, 0, frameW, frameH);
    ctx.clip();
    drawAnimLayer(host, ctx, { ...p, playback: 'once' }, p.start + i / fps, fps, frameW, frameH);
    ctx.restore();
  }
  return { canvas: sheet, columns: cols, rows, frameCount: count };
}
