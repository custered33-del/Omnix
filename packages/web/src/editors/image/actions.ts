import type { Adjustment, LayerProps, LayerType, Operation, ProjectState, SceneNode, Selection } from '@omnix/core';
import { childrenOf, layerProps, makeNode } from '@omnix/core';
import { combineMasks, invertMask, type Mask, type Raster } from '@omnix/imaging';
import { layerBounds, renderLayerMask } from '@omnix/render';
import type { AssetSummary } from '../../lib/api.js';
import type { BrowserRenderHost } from '../../render/browserHost.js';
import type { ProjectStore } from '../../state/project.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../i18n/index.js';
import type { ImageEditorStore } from './editorState.js';
import { clipToMask, compositeRaster, layerRaster, maskBoundsOf, rasterToCanvas, runImaging, selectionToMask, uploadRaster } from '../shared/pixels.js';

export interface ImageCtx {
  store: ProjectStore;
  host: BrowserRenderHost;
  ed: ImageEditorStore;
  canvasId: string;
}

export const ADJUSTMENT_DEFAULTS: Record<Adjustment['kind'], Adjustment> = {
  curves: { kind: 'curves', channel: 'rgb', points: [[0, 0], [64, 56], [192, 200], [255, 255]] },
  levels: { kind: 'levels', inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 },
  hueSaturation: { kind: 'hueSaturation', hue: 0, saturation: 0, lightness: 0 },
  colorBalance: { kind: 'colorBalance', shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] },
  brightnessContrast: { kind: 'brightnessContrast', brightness: 0, contrast: 0 },
  lut: { kind: 'lut', assetId: '', intensity: 1 },
  invert: { kind: 'invert' },
  temperature: { kind: 'temperature', amount: 0 },
};

function state(c: ImageCtx): ProjectState {
  return c.store.getState().state!;
}
function canvasProps(c: ImageCtx) {
  return (state(c).nodes[c.canvasId] as SceneNode<'canvas'>).props;
}
function selectedLayer(c: ImageCtx): SceneNode<'layer'> | undefined {
  const id = c.ed.getState().selectedLayerId;
  const n = id ? state(c).nodes[id] : undefined;
  return n?.type === 'layer' ? (n as SceneNode<'layer'>) : undefined;
}

/** Where a new layer goes: just above the selected layer (inside its group), else on top. */
export function insertionPoint(c: ImageCtx): { parentId: string; index: number } {
  const l = selectedLayer(c);
  const s = state(c);
  if (!l) return { parentId: c.canvasId, index: s.nodes[c.canvasId]!.children.length };
  if (l.props.layerType === 'group') return { parentId: l.id, index: l.children.length };
  const parentId = l.parentId!;
  return { parentId, index: s.nodes[parentId]!.children.indexOf(l.id) + 1 };
}

function addLayerNode(c: ImageCtx, props: Partial<LayerProps>, label: string, extraOps: Operation[] = []): string | null {
  const node = makeNode('layer', props);
  const { parentId, index } = insertionPoint(c);
  const op: Operation = { kind: 'create', parentId, index, nodes: [node] };
  const ok = c.store.getState().commit(extraOps.length ? { kind: 'batch', ops: [...extraOps, op] } : op, label);
  if (!ok) return null;
  c.ed.getState().set({ selectedLayerId: node.id });
  c.store.getState().select([node.id]);
  return node.id;
}

export function addLayer(c: ImageCtx, type: LayerType): string | null {
  const cp = canvasProps(c);
  const ed = c.ed.getState();
  const extra: Partial<LayerProps> =
    type === 'raster'
      ? { width: cp.width, height: cp.height }
      : type === 'text'
        ? { x: Math.round(cp.width * 0.1), y: Math.round(cp.height * 0.1), color: ed.color, fontFamily: ed.text.fontFamily, fontSize: ed.text.fontSize, fontWeight: ed.text.fontWeight }
        : type === 'fill'
          ? { fillColor: ed.color }
          : type === 'vector'
            ? { x: Math.round(cp.width * 0.25), y: Math.round(cp.height * 0.25), shapes: [{ id: `shp_${Date.now().toString(36)}`, kind: 'rect', x: 0, y: 0, width: Math.round(cp.width / 2), height: Math.round(cp.height / 2), fill: ed.shape.fill ?? ed.color, stroke: ed.shape.stroke, strokeWidth: ed.shape.strokeWidth }] }
            : {};
  return addLayerNode(c, layerProps(type, extra), `Add ${t(`image.layerTypes.${type}`).toLowerCase()}`);
}

export function addAdjustment(c: ImageCtx, kind: Adjustment['kind'], assetId?: string): string | null {
  const adjustment = kind === 'lut' ? { ...(ADJUSTMENT_DEFAULTS.lut as Extract<Adjustment, { kind: 'lut' }>), assetId: assetId ?? '' } : ADJUSTMENT_DEFAULTS[kind];
  const sel = canvasProps(c).selection;
  return addLayerNode(c, layerProps('adjustment', { name: t(`adjust.${kind}`), adjustment, ...(sel ? { mask: { source: sel, inverted: false, enabled: true } } : {}) }), `Add ${t(`adjust.${kind}`)} adjustment`);
}

/** Place an image asset as a new pixel layer, fitted inside the canvas and centred. */
export function placeImage(c: ImageCtx, asset: AssetSummary, at?: { x: number; y: number }): string | null {
  const cp = canvasProps(c);
  const w = asset.width ?? cp.width;
  const h = asset.height ?? cp.height;
  const fit = Math.min(1, cp.width / w, cp.height / h);
  const x = at ? at.x - (w * fit) / 2 : (cp.width - w * fit) / 2;
  const y = at ? at.y - (h * fit) / 2 : (cp.height - h * fit) / 2;
  return addLayerNode(c, layerProps('raster', { name: asset.name.replace(/\.[^.]+$/, ''), assetId: asset.id, width: w, height: h, x: Math.round(x), y: Math.round(y), scaleX: fit, scaleY: fit }), 'Place image');
}

export function deleteLayer(c: ImageCtx, id?: string): void {
  const l = id ? (state(c).nodes[id] as SceneNode<'layer'>) : selectedLayer(c);
  if (!l) return;
  const siblings = state(c).nodes[l.parentId!]!.children;
  const i = siblings.indexOf(l.id);
  if (c.store.getState().commit({ kind: 'delete', id: l.id }, `Delete ${l.props.name}`)) {
    const next = siblings[i - 1] ?? siblings[i + 1] ?? null;
    c.ed.getState().set({ selectedLayerId: next && next !== l.id ? next : null });
  }
}

/** Deep-copy a layer subtree with fresh ids. */
export function duplicateLayer(c: ImageCtx, id?: string): void {
  const l = id ? (state(c).nodes[id] as SceneNode<'layer'>) : selectedLayer(c);
  if (!l) return;
  const s = state(c);
  const nodes: SceneNode[] = [];
  const copy = (src: SceneNode, parentId: string | null): string => {
    const props = src.id === l.id ? { ...(src.props as LayerProps), name: `${(src.props as LayerProps).name} copy` } : src.props;
    const n = makeNode(src.type as 'layer', props as Partial<LayerProps>);
    n.parentId = parentId;
    nodes.push(n);
    n.children = src.children.map((k) => copy(s.nodes[k]!, n.id));
    return n.id;
  };
  const newId = copy(l, null);
  const siblings = s.nodes[l.parentId!]!.children;
  if (c.store.getState().commit({ kind: 'create', parentId: l.parentId!, index: siblings.indexOf(l.id) + 1, nodes }, `Duplicate ${l.props.name}`)) {
    c.ed.getState().set({ selectedLayerId: newId });
  }
}

export function groupSelected(c: ImageCtx): void {
  const l = selectedLayer(c);
  if (!l) return;
  const s = state(c);
  const group = makeNode('layer', layerProps('group', { name: 'Group' }));
  const siblings = s.nodes[l.parentId!]!.children;
  const ops: Operation[] = [
    { kind: 'create', parentId: l.parentId!, index: siblings.indexOf(l.id) + 1, nodes: [group] },
    { kind: 'move', id: l.id, parentId: group.id, index: 0 },
  ];
  if (c.store.getState().commit({ kind: 'batch', ops }, 'Group layer')) c.ed.getState().set({ selectedLayerId: group.id });
}

export function updateLayer(c: ImageCtx, id: string, set: Partial<LayerProps>, label: string): void {
  c.store.getState().commit({ kind: 'update', id, set: set as Record<string, unknown> }, label);
}

export function nudge(c: ImageCtx, dx: number, dy: number): void {
  const l = selectedLayer(c);
  if (!l || l.props.locked) return;
  updateLayer(c, l.id, { x: l.props.x + dx, y: l.props.y + dy }, 'Nudge layer');
}

/* ---------------- selection actions ---------------- */

export function setSelection(c: ImageCtx, sel: Selection | null): void {
  c.store.getState().commit({ kind: 'update', id: c.canvasId, set: { selection: sel } }, sel ? 'Select' : 'Deselect');
}

export function selectAll(c: ImageCtx): void {
  const cp = canvasProps(c);
  setSelection(c, { kind: 'rect', x: 0, y: 0, width: cp.width, height: cp.height });
}

export function deselect(c: ImageCtx): void {
  if (canvasProps(c).selection) setSelection(c, null);
}

function currentMask(c: ImageCtx): Mask | null {
  const cp = canvasProps(c);
  return cp.selection ? selectionToMask(c.host, cp.selection, cp.width, cp.height) : null;
}

async function busy<T>(c: ImageCtx, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  c.ed.getState().set({ busy: label });
  try {
    return await fn();
  } catch (e) {
    toast.error((e as Error).message);
    return undefined;
  } finally {
    c.ed.getState().set({ busy: null });
  }
}

export async function invertSelection(c: ImageCtx): Promise<void> {
  const m = currentMask(c);
  if (!m) return selectAll(c);
  await busy(c, t('image.working'), async () => {
    const id = await uploadRaster(c.host, invertMask(m), 'selection.png', c.store.getState().projectId, true);
    setSelection(c, { kind: 'mask', assetId: id });
  });
}

/** Fill the selection non-destructively: a fill layer masked to the selection. */
export function fillSelection(c: ImageCtx): void {
  const sel = canvasProps(c).selection;
  const color = c.ed.getState().color;
  addLayerNode(c, layerProps('fill', { name: `Fill ${color}`, fillColor: color, ...(sel ? { mask: { source: sel, inverted: false, enabled: true } } : {}) }), 'Fill selection');
}

/** Hide the selected pixels of the current layer by subtracting the selection from its mask. */
export async function clearSelectionPixels(c: ImageCtx): Promise<void> {
  const l = selectedLayer(c);
  const sel = canvasProps(c).selection;
  if (!l || !sel || l.props.locked) return;
  const cp = canvasProps(c);
  if (!l.props.mask) {
    updateLayer(c, l.id, { mask: { source: sel, inverted: true, enabled: true } }, 'Clear selected pixels');
    return;
  }
  await busy(c, t('image.working'), async () => {
    const existing = renderLayerMask(c.host, state(c), l.id) ?? { width: cp.width, height: cp.height, data: new Uint8ClampedArray(cp.width * cp.height).fill(255) };
    const m = combineMasks(existing, selectionToMask(c.host, sel, cp.width, cp.height), 'subtract');
    const id = await uploadRaster(c.host, m, 'mask.png', c.store.getState().projectId, true);
    updateLayer(c, l.id, { mask: { source: { kind: 'mask', assetId: id }, inverted: false, enabled: true } }, 'Clear selected pixels');
  });
}

export function maskFromSelection(c: ImageCtx): void {
  const l = selectedLayer(c);
  const sel = canvasProps(c).selection;
  if (!l || !sel) return;
  updateLayer(c, l.id, { mask: { source: sel, inverted: false, enabled: true } }, 'Add layer mask');
}

/**
 * Content-aware fill: synthesize the selected area from its surroundings into a new layer, so the
 * original pixels stay untouched underneath.
 */
export async function contentAwareFill(c: ImageCtx): Promise<void> {
  const m = currentMask(c);
  if (!m || !maskBoundsOf(m)) {
    toast.info('Select the area to fill first.');
    return;
  }
  await busy(c, t('image.working'), async () => {
    const src = compositeRaster(c.host, state(c), c.canvasId);
    const filled = await runImaging<Raster>('contentAwareFill', { raster: src, mask: m });
    const patch = clipToMask(filled, m);
    const id = await uploadRaster(c.host, patch, 'content-aware-fill.png', c.store.getState().projectId);
    const cp = canvasProps(c);
    addLayerNode(c, layerProps('raster', { name: t('image.contentAwareFill'), assetId: id, width: cp.width, height: cp.height }), t('image.contentAwareFill'));
  });
}

/** Remove the background of the selected pixel layer as an editable layer mask. */
export async function removeLayerBackground(c: ImageCtx): Promise<void> {
  const l = selectedLayer(c);
  if (!l || l.props.layerType !== 'raster') {
    toast.info('Select a pixel layer first.');
    return;
  }
  await busy(c, t('image.working'), async () => {
    const r = layerRaster(c.host, state(c), l.id);
    const cut = await runImaging<Raster>('removeBackground', { raster: r, method: 'auto' });
    const m = new Uint8ClampedArray(cut.width * cut.height);
    for (let p = 0; p < m.length; p++) m[p] = cut.data[p * 4 + 3]!;
    const id = await uploadRaster(c.host, { width: cut.width, height: cut.height, data: m }, 'mask.png', c.store.getState().projectId, true);
    updateLayer(c, l.id, { mask: { source: { kind: 'mask', assetId: id }, inverted: false, enabled: true } }, 'Remove background');
  });
}

/** Shift a selection by (dx, dy), re-rasterizing mask selections onto a new canvas size. */
async function shiftSelection(c: ImageCtx, sel: Selection, dx: number, dy: number, w: number, h: number): Promise<Selection> {
  if (sel.kind === 'rect' || sel.kind === 'ellipse') return { ...sel, x: sel.x + dx, y: sel.y + dy };
  if (sel.kind === 'polygon') return { ...sel, points: sel.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  const cp = canvasProps(c);
  const m = selectionToMask(c.host, sel, cp.width, cp.height);
  const src = rasterToCanvas(m, true);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, dx, dy);
  const d = ctx.getImageData(0, 0, w, h).data;
  const shifted = new Uint8ClampedArray(w * h);
  for (let p = 0; p < shifted.length; p++) shifted[p] = (d[p * 4]! * d[p * 4 + 3]!) / 255;
  const id = await uploadRaster(c.host, { width: w, height: h, data: shifted }, 'mask.png', c.store.getState().projectId, true);
  return { kind: 'mask', assetId: id };
}

/**
 * Resize the canvas. `anchor` is where existing content stays (0..1 on each axis): 0,0 keeps
 * the top-left corner, 0.5,0.5 centres it. Layers and masks move with the content.
 */
export async function resizeCanvas(c: ImageCtx, width: number, height: number, anchor: { x: number; y: number }, label = 'Resize canvas'): Promise<void> {
  const cp = canvasProps(c);
  const dx = Math.round((width - cp.width) * anchor.x);
  const dy = Math.round((height - cp.height) * anchor.y);
  await busy(c, t('image.working'), async () => {
    const ops: Operation[] = [{ kind: 'update', id: c.canvasId, set: { width, height, selection: null } }];
    const visit = async (parentId: string) => {
      for (const n of childrenOf(state(c), parentId)) {
        if (n.type !== 'layer') continue;
        const p = (n as SceneNode<'layer'>).props;
        const set: Partial<LayerProps> = {};
        if (!['fill', 'adjustment', 'group'].includes(p.layerType)) Object.assign(set, { x: p.x + dx, y: p.y + dy });
        if (p.mask) set.mask = { ...p.mask, source: await shiftSelection(c, p.mask.source, dx, dy, width, height) };
        if (Object.keys(set).length) ops.push({ kind: 'update', id: n.id, set: set as Record<string, unknown> });
        if (p.layerType === 'group') await visit(n.id);
      }
    };
    await visit(c.canvasId);
    c.store.getState().commit({ kind: 'batch', ops }, label);
  });
}

export async function cropToSelection(c: ImageCtx): Promise<void> {
  const m = currentMask(c);
  const b = m ? maskBoundsOf(m) : null;
  if (!b) return;
  const cp = canvasProps(c);
  // Cropping is resizing with the anchor chosen so the selection's corner lands at the origin.
  const ax = cp.width - b.width === 0 ? 0 : -b.x / (b.width - cp.width);
  const ay = cp.height - b.height === 0 ? 0 : -b.y / (b.height - cp.height);
  await resizeCanvas(c, b.width, b.height, { x: ax, y: ay }, 'Crop to selection');
}

/** Bounds of the selected layer (for alignment and status text). */
export function selectedBounds(c: ImageCtx) {
  const l = selectedLayer(c);
  return l ? layerBounds(c.host, state(c), l.id) : null;
}

/** Align the selected layer to the canvas. */
export function alignLayer(c: ImageCtx, how: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'): void {
  const l = selectedLayer(c);
  const b = selectedBounds(c);
  if (!l || !b || l.props.locked) return;
  const cp = canvasProps(c);
  const ox = l.props.x - b.x;
  const oy = l.props.y - b.y;
  const set: Partial<LayerProps> = {};
  if (how === 'left') set.x = ox;
  if (how === 'hcenter') set.x = Math.round((cp.width - b.width) / 2 + ox);
  if (how === 'right') set.x = Math.round(cp.width - b.width + ox);
  if (how === 'top') set.y = oy;
  if (how === 'vcenter') set.y = Math.round((cp.height - b.height) / 2 + oy);
  if (how === 'bottom') set.y = Math.round(cp.height - b.height + oy);
  updateLayer(c, l.id, set, 'Align layer');
}
