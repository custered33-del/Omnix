import type { DeckProps, ElementAnimation, ProjectState, SceneNode, SlideElementProps, VectorShape } from '@omnix/core';
import { childrenOf, ease, evaluateKeyframes, requireNodeOfType } from '@omnix/core';
import { ctxOf, drawable, drawFitted, fontStack, type CanvasLike, type Ctx2D, type RenderHost } from './host.js';
import { drawRichText } from './text.js';
import { drawShape } from './shapes.js';
import { drawChart } from './chart.js';
import { drawEmbed } from './embeds.js';

/**
 * Slide rendering with build animations. The playhead is (step, t): `step` counts
 * clicks taken on this slide, `t` is seconds since that step began. Static renders
 * (thumbnails, PDF/PPTX export) use the fully built state.
 */
export interface SlidePlayhead {
  step: number;
  t: number;
}

export const BUILT: SlidePlayhead = { step: Number.POSITIVE_INFINITY, t: Number.POSITIVE_INFINITY };

export interface RenderSlideOptions {
  scale?: number;
  playhead?: SlidePlayhead;
  scheme?: 'light' | 'dark';
  /** Hide exit animations in static renders so content stays visible. */
  ignoreExits?: boolean;
  depth?: number;
  /**
   * Seconds since the slide appeared (presenting). Video elements and animation or video embeds
   * play from their start time; static renders leave it unset and show the first frame.
   */
  mediaTime?: number;
  /** Elements drawn by the caller instead (e.g. live HTML video during a presentation). */
  skipElements?: ReadonlySet<string>;
}

export interface ElementVisualState {
  visible: boolean;
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
}

const ENTRANCES = new Set(['fade-in', 'fly-in', 'zoom-in']);
const EXITS = new Set(['fade-out', 'fly-out']);

/**
 * The click step each animation runs in: 0 is when the slide appears, on-click animations run on
 * their `click` (or the click after this element's previous animation), with-previous joins the
 * previous animation's step.
 */
export function animationGroups(animations: readonly ElementAnimation[]): number[] {
  let g = 0;
  return animations.map((a) => {
    if (a.trigger === 'on-enter') g = 0;
    else if (a.trigger === 'on-click') g = a.click && a.click > 0 ? Math.round(a.click) : g + 1;
    return g;
  });
}

/** Number of click steps a slide needs (max over elements). */
export function slideStepCount(state: ProjectState, slideId: string): number {
  let max = 0;
  for (const el of childrenOf(state, slideId)) {
    if (el.type !== 'slideElement') continue;
    const groups = animationGroups((el as SceneNode<'slideElement'>).props.animations);
    for (const g of groups) max = Math.max(max, g);
  }
  return max;
}

export function elementStateAt(el: SlideElementProps, playhead: SlidePlayhead, deckW: number, ignoreExits = false): ElementVisualState {
  const s: ElementVisualState = { visible: true, opacity: el.opacity, dx: 0, dy: 0, scale: 1, rotation: 0 };
  const groups = animationGroups(el.animations);
  // Before its first entrance plays, an element with an entrance is hidden.
  el.animations.forEach((a, i) => {
    const g = groups[i]!;
    let progress: number;
    if (g < playhead.step) progress = 1;
    else if (g > playhead.step) progress = 0;
    else progress = a.duration > 0 ? Math.min(1, Math.max(0, (playhead.t - a.delay) / a.duration)) : playhead.t >= a.delay ? 1 : 0;
    const p = ease(a.easing, progress);
    if (EXITS.has(a.kind) && ignoreExits) return;
    switch (a.kind) {
      case 'fade-in':
        s.opacity *= p;
        break;
      case 'fly-in':
        s.opacity *= progress > 0 ? 1 : 0;
        s.dy += (1 - p) * deckW * 0.08;
        break;
      case 'zoom-in':
        s.opacity *= p;
        s.scale *= 0.6 + 0.4 * p;
        break;
      case 'fade-out':
        s.opacity *= 1 - p;
        break;
      case 'fly-out':
        s.dy -= p * deckW * 0.08;
        s.opacity *= 1 - p;
        break;
      case 'pulse':
        s.scale *= 1 + 0.08 * Math.sin(p * Math.PI);
        break;
      case 'spin':
        s.rotation += p * 360;
        break;
      case 'custom': {
        const local = progress * a.duration;
        if (a.keyframes) {
          s.dx += evaluateKeyframes(a.keyframes.x, local, 0);
          s.dy += evaluateKeyframes(a.keyframes.y, local, 0);
          s.scale *= evaluateKeyframes(a.keyframes.scale, local, 1);
          s.rotation += evaluateKeyframes(a.keyframes.rotation, local, 0);
          s.opacity *= evaluateKeyframes(a.keyframes.opacity, local, 1);
        }
        break;
      }
    }
    if (ENTRANCES.has(a.kind) && progress === 0) s.visible = false;
  });
  if (s.opacity <= 0.001) s.visible = false;
  return s;
}

export function deckOf(state: ProjectState, slideId: string): SceneNode<'deck'> {
  const slide = requireNodeOfType(state, slideId, 'slide');
  return requireNodeOfType(state, slide.parentId!, 'deck');
}

export function renderSlide(host: RenderHost, state: ProjectState, slideId: string, options: RenderSlideOptions = {}): CanvasLike {
  const slide = requireNodeOfType(state, slideId, 'slide');
  const deck = deckOf(state, slideId);
  const dp = deck.props;
  const scale = options.scale ?? 1;
  const W = Math.max(1, Math.round(dp.width * scale));
  const H = Math.max(1, Math.round(dp.height * scale));
  const out = host.createCanvas(W, H);
  const ctx = ctxOf(out);
  const bg = slideBackground(dp, slide.props);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.scale(scale, scale);
  const playhead = options.playhead ?? BUILT;
  const isDarkBg = isDarkColor(bg);
  for (const n of childrenOf(state, slideId)) {
    if (n.type !== 'slideElement' || options.skipElements?.has(n.id)) continue;
    const el = (n as SceneNode<'slideElement'>).props;
    const vs = elementStateAt(el, playhead, dp.width, options.ignoreExits ?? playhead === BUILT);
    if (!vs.visible) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, vs.opacity));
    const cx = el.x + el.w / 2 + vs.dx;
    const cy = el.y + el.h / 2 + vs.dy;
    ctx.translate(cx, cy);
    const rot = el.rotation + vs.rotation;
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    if (vs.scale !== 1) ctx.scale(vs.scale, vs.scale);
    ctx.translate(-el.w / 2, -el.h / 2);
    drawElement(host, state, ctx, el, dp, isDarkBg, options, scale);
    ctx.restore();
  }
  return out;
}

/** The color behind a slide: its own, its master's, or the theme background. */
export function slideBackground(deck: DeckProps, slide: { masterId: string | null; background: string | null }): string {
  const master = deck.masters.find((m) => m.id === slide.masterId);
  return slide.background ?? master?.background ?? deck.theme.colors.background;
}

export function isDarkColor(color: string): boolean {
  const h = color.replace('#', '');
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
}

export function defaultFontSize(el: SlideElementProps, deck: DeckProps): number {
  if (el.fontSize) return el.fontSize;
  switch (el.role) {
    case 'title':
      return deck.theme.sizes.title;
    case 'subtitle':
      return deck.theme.sizes.heading * 0.75;
    case 'footer':
      return deck.theme.sizes.caption;
    default:
      return deck.theme.sizes.body;
  }
}

/** How a text element looks with theme defaults applied (shared by rendering and PowerPoint export). */
export function slideTextLook(el: SlideElementProps, deck: DeckProps, darkBg: boolean) {
  const theme = deck.theme;
  const heading = el.role === 'title' || el.role === 'subtitle';
  return {
    fontFamily: el.fontFamily ?? (heading ? theme.fonts.heading : theme.fonts.body),
    monoFamily: theme.fonts.mono,
    fontSize: defaultFontSize(el, deck),
    // Titles are bold unless the element says otherwise (imported decks often do).
    bold: el.bold ?? el.role === 'title',
    color: el.color ?? (darkBg ? '#ffffff' : el.role === 'subtitle' || el.role === 'footer' ? theme.colors.muted : theme.colors.text),
    linkColor: theme.colors.accent,
    align: el.align ?? 'left',
    valign: el.valign ?? (el.role === 'title' && deck.masters.length ? 'bottom' : 'top'),
    lineHeight: heading ? 1.15 : 1.4,
  } as const;
}

/** Draw an element in its local box (origin at the element's top-left). */
function drawElement(host: RenderHost, state: ProjectState, ctx: Ctx2D, el: SlideElementProps, deck: DeckProps, darkBg: boolean, options: RenderSlideOptions, scale: number): void {
  const theme = deck.theme;
  switch (el.elementType) {
    case 'text': {
      const look = slideTextLook(el, deck, darkBg);
      drawRichText(
        ctx,
        el.text ?? '',
        {
          fontFamily: fontStack(host, look.fontFamily),
          monoFamily: fontStack(host, look.monoFamily),
          fontSize: look.fontSize,
          fontWeight: look.bold ? 700 : 400,
          color: look.color,
          linkColor: look.linkColor,
          align: look.align,
          lineHeight: look.lineHeight,
        },
        0,
        0,
        el.w,
        { height: el.h, valign: look.valign },
      );
      break;
    }
    case 'image': {
      const img = el.assetId ? host.image(el.assetId) : null;
      if (img) drawFitted(ctx, img, 0, 0, el.w, el.h, 'cover');
      else placeholder(ctx, el.w, el.h, 'Image');
      break;
    }
    case 'video': {
      const img = el.assetId ? host.videoFrame?.(el.assetId, options.mediaTime ?? 0) ?? host.image(el.assetId) : null;
      if (img) drawFitted(ctx, img, 0, 0, el.w, el.h, 'cover');
      else placeholder(ctx, el.w, el.h, 'Video');
      // Play glyph so static exports read as video.
      if (options.mediaTime !== undefined) break;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const r = Math.min(el.w, el.h) * 0.12;
      ctx.beginPath();
      ctx.arc(el.w / 2, el.h / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(el.w / 2 - r * 0.35, el.h / 2 - r * 0.5);
      ctx.lineTo(el.w / 2 + r * 0.55, el.h / 2);
      ctx.lineTo(el.w / 2 - r * 0.35, el.h / 2 + r * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'shape':
      if (el.shape) drawShape(ctx, fitShape(el.shape, el.w, el.h));
      break;
    case 'chart':
      if (el.chart) drawChart(ctx, el.chart, 0, 0, el.w, el.h, { scheme: darkBg ? 'dark' : 'light', fontScale: deck.width / 960, fontFamily: fontStack(host, theme.fonts.body), background: false });
      break;
    case 'embed':
      if (el.embed) {
        const embed = options.mediaTime !== undefined && el.embed.kind === 'sequence-frame' ? { ...el.embed, time: playEmbedTime(state, el.embed.ref, (el.embed.time ?? 0) + options.mediaTime) } : el.embed;
        const ok = drawEmbed(ctx, embed, 0, 0, el.w, el.h, {
          host,
          state,
          scheme: darkBg ? 'dark' : 'light',
          fontScale: deck.width / 960,
          depth: (options.depth ?? 0) + 1,
          renderSlide: (id, w, h) => {
            const d = deckOf(state, id).props;
            return renderSlide(host, state, id, { scale: Math.min(w / d.width, h / d.height), depth: (options.depth ?? 0) + 1 });
          },
        });
        if (!ok) placeholder(ctx, el.w, el.h, 'Linked content unavailable');
      }
      break;
  }
  void scale;
}

/** A slide shape stretched to its element box: points and paths scale from the shape's own frame. */
export function fitShape(shape: VectorShape, w: number, h: number): VectorShape {
  const sx = shape.width ? w / shape.width : 1;
  const sy = shape.height ? h / shape.height : 1;
  const pt = (p: { x: number; y: number }) => ({ x: (p.x - shape.x) * sx, y: (p.y - shape.y) * sy });
  return {
    ...shape,
    x: 0,
    y: 0,
    width: w,
    height: h,
    ...(shape.points ? { points: shape.points.map(pt) } : {}),
    ...(shape.path ? { path: { closed: shape.path.closed, anchors: shape.path.anchors.map((a) => ({ ...pt(a), ...(a.in ? { in: pt(a.in) } : {}), ...(a.out ? { out: pt(a.out) } : {}) })) } } : {}),
  };
}

/** Animations loop while presenting; videos hold their last frame. */
function playEmbedTime(state: ProjectState, seqId: string, t: number): number {
  const seq = state.nodes[seqId] as SceneNode<'sequence'> | undefined;
  if (!seq || seq.type !== 'sequence') return t;
  const d = Math.max(0.01, seq.props.duration);
  return seq.props.purpose === 'animation' ? t % d : Math.min(t, d);
}

function placeholder(ctx: Ctx2D, w: number, h: number, label: string): void {
  ctx.save();
  ctx.fillStyle = 'rgba(120,120,120,0.12)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(120,120,120,0.5)';
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(90,90,90,0.9)';
  ctx.font = `500 ${Math.max(12, Math.min(w, h) * 0.08)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2);
  ctx.restore();
}

/** Render the transition between two slides at progress 0..1 (presenter view). */
export function renderSlideTransition(host: RenderHost, from: CanvasLike | null, to: CanvasLike, kind: string, progress: number): CanvasLike {
  const out = host.createCanvas(to.width, to.height);
  const ctx = ctxOf(out);
  const W = to.width;
  const p = Math.max(0, Math.min(1, progress));
  if (from) ctx.drawImage(drawable(from), kind === 'push' ? -W * p : 0, 0);
  ctx.save();
  switch (kind) {
    case 'fade':
      ctx.globalAlpha = p;
      ctx.drawImage(drawable(to), 0, 0);
      break;
    case 'push':
      ctx.drawImage(drawable(to), W * (1 - p), 0);
      break;
    case 'wipe':
      ctx.beginPath();
      ctx.rect(0, 0, W * p, to.height);
      ctx.clip();
      ctx.drawImage(drawable(to), 0, 0);
      break;
    case 'zoom':
      ctx.globalAlpha = p;
      ctx.translate(W / 2, to.height / 2);
      ctx.scale(0.8 + 0.2 * p, 0.8 + 0.2 * p);
      ctx.drawImage(drawable(to), -W / 2, -to.height / 2);
      break;
    default:
      ctx.drawImage(drawable(to), 0, 0);
  }
  ctx.restore();
  return out;
}
