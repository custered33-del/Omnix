import type { DeckProps, ElementAnimation, ProjectState, SceneNode, SlideElementProps } from '@omnix/core';
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

/** Group animations into click steps: group 0 is on-enter, each on-click starts a new group. */
export function animationGroups(animations: readonly ElementAnimation[]): number[] {
  let g = 0;
  return animations.map((a) => {
    if (a.trigger === 'on-click') g += 1;
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
  const master = dp.masters.find((m) => m.id === slide.props.masterId);
  ctx.fillStyle = slide.props.background ?? master?.background ?? dp.theme.colors.background;
  ctx.fillRect(0, 0, W, H);
  ctx.scale(scale, scale);
  const playhead = options.playhead ?? BUILT;
  const isDarkBg = isDark(slide.props.background ?? master?.background ?? dp.theme.colors.background);
  for (const n of childrenOf(state, slideId)) {
    if (n.type !== 'slideElement') continue;
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

function isDark(color: string): boolean {
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

/** Draw an element in its local box (origin at the element's top-left). */
function drawElement(host: RenderHost, state: ProjectState, ctx: Ctx2D, el: SlideElementProps, deck: DeckProps, darkBg: boolean, options: RenderSlideOptions, scale: number): void {
  const theme = deck.theme;
  switch (el.elementType) {
    case 'text': {
      const heading = el.role === 'title' || el.role === 'subtitle';
      const color = el.color ?? (darkBg ? '#ffffff' : el.role === 'subtitle' || el.role === 'footer' ? theme.colors.muted : theme.colors.text);
      drawRichText(
        ctx,
        el.text ?? '',
        {
          fontFamily: fontStack(host, el.fontFamily ?? (heading ? theme.fonts.heading : theme.fonts.body)),
          monoFamily: fontStack(host, theme.fonts.mono),
          fontSize: defaultFontSize(el, deck),
          fontWeight: el.bold || el.role === 'title' ? 700 : 400,
          color,
          linkColor: theme.colors.accent,
          align: el.align ?? 'left',
          lineHeight: heading ? 1.15 : 1.4,
        },
        0,
        0,
        el.w,
        { height: el.h, valign: el.role === 'title' && deck.masters.length ? 'bottom' : 'top' },
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
      const img = el.assetId ? host.videoFrame?.(el.assetId, 0) ?? host.image(el.assetId) : null;
      if (img) drawFitted(ctx, img, 0, 0, el.w, el.h, 'cover');
      else placeholder(ctx, el.w, el.h, 'Video');
      // Play glyph so static exports read as video.
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
      if (el.shape) drawShape(ctx, { ...el.shape, x: 0, y: 0, width: el.w, height: el.h });
      break;
    case 'chart':
      if (el.chart) drawChart(ctx, el.chart, 0, 0, el.w, el.h, { scheme: darkBg ? 'dark' : 'light', fontScale: deck.width / 960, fontFamily: fontStack(host, theme.fonts.body), background: false });
      break;
    case 'embed':
      if (el.embed) {
        const ok = drawEmbed(ctx, el.embed, 0, 0, el.w, el.h, {
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
