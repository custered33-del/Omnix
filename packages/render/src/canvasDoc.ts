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
  /**
   * Reuse rendered layer buffers between frames. Entries are keyed by layer id and reused while
   * the layer node is the same object (state is immutable), at the same scale and host media version.
   */
  cache?: LayerCache;
  /** Bump when host media finishes loading so cached layers that were missing pixels re-render. */
  hostVersion?: number;
}

export interface LayerCacheEntry {
  node: unknown;
  scale: number;
  hostVersion: number;
  canvas: CanvasLike;
}
export type LayerCache = Map<string, LayerCacheEntry>;

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
  const ctx = ctxOf(acc);
  if (drawsDirectly(env, p)) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, p.opacity));
    drawLayerContent(env, ctx, acc, layer, p);
    ctx.restore();
    return;
  }
  const buf = cachedLayerBuffer(env, layer, p);
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, p.opacity));
  ctx.globalCompositeOperation = (p.blendMode === 'normal' ? 'source-over' : p.blendMode) as GlobalCompositeOperation;
  ctx.drawImage(drawable(buf), 0, 0);
  ctx.restore();
}

/**
 * Whether a layer can be drawn straight onto the layers beneath it instead of into its own
 * full-size buffer first. That is only the same picture when nothing works on the layer as a
 * whole (blend modes, filters, masks) and its opacity can't change how its own marks overlap.
 */
function drawsDirectly(env: Env, p: LayerProps): boolean {
  if (p.blendMode !== 'normal' || p.mask?.enabled || (p.filters ?? []).some((f) => f.enabled)) return false;
  switch (p.layerType) {
    case 'fill':
      return true;
    case 'raster':
      // One drawImage, so opacity applies exactly. The editor keeps painted rasters in its cache.
      return !env.options.cache;
    case 'vector':
    case 'text':
      return p.opacity >= 1;
    default:
      return false;
  }
}

function cachedLayerBuffer(env: Env, layer: SceneNode<'layer'>, p: LayerProps): CanvasLike {
  const cache = env.options.cache;
  const cacheable = cache && p.layerType !== 'group' && !env.options.overrides?.has(layer.id);
  const hv = env.options.hostVersion ?? 0;
  if (cacheable) {
    const hit = cache.get(layer.id);
    if (hit && hit.node === layer && hit.scale === env.scale && hit.hostVersion === hv) return hit.canvas;
  }
  const buf = renderLayerBuffer(env, layer, p);
  if (cacheable) cache.set(layer.id, { node: layer, scale: env.scale, hostVersion: hv, canvas: buf });
  return buf;
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

/** Draw a layer's own content (no filters or mask) with an absolute transform onto `ctx`, the context of `target`. */
function drawLayerContent(env: Env, ctx: Ctx2D, target: CanvasLike, layer: SceneNode<'layer'>, p: LayerProps): void {
  const { host, W, H, scale } = env;
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
      compositeLayers(env, target, kids);
      break;
    }
    case 'adjustment':
      break;
  }
  ctx.restore();
}

/** Render one layer (content, smart filters, mask) into a full-size transparent buffer. */
export function renderLayerBuffer(env: Env, layer: SceneNode<'layer'>, p: LayerProps = layer.props, skipMask = false): CanvasLike {
  const { host, W, H, scale } = env;
  const buf = host.createCanvas(W, H);
  const ctx = ctxOf(buf);
  drawLayerContent(env, ctx, buf, layer, p);

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

  const m = skipMask ? null : layerMask(env, p);
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
  if (strokes.length) {
    // Selections are in canvas coordinates; map them into this layer's local space.
    const clipMask = (sel: Selection): CanvasLike | null => {
      const m = selectionMask(host, sel, env.docW, env.docH, 1);
      const docMask = maskToCanvas(host, m);
      const out = host.createCanvas(lw, lh);
      const c = ctxOf(out);
      c.save();
      if (p.scaleX !== 1 || p.scaleY !== 1) c.scale(1 / p.scaleX, 1 / p.scaleY);
      if (p.rotation) c.rotate((-p.rotation * Math.PI) / 180);
      c.translate(-p.x, -p.y);
      c.drawImage(drawable(docMask), 0, 0);
      c.restore();
      return out;
    };
    renderStrokes(host, local, strokes, clipMask);
  }
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

function envFor(host: RenderHost, state: ProjectState, layerId: string, scale: number): Env {
  const layer = requireNodeOfType(state, layerId, 'layer');
  let cur: SceneNode | undefined = layer;
  while (cur && cur.type !== 'canvas') cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  if (!cur) throw new Error('Layer is not inside a canvas');
  const cp = (cur as SceneNode<'canvas'>).props;
  return { host, state, W: Math.max(1, Math.round(cp.width * scale)), H: Math.max(1, Math.round(cp.height * scale)), scale, docW: cp.width, docH: cp.height, options: {} };
}

/**
 * Render one layer's own pixels (content and smart filters, optionally its mask) at full canvas size,
 * without its blend mode or opacity. Used for layered exports (PSD, SVG) and layer thumbnails.
 */
export function renderSingleLayer(host: RenderHost, state: ProjectState, layerId: string, options: { scale?: number; includeMask?: boolean } = {}): CanvasLike {
  const env = envFor(host, state, layerId, options.scale ?? 1);
  const layer = requireNodeOfType(state, layerId, 'layer');
  return renderLayerBuffer(env, layer, layer.props, options.includeMask === false);
}

/**
 * Whether a point (canvas coordinates) is on a layer's visible content: inside its bounds and,
 * for pixel and shape layers, over pixels that are not transparent. A brush layer is as big as
 * its canvas, so its bounds alone would catch every click.
 */
export function layerHitsPoint(host: RenderHost, state: ProjectState, layerId: string, x: number, y: number, tolerance = 3): boolean {
  const b = layerBounds(host, state, layerId);
  if (x < b.x - tolerance || y < b.y - tolerance || x > b.x + b.width + tolerance || y > b.y + b.height + tolerance) return false;
  const p = requireNodeOfType(state, layerId, 'layer').props;
  if (p.layerType !== 'raster' && p.layerType !== 'vector') return true;
  const env = envFor(host, state, layerId, 1);
  // A small rendering is enough to tell content from empty space.
  const scale = Math.min(1, 512 / Math.max(env.docW, env.docH));
  const c = renderSingleLayer(host, state, layerId, { scale });
  const r = Math.max(1, Math.ceil(tolerance * scale));
  const px = Math.round(x * scale);
  const py = Math.round(y * scale);
  const x0 = Math.max(0, px - r);
  const y0 = Math.max(0, py - r);
  const w = Math.min(c.width, px + r + 1) - x0;
  const h = Math.min(c.height, py + r + 1) - y0;
  if (w <= 0 || h <= 0) return false;
  const data = ctxOf(c).getImageData(x0, y0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) return true;
  return false;
}

/** The rasterized mask of a layer (null when it has none or it is disabled). */
export function renderLayerMask(host: RenderHost, state: ProjectState, layerId: string, scale = 1): Mask | null {
  const env = envFor(host, state, layerId, scale);
  return layerMask(env, requireNodeOfType(state, layerId, 'layer').props);
}
