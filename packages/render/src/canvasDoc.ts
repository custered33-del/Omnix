import type { LayerProps, ProjectState, SceneNode, Selection } from '@omnix/core';
import { childrenOf, requireNodeOfType } from '@omnix/core';
import { applyAdjustment, applyFilter, mixByMask, rasterizeSelection, resizeMask, invertMask, type Mask } from '@omnix/imaging';
import { ctxOf, drawable, fontStack, maskToCanvas, readRaster, writeRaster, type CanvasLike, type Ctx2D, type RenderHost } from './host.js';
import { drawShape, tracePath } from './shapes.js';
import { renderStrokes } from './strokes.js';
import { cssFont, drawRichText, drawTextOnPath } from './text.js';

/**
 * Image editor compositor. Layers are stacked bottom-to-top in child order.
 * Each layer renders into its own buffer (content -> smart filters -> mask), then
 * composites onto the accumulator with its blend mode and opacity. Adjustment layers
 * transform everything beneath them.
 */
export interface RenderCanvasOptions {
  /** Output scale (0.25 for thumbnails, 2 for retina). */
  scale?: number;
  /** Skip the canvas background (transparent export). */
  transparent?: boolean;
  /** Layers to hide (e.g. during a drag preview). */
  hiddenLayers?: ReadonlySet<string>;
  /** Override props for specific layers without committing (live preview while dragging). */
  overrides?: ReadonlyMap<string, Partial<LayerProps>>;
  /** Render only this layer subtree (layer thumbnails). */
  onlyLayer?: string;
}

export function renderCanvasDocument(host: RenderHost, state: ProjectState, canvasId: string, options: RenderCanvasOptions = {}): CanvasLike {
  const canvas = requireNodeOfType(state, canvasId, 'canvas');
  const scale = options.scale ?? 1;
  const W = Math.max(1, Math.round(canvas.props.width * scale));
  const H = Math.max(1, Math.round(canvas.props.height * scale));
  const out = host.createCanvas(W, H);
  const ctx = ctxOf(out);
  if (!options.transparent && canvas.props.background && !options.onlyLayer) {
    ctx.fillStyle = canvas.props.background;
    ctx.fillRect(0, 0, W, H);
  }
  const env: Env = { host, state, W, H, scale, docW: canvas.props.width, docH: canvas.props.height, options };
  const layers = childrenOf(state, canvasId).filter((n): n is SceneNode<'layer'> => n.type === 'layer');
  if (options.onlyLayer) {
    const only = state.nodes[options.onlyLayer] as SceneNode<'layer'> | undefined;
    if (only) compositeLayer(env, out, only);
    return out;
  }
  compositeLayers(env, out, layers);
  return out;
}

interface Env {
  host: RenderHost;
  state: ProjectState;
  W: number;
  H: number;
  scale: number;
  docW: number;
  docH: number;
  options: RenderCanvasOptions;
}

function propsOf(env: Env, layer: SceneNode<'layer'>): LayerProps {
  const o = env.options.overrides?.get(layer.id);
  return o ? { ...layer.props, ...o } : layer.props;
}

function compositeLayers(env: Env, acc: CanvasLike, layers: SceneNode<'layer'>[]): void {
  for (const layer of layers) compositeLayer(env, acc, layer);
}

function compositeLayer(env: Env, acc: CanvasLike, layer: SceneNode<'layer'>): void {
  const p = propsOf(env, layer);
  if (!p.visible || env.options.hiddenLayers?.has(layer.id)) return;
  if (p.layerType === 'adjustment') {
    applyAdjustmentLayer(env, acc, p);
    return;
  }
  const buf = renderLayerBuffer(env, layer, p);
  const ctx = ctxOf(acc);
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, p.opacity));
  ctx.globalCompositeOperation = (p.blendMode === 'normal' ? 'source-over' : p.blendMode) as GlobalCompositeOperation;
  ctx.drawImage(drawable(buf), 0, 0);
  ctx.restore();
}

/** Rasterize a selection at output resolution. */
export function selectionMask(host: RenderHost, sel: Selection, docW: number, docH: number, scale: number): Mask {
  const W = Math.max(1, Math.round(docW * scale));
  const H = Math.max(1, Math.round(docH * scale));
  if (sel.kind === 'mask') {
    const m = host.mask?.(sel.assetId);
    if (!m) return { width: W, height: H, data: new Uint8ClampedArray(W * H) };
    return m.width === W && m.height === H ? m : resizeMask(m, W, H);
  }
  const scaled: Selection =
    sel.kind === 'polygon'
      ? { kind: 'polygon', points: sel.points.map((pt) => ({ x: pt.x * scale, y: pt.y * scale })), feather: (sel.feather ?? 0) * scale }
      : { ...sel, x: sel.x * scale, y: sel.y * scale, width: sel.width * scale, height: sel.height * scale, feather: (sel.feather ?? 0) * scale };
  return rasterizeSelection(scaled, W, H);
}

function layerMask(env: Env, p: LayerProps): Mask | null {
  if (!p.mask || !p.mask.enabled) return null;
  const m = selectionMask(env.host, p.mask.source, env.docW, env.docH, env.scale);
  return p.mask.inverted ? invertMask(m) : m;
}

function applyAdjustmentLayer(env: Env, acc: CanvasLike, p: LayerProps): void {
  if (!p.adjustment) return;
  const before = readRaster(acc);
  const after = applyAdjustment(before, p.adjustment, env.host.lut);
  writeRaster(acc, mixByMask(before, after, layerMask(env, p), Math.min(1, Math.max(0, p.opacity))));
}

function applyLayerTransform(ctx: Ctx2D, p: LayerProps, scale: number): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(p.x, p.y);
  if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180);
  if (p.scaleX !== 1 || p.scaleY !== 1) ctx.scale(p.scaleX, p.scaleY);
}

/** Render one layer (content, smart filters, mask) into a full-size transparent buffer. */
export function renderLayerBuffer(env: Env, layer: SceneNode<'layer'>, p: LayerProps = layer.props): CanvasLike {
  const { host, W, H, scale } = env;
  const buf = host.createCanvas(W, H);
  const ctx = ctxOf(buf);
  ctx.save();
  if (p.vectorMask && p.layerType !== 'fill') {
    applyLayerTransform(ctx, p, scale);
    ctx.beginPath();
    tracePath(ctx, p.vectorMask);
    ctx.clip();
  }
  switch (p.layerType) {
    case 'fill':
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = p.fillColor ?? '#ffffff';
      ctx.fillRect(0, 0, W, H);
      break;
    case 'raster':
      drawRasterLayer(env, ctx, p);
      break;
    case 'vector':
      applyLayerTransform(ctx, p, scale);
      for (const s of p.shapes ?? []) drawShape(ctx, s);
      break;
    case 'text':
      applyLayerTransform(ctx, p, scale);
      drawTextLayer(host, ctx, p);
      break;
    case 'group': {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const kids = childrenOf(env.state, layer.id).filter((n): n is SceneNode<'layer'> => n.type === 'layer');
      compositeLayers(env, buf, kids);
      break;
    }
    case 'adjustment':
      break;
  }
  ctx.restore();

  const filters = (p.filters ?? []).filter((f) => f.enabled);
  if (filters.length) {
    let r = readRaster(buf);
    for (const f of filters) {
      const params = { ...f.params };
      for (const k of ['radius', 'size']) if (typeof params[k] === 'number' && f.filter !== 'vignette') params[k] = params[k]! * scale;
      const next = applyFilter(r, f.filter, params);
      r = f.opacity >= 1 ? next : mixByMask(r, next, null, f.opacity);
    }
    writeRaster(buf, r);
  }

  const m = layerMask(env, p);
  if (m) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(drawable(maskToCanvas(host, m)), 0, 0);
    ctx.restore();
  }
  return buf;
}

function drawRasterLayer(env: Env, ctx: Ctx2D, p: LayerProps): void {
  const { host, scale } = env;
  const img = p.assetId ? host.image(p.assetId) : null;
  const lw = Math.max(1, Math.round(p.width ?? img?.width ?? env.docW));
  const lh = Math.max(1, Math.round(p.height ?? img?.height ?? env.docH));
  const strokes = p.strokes ?? [];
  // Paint into an untransformed local buffer so clone/heal sample the layer's own pixels.
  const local = host.createCanvas(lw, lh);
  const lctx = ctxOf(local);
  if (img) lctx.drawImage(drawable(img), 0, 0, lw, lh);
  if (strokes.length) renderStrokes(host, local, strokes);
  applyLayerTransform(ctx, p, scale);
  ctx.drawImage(drawable(local), 0, 0);
}

function drawTextLayer(host: RenderHost, ctx: Ctx2D, p: LayerProps): void {
  const text = p.text ?? '';
  const family = fontStack(host, p.fontFamily);
  const style = {
    fontFamily: family,
    fontSize: p.fontSize ?? 48,
    fontWeight: p.fontVariations?.wght ?? p.fontWeight ?? 400,
    italic: p.fontStyle === 'italic',
    color: p.color ?? '#000000',
    align: p.align ?? 'left',
    lineHeight: p.lineHeight ?? 1.2,
    letterSpacing: p.letterSpacing ?? 0,
  } as const;
  if (p.textPath && p.textPath.anchors.length > 1) {
    drawTextOnPath(ctx, text, p.textPath, cssFont(style), style.color, style.letterSpacing, p.baselineShift ?? 0, style.align);
    return;
  }
  const escaped = text.replace(/([*_`~[\]\\])/g, '\\$1');
  const box = p.boxWidth ?? 1e6;
  const x = p.boxWidth ? 0 : style.align === 'center' ? -box / 2 : style.align === 'right' ? -box : 0;
  ctx.save();
  ctx.translate(0, -(p.baselineShift ?? 0));
  drawRichText(ctx, escaped, style, x, 0, box);
  ctx.restore();
}

/** Bounding box of a layer's content in canvas coordinates (approximate for text). */
export function layerBounds(host: RenderHost, state: ProjectState, layerId: string): { x: number; y: number; width: number; height: number } {
  const layer = requireNodeOfType(state, layerId, 'layer');
  const p = layer.props;
  switch (p.layerType) {
    case 'raster': {
      const img = p.assetId ? host.image(p.assetId) : null;
      return { x: p.x, y: p.y, width: (p.width ?? img?.width ?? 0) * p.scaleX, height: (p.height ?? img?.height ?? 0) * p.scaleY };
    }
    case 'vector': {
      const shapes = p.shapes ?? [];
      if (!shapes.length) return { x: p.x, y: p.y, width: 0, height: 0 };
      const minX = Math.min(...shapes.map((s) => s.x));
      const minY = Math.min(...shapes.map((s) => s.y));
      const maxX = Math.max(...shapes.map((s) => s.x + s.width));
      const maxY = Math.max(...shapes.map((s) => s.y + s.height));
      return { x: p.x + minX * p.scaleX, y: p.y + minY * p.scaleY, width: (maxX - minX) * p.scaleX, height: (maxY - minY) * p.scaleY };
    }
    case 'text': {
      const size = p.fontSize ?? 48;
      const lines = (p.text ?? '').split('\n');
      const width = p.boxWidth ?? Math.max(...lines.map((l) => l.length)) * size * 0.55;
      const x = p.boxWidth ? p.x : p.align === 'center' ? p.x - width / 2 : p.align === 'right' ? p.x - width : p.x;
      return { x, y: p.y, width: width * p.scaleX, height: lines.length * size * (p.lineHeight ?? 1.2) * p.scaleY };
    }
    default: {
      const canvas = state.nodes[layer.parentId!];
      const cp = canvas?.type === 'canvas' ? (canvas as SceneNode<'canvas'>).props : { width: 0, height: 0 };
      return { x: 0, y: 0, width: cp.width, height: cp.height };
    }
  }
}
