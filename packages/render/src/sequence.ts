import type { ClipProps, ProjectState, SceneNode, Transition } from '@omnix/core';
import { clipEnd, clipPropsAt, clipsOf, childrenOf, ease, requireNodeOfType, sourceTimeAt, tracksOf, playbackTime } from '@omnix/core';
import { applyFilter, removeBackground, gaussianBlur } from '@omnix/imaging';
import { ctxOf, drawable, fontStack, readRaster, writeRaster, type CanvasLike, type Ctx2D, type Drawable, type RenderHost } from './host.js';
import { drawAnimLayer } from './animation.js';
import { drawRichText } from './text.js';
import { roundedRectPath } from './shapes.js';

/**
 * Renders one frame of a sequence (video or animation). Tracks are listed top-first,
 * so they are drawn in reverse order. Audio tracks are not drawn.
 */
export interface SequenceRenderOptions {
  scale?: number;
  /** Editor overlays for the animation maker. */
  editor?: { onionSkin?: boolean; showBones?: boolean };
  /** Skip effects/background removal for fast scrubbing. */
  draft?: boolean;
  /** Leave the sequence background transparent (animated GIF/APNG/WebM with alpha). */
  transparent?: boolean;
}

export function renderSequenceFrame(host: RenderHost, state: ProjectState, sequenceId: string, time: number, options: SequenceRenderOptions = {}): CanvasLike {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  const sp = seq.props;
  const scale = options.scale ?? 1;
  const W = Math.max(1, Math.round(sp.width * scale));
  const H = Math.max(1, Math.round(sp.height * scale));
  const t = sp.purpose === 'animation' ? playbackTime(sp.playback, time, sp.duration) : time;
  const out = host.createCanvas(W, H);
  const ctx = ctxOf(out);
  if (!options.transparent) {
    ctx.fillStyle = sp.background;
    ctx.fillRect(0, 0, W, H);
  }
  const env: SeqEnv = { host, W, H, scale, seqW: sp.width, seqH: sp.height, fps: sp.fps, options };
  const tracks = tracksOf(state, sequenceId).slice().reverse();
  for (const track of tracks) {
    if (track.props.hidden) continue;
    switch (track.props.trackType) {
      case 'audio':
        break;
      case 'animation': {
        ctx.save();
        ctx.scale(scale, scale);
        for (const n of childrenOf(state, track.id)) {
          if (n.type === 'animLayer') drawAnimLayer(host, ctx, (n as SceneNode<'animLayer'>).props, t, sp.fps, sp.width, sp.height, options.editor);
        }
        ctx.restore();
        break;
      }
      case 'effect': {
        for (const clip of clipsOf(state, track.id)) {
          const p = clip.props;
          if (t < p.start || t >= clipEnd(p) || options.draft) continue;
          let r = readRaster(out);
          for (const fx of p.effects.filter((e) => e.enabled)) {
            if (fx.effect === 'colorGrade') continue;
            r = applyFilter(r, fx.effect, scaleParams(fx.params, scale));
          }
          writeRaster(out, r);
        }
        break;
      }
      default:
        drawTrackAt(env, ctx, clipsOf(state, track.id), t);
    }
  }
  return out;
}

interface SeqEnv {
  host: RenderHost;
  W: number;
  H: number;
  scale: number;
  seqW: number;
  seqH: number;
  fps: number;
  options: SequenceRenderOptions;
}

function scaleParams(params: Record<string, number>, scale: number): Record<string, number> {
  const out = { ...params };
  for (const k of ['radius', 'size']) if (typeof out[k] === 'number') out[k] = out[k]! * scale;
  return out;
}

const EPS = 1e-6;

function drawTrackAt(env: SeqEnv, ctx: Ctx2D, clips: SceneNode<'clip'>[], t: number): void {
  const i = clips.findIndex((c) => t >= c.props.start - EPS && t < clipEnd(c.props) - EPS);
  if (i < 0) return;
  const clip = clips[i]!;
  const p = clip.props;
  const prev = i > 0 ? clips[i - 1] : undefined;
  const next = clips[i + 1];
  const prevAdjacent = prev && Math.abs(clipEnd(prev.props) - p.start) < 1e-3 ? prev : undefined;
  const nextAdjacent = next && Math.abs(clipEnd(p) - next.props.start) < 1e-3 ? next : undefined;

  const tin = p.transitionIn;
  if (tin && tin.duration > 0 && t < p.start + tin.duration) {
    const progress = ease(tin.easing, (t - p.start) / tin.duration);
    drawTransition(env, ctx, tin, progress, prevAdjacent ? (c: Ctx2D) => drawClip(env, c, prevAdjacent.props, t, true) : null, (c: Ctx2D) => drawClip(env, c, p, t));
    return;
  }
  const tout = p.transitionOut;
  const end = clipEnd(p);
  if (tout && tout.duration > 0 && t > end - tout.duration && !(nextAdjacent && nextAdjacent.props.transitionIn)) {
    const progress = ease(tout.easing, (t - (end - tout.duration)) / tout.duration);
    drawTransition(env, ctx, tout, progress, (c: Ctx2D) => drawClip(env, c, p, t), null);
    return;
  }
  drawClip(env, ctx, p, t);
}

/**
 * Draw a transition between an outgoing and incoming drawer at progress 0..1.
 * A null side means "nothing" (fade from/to the content underneath).
 */
function drawTransition(env: SeqEnv, ctx: Ctx2D, tr: Transition, p: number, outgoing: ((c: Ctx2D) => void) | null, incoming: ((c: Ctx2D) => void) | null): void {
  const { W, H } = env;
  const layer = (draw: ((c: Ctx2D) => void) | null, alpha: number, dx = 0, scale = 1, clip?: [number, number, number, number]) => {
    if (!draw || alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (clip) {
      ctx.beginPath();
      ctx.rect(...clip);
      ctx.clip();
    }
    if (dx) ctx.translate(dx, 0);
    if (scale !== 1) {
      ctx.translate(W / 2, H / 2);
      ctx.scale(scale, scale);
      ctx.translate(-W / 2, -H / 2);
    }
    draw(ctx);
    ctx.restore();
  };
  switch (tr.kind) {
    case 'crossfade':
      layer(outgoing, 1);
      layer(incoming, p);
      break;
    case 'dip-to-black':
      if (p < 0.5) {
        layer(outgoing, 1);
        ctx.save();
        ctx.fillStyle = `rgba(0,0,0,${p * 2})`;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      } else {
        layer(incoming, 1);
        ctx.save();
        ctx.fillStyle = `rgba(0,0,0,${(1 - p) * 2})`;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      break;
    case 'wipe-left':
      layer(outgoing, 1, 0, 1, [0, 0, W * (1 - p), H]);
      layer(incoming, 1, 0, 1, [W * (1 - p), 0, W * p + 1, H]);
      break;
    case 'wipe-right':
      layer(outgoing, 1, 0, 1, [W * p, 0, W * (1 - p) + 1, H]);
      layer(incoming, 1, 0, 1, [0, 0, W * p, H]);
      break;
    case 'slide-left':
      layer(outgoing, 1, -W * p);
      layer(incoming, 1, W * (1 - p));
      break;
    case 'zoom':
      layer(outgoing, 1 - p, 0, 1 + 0.15 * p);
      layer(incoming, p, 0, 1.25 - 0.25 * p);
      break;
  }
}

/** Resolve the media frame for a clip at time t (extended = past the clip end, for transitions). */
function clipFrame(env: SeqEnv, p: ClipProps, t: number, extended: boolean): Drawable | null {
  if (!p.assetId) return null;
  let src = sourceTimeAt(p, t);
  if (src === null && extended) {
    const past = (t - clipEnd(p)) * p.speed;
    src = p.reverse ? Math.max(0, p.in - past) : p.sourceDuration > 0 ? Math.min(p.sourceDuration, p.out + past) : p.out;
  }
  if (src === null) src = p.reverse ? p.out : p.in;
  return env.host.videoFrame?.(p.assetId, src) ?? env.host.image(p.assetId);
}

function drawClip(env: SeqEnv, ctx: Ctx2D, p: ClipProps, t: number, extended = false): void {
  const { host, W, H, scale } = env;
  const props = clipPropsAt(p, Math.min(t, extended ? clipEnd(p) : t));
  if (props.opacity <= 0) return;
  const needsPixels = !env.options.draft && (p.effects.some((e) => e.enabled) || p.backgroundRemoval?.enabled || props.blur > 0.25);
  const target: CanvasLike | null = needsPixels ? host.createCanvas(W, H) : null;
  const c = target ? ctxOf(target) : ctx;
  c.save();
  if (!target) c.globalAlpha *= props.opacity;
  c.translate(W / 2 + props.x * scale, H / 2 + props.y * scale);
  if (props.rotation) c.rotate((props.rotation * Math.PI) / 180);
  c.scale(props.scale, props.scale);
  if (p.title) {
    drawTitle(host, c, p, W, H, scale);
  } else {
    const frame = clipFrame(env, p, t, extended);
    if (frame && frame.width && frame.height) {
      const s = Math.min(W / frame.width, H / frame.height);
      const dw = frame.width * s;
      const dh = frame.height * s;
      c.drawImage(drawable(frame), -dw / 2, -dh / 2, dw, dh);
    }
  }
  c.restore();
  if (target) {
    let r = readRaster(target);
    if (p.backgroundRemoval?.enabled && p.backgroundRemoval.method !== 'provider') {
      r = removeBackground(r, {
        method: p.backgroundRemoval.method,
        keyColor: p.backgroundRemoval.keyColor,
        tolerance: p.backgroundRemoval.tolerance,
        softness: p.backgroundRemoval.softness,
      }).raster;
    }
    for (const fx of p.effects.filter((e) => e.enabled)) {
      if (fx.effect === 'colorGrade') continue;
      r = applyFilter(r, fx.effect, scaleParams(fx.params, scale));
    }
    if (props.blur > 0.25) r = gaussianBlur(r, props.blur * scale);
    writeRaster(target, r);
    ctx.save();
    ctx.globalAlpha *= props.opacity;
    ctx.drawImage(drawable(target), 0, 0);
    ctx.restore();
  }
}

/** Titles and captions. Coordinates: origin at frame center (already translated). */
function drawTitle(host: RenderHost, ctx: Ctx2D, p: ClipProps, W: number, H: number, scale: number): void {
  const spec = p.title!;
  const fontSize = spec.fontSize * scale;
  const style = {
    fontFamily: fontStack(host, spec.fontFamily),
    fontSize,
    fontWeight: spec.fontWeight,
    color: spec.color,
    align: spec.align,
    lineHeight: 1.25,
  } as const;
  const boxW = W * (spec.caption ? 0.8 : 0.86);
  const escaped = spec.text;
  // Measure by laying out off-screen.
  const lines = escaped.split('\n').length;
  const approxH = Math.max(fontSize * 1.25 * lines, fontSize * 1.25);
  let top: number;
  if (spec.caption) top = H / 2 - approxH - H * 0.08;
  else top = -approxH / 2;
  if (spec.background) {
    ctx.save();
    ctx.font = `${spec.fontWeight} ${fontSize}px ${style.fontFamily}`;
    const widest = Math.max(...escaped.split('\n').map((l) => ctx.measureText(l).width));
    const bw = Math.min(boxW, widest) + fontSize * 0.8;
    const bx = spec.align === 'left' ? -boxW / 2 - fontSize * 0.4 : spec.align === 'right' ? boxW / 2 - bw + fontSize * 0.4 : -bw / 2;
    ctx.fillStyle = spec.background;
    ctx.beginPath();
    roundedRectPath(ctx, bx, top - fontSize * 0.25, bw, approxH + fontSize * 0.5, fontSize * 0.2);
    ctx.fill();
    ctx.restore();
  }
  drawRichText(ctx, escaped, style, -boxW / 2, top, boxW);
}
