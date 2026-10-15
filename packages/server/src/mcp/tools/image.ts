import { z } from 'zod';
import sharp from 'sharp';
import { childrenOf, closest, layerProps, makeNode, newId, zAdjustment, zColor, zFilterKind, zSelection, zVectorShape, type LayerProps, type Operation, type ProjectState, type SceneNode, type Selection } from '@omnix/core';
import { contentAwareFill, createMask, crop, magicWand, maskBounds, objectSelect, removeBackground, type Raster } from '@omnix/imaging';
import { defineTool, ToolError, zProjectId, type ToolContext } from '../registry.js';
import { edit, need, writeResult, zWriteResult } from './helpers.js';
import { clipToMask, compositeRaster, layerRaster, selectionToMask, uploadRaster } from '../../render/pixels.js';

/**
 * Image editor tools: layers of every kind, adjustments, smart filters, selections, masks,
 * painting, content-aware fill, background removal and canvas size. Pixel work runs on the
 * server and lands as new layers or masks, so the original pixels always stay underneath.
 */

const BLEND = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const;

function insertAt(state: ProjectState, parentId: string, index: number | undefined): number {
  const n = state.nodes[parentId]!.children.length;
  return index === undefined ? n : Math.max(0, Math.min(n, index));
}

function canvasOf(state: ProjectState, layerId: string): SceneNode<'canvas'> {
  const c = closest(state, layerId, 'canvas');
  if (!c) throw new ToolError(`Layer ${layerId} is not inside a canvas.`);
  return c;
}

/** Bounding box of the pixels with any opacity, or null for an empty raster. */
function opaqueBounds(r: Raster): { x: number; y: number; width: number; height: number } | null {
  let x0 = r.width;
  let y0 = r.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++)
      if (r.data[(y * r.width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

async function pixelsWork<T>(ctx: ToolContext, projectId: string, fn: (state: ProjectState) => Promise<T>): Promise<T> {
  await ctx.requireProject(projectId, 'write');
  if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
  return fn(await ctx.state(projectId));
}

export const imageTools = [
  defineTool({
    name: 'image_add_layer',
    title: 'Add a layer',
    description:
      'Add a layer to a canvas: raster (an image asset), text, shape (vector shapes), fill (solid color) or group. New layers go on top unless you pass index (0 = bottom). Coordinates are canvas pixels from the top-left.',
    category: 'image',
    access: 'write',
    input: {
      projectId: zProjectId,
      canvasId: z.string().describe('Canvas id'),
      kind: z.enum(['raster', 'text', 'shape', 'fill', 'group']),
      name: z.string().max(200).optional(),
      parentId: z.string().optional().describe('A group layer to put it in (default: the canvas)'),
      index: z.number().int().min(0).optional(),
      assetId: z.string().optional().describe('raster: the image asset to place'),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional().describe('raster: displayed width (default: the image size)'),
      height: z.number().positive().optional(),
      text: z.string().max(20000).optional(),
      fontFamily: z.string().optional(),
      fontSize: z.number().positive().max(2000).optional(),
      fontWeight: z.number().min(100).max(900).optional(),
      color: zColor.optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      boxWidth: z.number().positive().optional().describe('text: wrap width in pixels'),
      shapes: z.array(zVectorShape).optional().describe('shape: vector shapes in canvas coordinates'),
      fillColor: zColor.optional(),
      opacity: z.number().min(0).max(1).optional(),
      blendMode: z.enum(BLEND).optional(),
    },
    output: zWriteResult.extend({ layerId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', kind: 'text', text: 'Spring sale', x: 120, y: 860, fontSize: 96, fontWeight: 800, color: '#ffffff' }, output: { status: 'proposed', proposalId: 'prop_2b...', layerId: 'lyr_7Q...' } },
    async handler(args, ctx) {
      let layerId = '';
      const out = await edit(ctx, args.projectId, `Add ${args.kind} layer${args.name ? ` "${args.name}"` : ''}`, async (state) => {
        const canvas = need(state, args.canvasId, 'canvas', 'canvas');
        const parentId = args.parentId ?? canvas.id;
        if (parentId !== canvas.id) {
          const g = need(state, parentId, 'layer', 'group layer');
          if (g.props.layerType !== 'group') throw new ToolError(`${parentId} is not a group layer.`);
        }
        const common: Partial<LayerProps> = {
          ...(args.name ? { name: args.name } : {}),
          ...(args.x !== undefined ? { x: args.x } : {}),
          ...(args.y !== undefined ? { y: args.y } : {}),
          ...(args.opacity !== undefined ? { opacity: args.opacity } : {}),
          ...(args.blendMode ? { blendMode: args.blendMode } : {}),
        };
        let props: Partial<LayerProps>;
        switch (args.kind) {
          case 'raster': {
            if (!args.assetId) throw new ToolError('A raster layer needs assetId (an image in the asset library).');
            const a = await ctx.services.assets.get(args.assetId);
            if (!a || a.kind !== 'image') throw new ToolError(`Asset ${args.assetId} is not an image.`);
            const w = args.width ?? a.width ?? canvas.props.width;
            const h = args.height ?? (args.width && a.width && a.height ? (args.width * a.height) / a.width : (a.height ?? canvas.props.height));
            props = layerProps('raster', { name: a.name.replace(/\.[^.]+$/, ''), ...common, assetId: a.id, width: Math.round(w), height: Math.round(h) });
            break;
          }
          case 'text':
            props = layerProps('text', { ...common, text: args.text ?? 'Text', ...(args.fontFamily ? { fontFamily: args.fontFamily } : {}), ...(args.fontSize ? { fontSize: args.fontSize } : {}), ...(args.fontWeight ? { fontWeight: args.fontWeight } : {}), ...(args.color ? { color: args.color } : {}), ...(args.align ? { align: args.align } : {}), ...(args.boxWidth ? { boxWidth: args.boxWidth } : {}) });
            if (!args.name) props.name = (args.text ?? 'Text').split('\n')[0]!.slice(0, 40) || 'Text';
            break;
          case 'shape':
            props = layerProps('vector', { name: 'Shape', ...common, shapes: (args.shapes ?? []).map((s) => ({ ...s, id: s.id || newId('shp') })) });
            break;
          case 'fill':
            props = layerProps('fill', { name: 'Fill', ...common, fillColor: args.fillColor ?? args.color ?? '#ffffff' });
            break;
          default:
            props = layerProps('group', { name: 'Group', ...common });
        }
        const node = makeNode('layer', props);
        layerId = node.id;
        return [{ kind: 'create', parentId, index: insertAt(state, parentId, args.index), nodes: [node] }];
      });
      return writeResult(out, { layerId });
    },
  }),

  defineTool({
    name: 'image_add_adjustment',
    title: 'Add an adjustment layer',
    description:
      'Add a non-destructive adjustment layer that changes everything below it: curves, levels, hueSaturation (hue -180..180, saturation and lightness -100..100), colorBalance, brightnessContrast (-100..100), temperature (amount -100 cool .. 100 warm), invert, or lut (a .cube asset). Put it inside a group to affect only that group.',
    category: 'image',
    access: 'write',
    input: { projectId: zProjectId, canvasId: z.string(), adjustment: zAdjustment, name: z.string().max(200).optional(), parentId: z.string().optional(), index: z.number().int().min(0).optional() },
    output: zWriteResult.extend({ layerId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', adjustment: { kind: 'temperature', amount: 30 }, name: 'Warmer' }, output: { status: 'committed', commitId: 'c_4d...', layerId: 'lyr_9a...' } },
    async handler(args, ctx) {
      let layerId = '';
      const out = await edit(ctx, args.projectId, `Add ${args.adjustment.kind} adjustment`, (state) => {
        const canvas = need(state, args.canvasId, 'canvas', 'canvas');
        const parentId = args.parentId ?? canvas.id;
        const node = makeNode('layer', layerProps('adjustment', { name: args.name ?? args.adjustment.kind, adjustment: args.adjustment }));
        layerId = node.id;
        return [{ kind: 'create', parentId, index: insertAt(state, parentId, args.index), nodes: [node] }];
      });
      return writeResult(out, { layerId });
    },
  }),

  defineTool({
    name: 'image_add_filter',
    title: 'Add a smart filter',
    description: 'Add a non-destructive filter to a layer (gaussianBlur {radius}, sharpen {amount}, noise {amount}, pixelate {size}, grayscale, sepia, vignette {amount}, emboss, edgeDetect). Filters stay editable and can be turned off.',
    category: 'image',
    access: 'write',
    input: { projectId: zProjectId, layerId: z.string(), filter: zFilterKind, params: z.record(z.string(), z.number()).default({}), opacity: z.number().min(0).max(1).default(1) },
    output: zWriteResult.extend({ filterId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', layerId: 'lyr_bg', filter: 'gaussianBlur', params: { radius: 12 } }, output: { status: 'proposed', proposalId: 'prop_5e...', filterId: 'flt_1...' } },
    async handler(args, ctx) {
      const filterId = newId('flt');
      const out = await edit(ctx, args.projectId, `Add ${args.filter} filter`, (state) => {
        need(state, args.layerId, 'layer', 'layer');
        return [{ kind: 'listInsert', id: args.layerId, prop: 'filters', items: [{ id: filterId, filter: args.filter, params: args.params, enabled: true, opacity: args.opacity }] }];
      });
      return writeResult(out, { filterId });
    },
  }),

  defineTool({
    name: 'image_set_selection',
    title: 'Select an area',
    description: 'Set the canvas selection to a rectangle, ellipse or polygon (canvas pixels), or clear it with null. Selections drive fills, masks and content-aware fill, and the user sees them.',
    category: 'image',
    access: 'write',
    input: { projectId: zProjectId, canvasId: z.string(), selection: zSelection.nullable() },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', selection: { kind: 'rect', x: 0, y: 0, width: 1080, height: 420 } }, output: { status: 'committed', commitId: 'c_6f...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, args.selection ? 'Select an area' : 'Deselect', (state) => {
        need(state, args.canvasId, 'canvas', 'canvas');
        return [{ kind: 'update', id: args.canvasId, set: { selection: args.selection } }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'image_select_smart',
    title: 'Select by color or object',
    description: 'Make a selection from the pixels: "color" selects similar colors starting at a point (magic wand), "object" finds the main object inside a box. The result becomes the canvas selection.',
    category: 'image',
    access: 'write',
    input: {
      projectId: zProjectId,
      canvasId: z.string(),
      method: z.enum(['color', 'object']),
      x: z.number().optional().describe('color: start point'),
      y: z.number().optional(),
      tolerance: z.number().min(0).max(255).optional(),
      contiguous: z.boolean().optional().describe('color: only connected pixels (default true)'),
      box: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional().describe('object: area around the object'),
    },
    output: zWriteResult.extend({ bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable() }),
    example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', method: 'color', x: 40, y: 30, tolerance: 40 }, output: { status: 'committed', commitId: 'c_8a...', bounds: { x: 0, y: 0, width: 1080, height: 410 } } },
    async handler(args, ctx) {
      return pixelsWork(ctx, args.projectId, async (state) => {
        const canvas = need(state, args.canvasId, 'canvas', 'canvas');
        const r = await compositeRaster(ctx.services.renderHost(), state, canvas.id);
        let mask;
        if (args.method === 'color') {
          if (args.x === undefined || args.y === undefined) throw new ToolError('Color selection needs x and y.');
          mask = magicWand(r, Math.round(args.x), Math.round(args.y), args.tolerance ?? 32, args.contiguous ?? true);
        } else {
          if (!args.box) throw new ToolError('Object selection needs a box around the object.');
          mask = objectSelect(r, args.box, args.tolerance ?? 48);
        }
        const bounds = maskBounds(mask);
        const id = await uploadRaster(ctx.services, mask, 'selection.png', args.projectId, ctx.principal.user.id, { asMask: true });
        const out = await ctx.apply(args.projectId, [{ kind: 'update', id: canvas.id, set: { selection: { kind: 'mask', assetId: id } satisfies Selection } }], args.method === 'color' ? 'Select by color' : 'Select object');
        return writeResult(out, { bounds }, bounds ? `Selected ${bounds.width}×${bounds.height} px at (${bounds.x}, ${bounds.y}).` : 'Nothing matched.');
      });
    },
  }),

  defineTool({
    name: 'image_mask_layer',
    title: 'Mask a layer',
    description: 'Give a layer a mask from the current selection (shows only the selected area; inverted hides it instead), or remove its mask with from: "none".',
    category: 'image',
    access: 'write',
    input: { projectId: zProjectId, layerId: z.string(), from: z.enum(['selection', 'none']), inverted: z.boolean().default(false) },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', layerId: 'lyr_photo', from: 'selection' }, output: { status: 'proposed', proposalId: 'prop_3c...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, args.from === 'none' ? 'Remove layer mask' : 'Add layer mask', (state) => {
        need(state, args.layerId, 'layer', 'layer');
        if (args.from === 'none') return [{ kind: 'update', id: args.layerId, set: { mask: null } }];
        const sel = canvasOf(state, args.layerId).props.selection;
        if (!sel) throw new ToolError('Select an area first (image_set_selection or image_select_smart).');
        return [{ kind: 'update', id: args.layerId, set: { mask: { source: sel, inverted: args.inverted, enabled: true } } }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'image_remove_background',
    title: 'Remove a layer\'s background',
    description: 'Find the subject of a pixel layer and hide its background with an editable layer mask (nothing is erased). Use method "chroma" with keyColor for green or blue screens.',
    category: 'image',
    access: 'write',
    input: { projectId: zProjectId, layerId: z.string(), method: z.enum(['auto', 'chroma']).default('auto'), keyColor: zColor.optional(), tolerance: z.number().min(0).max(1).optional() },
    output: zWriteResult.extend({ maskAssetId: z.string(), keptPercent: z.number() }),
    example: { input: { projectId: 'prj_8Kq2...', layerId: 'lyr_photo' }, output: { status: 'committed', commitId: 'c_2e...', maskAssetId: 'a1b2...', keptPercent: 38 } },
    async handler(args, ctx) {
      return pixelsWork(ctx, args.projectId, async (state) => {
        const layer = need(state, args.layerId, 'layer', 'layer');
        if (layer.props.layerType !== 'raster') throw new ToolError('Background removal works on pixel (raster) layers.');
        const canvas = canvasOf(state, layer.id);
        const r = await layerRaster(ctx.services.renderHost(), state, canvas.id, layer.id, false);
        // The layer raster is canvas-sized; work on the layer's visible pixels so the image's own
        // border (not the transparent canvas around it) defines the background.
        const box = opaqueBounds(r);
        if (!box) throw new ToolError('The layer has no visible pixels.');
        const part = crop(r, box.x, box.y, box.width, box.height);
        const { mask: partMask } = removeBackground(part, { method: args.method, ...(args.keyColor ? { keyColor: args.keyColor } : {}), ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}) });
        const mask = createMask(r.width, r.height);
        let kept = 0;
        let total = 0;
        for (let y = 0; y < box.height; y++)
          for (let x = 0; x < box.width; x++) {
            const v = partMask.data[y * box.width + x]!;
            const a = part.data[(y * box.width + x) * 4 + 3]!;
            mask.data[(box.y + y) * r.width + box.x + x] = v;
            kept += (v * a) / 255;
            total += a;
          }
        const id = await uploadRaster(ctx.services, mask, `${layer.props.name} mask.png`, args.projectId, ctx.principal.user.id, { asMask: true });
        const out = await ctx.apply(args.projectId, [{ kind: 'update', id: layer.id, set: { mask: { source: { kind: 'mask', assetId: id }, inverted: false, enabled: true } } }], 'Remove background');
        return writeResult(out, { maskAssetId: id, keptPercent: total ? Math.round((kept / total) * 100) : 0 });
      });
    },
  }),

  defineTool({
    name: 'image_content_aware_fill',
    title: 'Content-aware fill',
    description: 'Fill the selected area with texture taken from its surroundings (removes objects, blemishes or text). The result goes on a new layer above, so the original stays intact.',
    category: 'image',
    access: 'write',
    input: { projectId: zProjectId, canvasId: z.string(), selection: zSelection.optional().describe('Area to fill (default: the current selection)') },
    output: zWriteResult.extend({ layerId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', selection: { kind: 'ellipse', x: 600, y: 300, width: 120, height: 90 } }, output: { status: 'proposed', proposalId: 'prop_8d...', layerId: 'lyr_fill...' } },
    async handler(args, ctx) {
      return pixelsWork(ctx, args.projectId, async (state) => {
        const canvas = need(state, args.canvasId, 'canvas', 'canvas');
        const sel = args.selection ?? canvas.props.selection;
        if (!sel) throw new ToolError('Select the area to fill first, or pass selection.');
        const host = ctx.services.renderHost();
        const r = await compositeRaster(host, state, canvas.id);
        const m = await selectionToMask(host, sel, canvas.props.width, canvas.props.height);
        if (!maskBounds(m)) throw new ToolError('The selection is empty.');
        const filled = contentAwareFill(r, m);
        const id = await uploadRaster(ctx.services, clipToMask(filled, m), 'content-aware-fill.png', args.projectId, ctx.principal.user.id);
        const node = makeNode('layer', layerProps('raster', { name: 'Content-aware fill', assetId: id, width: canvas.props.width, height: canvas.props.height }));
        const out = await ctx.apply(args.projectId, [{ kind: 'create', parentId: canvas.id, nodes: [node] }], 'Content-aware fill');
        return writeResult(out, { layerId: node.id });
      });
    },
  }),

  defineTool({
    name: 'image_paint',
    title: 'Paint strokes',
    description: 'Paint brush (or eraser) strokes onto a pixel layer. Points are canvas pixels; pressure 0..1 thins the stroke. Strokes stay editable data on the layer.',
    category: 'image',
    access: 'write',
    input: {
      projectId: zProjectId,
      layerId: z.string(),
      strokes: z
        .array(
          z.object({
            points: z.array(z.object({ x: z.number(), y: z.number(), pressure: z.number().min(0).max(1).default(1) })).min(1).max(5000),
            color: zColor.default('#000000'),
            size: z.number().positive().max(2000).default(12),
            hardness: z.number().min(0).max(1).default(0.8),
            opacity: z.number().min(0).max(1).default(1),
            tool: z.enum(['brush', 'eraser']).default('brush'),
          }),
        )
        .min(1)
        .max(200),
    },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', layerId: 'lyr_paint', strokes: [{ points: [{ x: 100, y: 100 }, { x: 300, y: 140 }], color: '#e8590c', size: 24 }] }, output: { status: 'committed', commitId: 'c_1f...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, `Paint ${args.strokes.length} stroke${args.strokes.length === 1 ? '' : 's'}`, (state) => {
        const l = need(state, args.layerId, 'layer', 'layer');
        if (l.props.layerType !== 'raster') throw new ToolError('Paint on a pixel (raster) layer; add one with image_add_layer kind "raster" or use a new empty layer.');
        return [{ kind: 'listInsert', id: l.id, prop: 'strokes', items: args.strokes.map((s) => ({ id: newId('stk'), tool: s.tool, color: s.color, size: s.size, hardness: s.hardness, opacity: s.opacity, tip: 'round', spacing: 0.15, points: s.points })) }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'image_resize_canvas',
    title: 'Resize or crop the canvas',
    description: 'Change the canvas size. anchor says where existing content stays (0,0 top-left; 0.5,0.5 centre); offsetX/offsetY instead move content by exact pixels (negative values crop from the top-left). Layers move with the content.',
    category: 'image',
    access: 'write',
    input: { projectId: zProjectId, canvasId: z.string(), width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384), anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(), offsetX: z.number().optional(), offsetY: z.number().optional() },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', canvasId: 'cnv_1', width: 1080, height: 1350, anchor: { x: 0.5, y: 0.5 } }, output: { status: 'proposed', proposalId: 'prop_6a...' } },
    async handler(args, ctx) {
      return pixelsWork(ctx, args.projectId, async (state) => {
        const canvas = need(state, args.canvasId, 'canvas', 'canvas');
        const cp = canvas.props;
        const ax = args.anchor?.x ?? 0.5;
        const ay = args.anchor?.y ?? 0.5;
        const dx = Math.round(args.offsetX ?? (args.width - cp.width) * ax);
        const dy = Math.round(args.offsetY ?? (args.height - cp.height) * ay);
        const ops = await canvasResizeOps(ctx.services, state, canvas.id, args.width, args.height, dx, dy, args.projectId, ctx.principal.user.id);
        const out = await ctx.apply(args.projectId, ops, `Resize canvas to ${args.width}×${args.height}`);
        return writeResult(out);
      });
    },
  }),
];

/**
 * Operations that resize a canvas and move every layer (and its mask) by (dx, dy), so content keeps its
 * place relative to the anchor. Shared by the resize tool and generative extend.
 */
export async function canvasResizeOps(services: ToolContext['services'], state: ProjectState, canvasId: string, width: number, height: number, dx: number, dy: number, projectId: string, ownerId: string): Promise<Operation[]> {
  const canvas = state.nodes[canvasId] as SceneNode<'canvas'>;
  const cp = canvas.props;
  const ops: Operation[] = [{ kind: 'update', id: canvas.id, set: { width, height, selection: null } }];
  const shiftMask = async (sel: Selection): Promise<Selection> => {
    if (sel.kind === 'rect' || sel.kind === 'ellipse') return { ...sel, x: sel.x + dx, y: sel.y + dy };
    if (sel.kind === 'polygon') return { ...sel, points: sel.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    const m = await selectionToMask(services.renderHost(), sel, cp.width, cp.height);
    const moved = await sharp(Buffer.from(m.data), { raw: { width: m.width, height: m.height, channels: 1 } })
      .extend({ top: Math.max(0, dy), left: Math.max(0, dx), bottom: Math.max(0, height - m.height - dy), right: Math.max(0, width - m.width - dx), background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .extract({ left: Math.max(0, -dx), top: Math.max(0, -dy), width, height })
      .raw()
      .toBuffer();
    const id = await uploadRaster(services, { width, height, data: new Uint8ClampedArray(moved) }, 'mask.png', projectId, ownerId, { asMask: true });
    return { kind: 'mask', assetId: id };
  };
  const visit = async (parentId: string) => {
    for (const n of childrenOf(state, parentId)) {
      if (n.type !== 'layer') continue;
      const p = (n as SceneNode<'layer'>).props;
      const set: Record<string, unknown> = {};
      if (!['fill', 'adjustment', 'group'].includes(p.layerType)) Object.assign(set, { x: p.x + dx, y: p.y + dy });
      if (p.mask) set.mask = { ...p.mask, source: await shiftMask(p.mask.source) };
      if (Object.keys(set).length) ops.push({ kind: 'update', id: n.id, set });
      if (p.layerType === 'group') await visit(n.id);
    }
  };
  await visit(canvas.id);
  return ops;
}
