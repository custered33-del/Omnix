import { writePsdBuffer, readPsd, initializeCanvas, type Layer as PsdLayer, type Psd, type BlendMode as PsdBlendMode, type AdjustmentLayer } from 'ag-psd';
import type { Adjustment, BlendMode, LayerProps, ProjectState, SceneNode } from '@omnix/core';
import { childrenOf, requireNodeOfType } from '@omnix/core';
import { renderCanvasDocument, renderLayerMask, renderSingleLayer, readRaster, type RenderHost } from '@omnix/render';
import type { Raster } from '@omnix/imaging';

const BLEND_TO_PSD: Record<BlendMode, PsdBlendMode> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color dodge',
  'color-burn': 'color burn',
  'hard-light': 'hard light',
  'soft-light': 'soft light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

const PSD_TO_BLEND: Partial<Record<PsdBlendMode, BlendMode>> = Object.fromEntries(Object.entries(BLEND_TO_PSD).map(([k, v]) => [v, k as BlendMode]));

/** Map an Omnix adjustment to a native Photoshop adjustment layer when one exists. */
export function toPsdAdjustment(a: Adjustment): AdjustmentLayer | null {
  switch (a.kind) {
    case 'invert':
      return { type: 'invert' };
    case 'brightnessContrast':
      return { type: 'brightness/contrast', brightness: Math.round(a.brightness * 1.5), contrast: Math.round(a.contrast), useLegacy: false };
    case 'levels':
      return { type: 'levels', rgb: { shadowInput: a.inBlack, highlightInput: a.inWhite, shadowOutput: a.outBlack, highlightOutput: a.outWhite, midtoneInput: a.gamma } };
    case 'curves': {
      const pts = a.points.map(([input, output]) => ({ input: Math.round(input), output: Math.round(output) }));
      const key = a.channel === 'rgb' ? 'rgb' : a.channel === 'r' ? 'red' : a.channel === 'g' ? 'green' : 'blue';
      return { type: 'curves', [key]: pts };
    }
    case 'hueSaturation':
      return { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: Math.round(a.hue), saturation: Math.round(a.saturation), lightness: Math.round(a.lightness) } };
    case 'colorBalance': {
      const v = (t: readonly [number, number, number]) => ({ cyanRed: Math.round(t[0]), magentaGreen: Math.round(t[1]), yellowBlue: Math.round(t[2]) });
      return { type: 'color balance', shadows: v(a.shadows), midtones: v(a.midtones), highlights: v(a.highlights), preserveLuminosity: true };
    }
    default:
      return null;
  }
}

function pixelData(r: Raster) {
  return { width: r.width, height: r.height, data: r.data };
}

/** Crop a full-canvas raster to its non-transparent bounds (smaller PSDs, like Photoshop does). */
function trimmed(r: Raster): { left: number; top: number; raster: Raster } | null {
  let minX = r.width;
  let minY = r.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++)
      if (r.data[(y * r.width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(r.data.subarray(((minY + y) * r.width + minX) * 4, ((minY + y) * r.width + minX + w) * 4), y * w * 4);
  return { left: minX, top: minY, raster: { width: w, height: h, data: out } };
}

export interface PsdExportReport {
  data: Buffer;
  /** Layers that could not be represented natively and were flattened or approximated. */
  notes: string[];
}

/**
 * Export a canvas as a layered PSD: raster/vector/fill layers become pixel layers, groups become
 * folders, text layers keep their text (editable in Photoshop), blend modes, opacity, visibility
 * and masks are preserved, and supported adjustment layers stay live. The flattened composite is
 * included so any PSD reader can show the image.
 */
export function exportPsd(host: RenderHost, state: ProjectState, canvasId: string): PsdExportReport {
  useCanvasFactory((w, h) => host.createCanvas(w, h));
  const canvas = requireNodeOfType(state, canvasId, 'canvas');
  const notes: string[] = [];
  const convert = (layer: SceneNode<'layer'>): PsdLayer => {
    const p: LayerProps = layer.props;
    const base: PsdLayer = { name: p.name, opacity: p.opacity, hidden: !p.visible, blendMode: BLEND_TO_PSD[p.blendMode] ?? 'normal' };
    if (p.layerType === 'group') {
      base.children = childrenOf(state, layer.id)
        .filter((c): c is SceneNode<'layer'> => c.type === 'layer')
        .map(convert);
      base.opened = true;
      if (p.filters.some((f) => f.enabled)) notes.push(`Group "${p.name}": smart filters on groups are not exported.`);
      return base;
    }
    if (p.layerType === 'adjustment' && p.adjustment) {
      const adj = toPsdAdjustment(p.adjustment);
      if (adj) {
        base.adjustment = adj;
      } else {
        notes.push(`"${p.name}": ${p.adjustment.kind} adjustments have no Photoshop equivalent; the layer is kept hidden and the effect is in the flattened image.`);
        base.hidden = true;
        base.name = `${p.name} (Omnix ${p.adjustment.kind})`;
      }
    } else {
      const raster = readRaster(renderSingleLayer(host, state, layer.id, { includeMask: false }));
      const t = trimmed(raster);
      if (t) {
        base.left = t.left;
        base.top = t.top;
        base.right = t.left + t.raster.width;
        base.bottom = t.top + t.raster.height;
        base.imageData = pixelData(t.raster);
      }
      if (p.filters.some((f) => f.enabled)) notes.push(`"${p.name}": smart filters are applied to the layer pixels (not editable in Photoshop).`);
      if (p.layerType === 'text' && p.text) {
        base.text = {
          text: p.text,
          transform: [p.scaleX, 0, 0, p.scaleY, p.x, p.y + (p.fontSize ?? 48)],
          style: {
            font: { name: (p.fontFamily ?? 'Inter').replace(/\s+/g, '') },
            fontSize: p.fontSize ?? 48,
            fillColor: hexToRgb(p.color ?? '#000000'),
            tracking: Math.round((p.letterSpacing ?? 0) * 10),
          },
          paragraphStyle: { justification: p.align === 'center' ? 'center' : p.align === 'right' ? 'right' : 'left' },
        };
      }
    }
    const m = renderLayerMask(host, state, layer.id);
    if (m && p.mask) {
      // PSD masks are grayscale images (white = visible) covering the canvas.
      const full = new Uint8ClampedArray(m.width * m.height * 4);
      for (let i = 0; i < m.data.length; i++) {
        full[i * 4] = full[i * 4 + 1] = full[i * 4 + 2] = m.data[i]!;
        full[i * 4 + 3] = 255;
      }
      base.mask = { left: 0, top: 0, right: m.width, bottom: m.height, defaultColor: 255, disabled: !p.mask.enabled, imageData: { width: m.width, height: m.height, data: full } };
    }
    return base;
  };
  const layers = childrenOf(state, canvasId)
    .filter((c): c is SceneNode<'layer'> => c.type === 'layer')
    .map(convert);
  const composite = readRaster(renderCanvasDocument(host, state, canvasId));
  const psd: Psd = { width: canvas.props.width, height: canvas.props.height, channels: 4, bitsPerChannel: 8, colorMode: 3, children: layers, imageData: pixelData(composite) };
  const data = writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false, invalidateTextLayers: false });
  return { data, notes };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** A layer read from a PSD, ready to become an Omnix layer (pixels are uploaded as assets by the caller). */
export interface ImportedPsdLayer {
  name: string;
  hidden: boolean;
  opacity: number;
  blendMode: BlendMode;
  left: number;
  top: number;
  pixels: Raster | null;
  text: string | null;
  children: ImportedPsdLayer[] | null;
  mask: Raster | null;
}

export interface ImportedPsd {
  width: number;
  height: number;
  layers: ImportedPsdLayer[];
  composite: Raster | null;
}

/** ag-psd needs a canvas factory for some layer types (text previews, effects). */
export function useCanvasFactory(create: (w: number, h: number) => unknown): void {
  initializeCanvas((w, h) => create(w, h) as HTMLCanvasElement);
}

/** Read a PSD into a neutral layer tree (pixels kept as rasters; groups preserved). */
export function importPsd(buffer: Buffer | ArrayBuffer, createCanvas?: (w: number, h: number) => unknown): ImportedPsd {
  if (createCanvas) useCanvasFactory(createCanvas);
  const psd = readPsd(buffer as ArrayBuffer, { useImageData: true, skipThumbnail: true, skipCompositeImageData: false });
  const toRaster = (d: { width: number; height: number; data: ArrayLike<number> } | undefined): Raster | null =>
    d && d.width > 0 && d.height > 0 ? { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data as ArrayLike<number>) } : null;
  const convert = (l: PsdLayer): ImportedPsdLayer => ({
    name: l.name ?? 'Layer',
    hidden: !!l.hidden,
    opacity: l.opacity ?? 1,
    blendMode: (l.blendMode && PSD_TO_BLEND[l.blendMode]) ?? 'normal',
    left: l.left ?? 0,
    top: l.top ?? 0,
    pixels: toRaster(l.imageData as never),
    text: l.text?.text ?? null,
    children: l.children ? l.children.map(convert) : null,
    mask: toRaster(l.mask?.imageData as never),
  });
  return { width: psd.width, height: psd.height, layers: (psd.children ?? []).map(convert), composite: toRaster(psd.imageData as never) };
}
