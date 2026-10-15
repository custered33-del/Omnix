import sharp from 'sharp';
import { layerProps, makeNode, type GenerationInfo, type Operation, type ProjectState, type SceneNode, type Selection } from '@omnix/core';
import { blurMask, contentAwareFill, createMask, createRaster, crop, maskBounds, type Mask, type Raster } from '@omnix/imaging';
import type { Services } from '../services.js';
import { clipToMask, compositeRaster, decodeRaster, rasterPng, selectionToMask, uploadRaster } from '../render/pixels.js';
import { canvasResizeOps } from '../mcp/tools/image.js';
import { colorFrom } from './nl/vocab.js';

/**
 * Generative fill and extend (feature 46), behind a provider interface (the "AI layer"):
 *  - builtin: always available. Synthesizes the area from its surroundings (patch-based
 *    content-aware fill); a color named in the prompt tints the result. It cannot invent new objects.
 *  - http: any image model speaking the OpenAI images edit API (OMNIX_IMAGE_GEN_URL...). Only the area
 *    around the mask is sent, and only what lands inside the mask is kept.
 * Results land as a new layer whose mask is the generated area, so the person sees exactly what changed.
 */

export interface ImageGenProvider {
  id: string;
  label: string;
  /** Can it create new content from the prompt (true), or only continue the surroundings (false)? */
  generative: boolean;
  /** Fill the masked area (255 = generate). Returns a full-size raster. */
  inpaint(input: { image: Raster; mask: Mask; prompt: string; signal?: AbortSignal }): Promise<Raster>;
}

/** Tint the masked area toward a color named in the prompt ("a blue sky", "#ffcc00 wall"). */
export function promptTint(r: Raster, mask: Mask, prompt: string, amount = 0.35): Raster {
  const words = prompt.toLowerCase().match(/#[0-9a-f]{3,8}|[a-z-]+(?:\s+[a-z-]+)?/g) ?? [];
  let color: string | null = null;
  for (const w of words) {
    color = colorFrom(w) ?? colorFrom(w.split(/\s+/).pop() ?? '');
    if (color) break;
  }
  if (!color) return r;
  const c = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
  const out = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
  for (let p = 0; p < mask.data.length; p++) {
    const k = (mask.data[p]! / 255) * amount;
    if (!k) continue;
    for (let ch = 0; ch < 3; ch++) out.data[p * 4 + ch] = out.data[p * 4 + ch]! + (c[ch]! - out.data[p * 4 + ch]!) * k;
  }
  return out;
}

export const builtinImageProvider: ImageGenProvider = {
  id: 'builtin',
  label: 'Built-in (fills from the surroundings)',
  generative: false,
  async inpaint({ image, mask, prompt }) {
    const filled = contentAwareFill(image, mask);
    return prompt.trim() ? promptTint(filled, mask, prompt) : filled;
  },
};

export function httpImageProvider(cfg: { url: string; apiKey: string | null; model: string | null }): ImageGenProvider {
  return {
    id: 'http',
    label: cfg.model ? `Image model (${cfg.model})` : 'Image model',
    generative: true,
    async inpaint({ image, mask, prompt, signal }) {
      const b = maskBounds(mask, 1);
      if (!b) return image;
      // Send the area around the mask (with context), squared up for the model.
      const pad = Math.max(64, Math.round(Math.max(b.width, b.height) * 0.5));
      const x0 = Math.max(0, b.x - pad);
      const y0 = Math.max(0, b.y - pad);
      const x1 = Math.min(image.width, b.x + b.width + pad);
      const y1 = Math.min(image.height, b.y + b.height + pad);
      const side = Math.max(x1 - x0, y1 - y0);
      const region = crop(image, x0, y0, x1 - x0, y1 - y0);
      const regionMask = cropMask(mask, x0, y0, x1 - x0, y1 - y0);
      const size = 1024;
      const square = await sharp(await rasterPng(region)).extend({ right: side - region.width, bottom: side - region.height, extendWith: 'mirror' }).resize(size, size).png().toBuffer();
      // OpenAI-style masks: transparent pixels are the area to edit.
      const maskRgba = createRaster(regionMask.width, regionMask.height);
      for (let p = 0; p < regionMask.data.length; p++) maskRgba.data[p * 4 + 3] = 255 - regionMask.data[p]!;
      const maskPng = await sharp(await rasterPng(maskRgba)).extend({ right: side - region.width, bottom: side - region.height, background: { r: 0, g: 0, b: 0, alpha: 1 } }).resize(size, size).png().toBuffer();
      const form = new FormData();
      if (cfg.model) form.append('model', cfg.model);
      form.append('prompt', prompt.trim() || 'Fill the area so it blends naturally with its surroundings.');
      form.append('image', new Blob([new Uint8Array(square)], { type: 'image/png' }), 'image.png');
      form.append('mask', new Blob([new Uint8Array(maskPng)], { type: 'image/png' }), 'mask.png');
      form.append('size', `${size}x${size}`);
      form.append('n', '1');
      if (!cfg.model || /dall-e/i.test(cfg.model)) form.append('response_format', 'b64_json');
      const res = await fetch(`${cfg.url}/images/edits`, { method: 'POST', headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, body: form, ...(signal ? { signal } : {}) });
      if (!res.ok) throw new Error(`The image model returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const body = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const first = body.data?.[0];
      const bytes = first?.b64_json ? Buffer.from(first.b64_json, 'base64') : first?.url ? Buffer.from(await (await fetch(first.url)).arrayBuffer()) : null;
      if (!bytes) throw new Error('The image model returned no image.');
      const back = await decodeRaster(await sharp(bytes).resize(side, side).extract({ left: 0, top: 0, width: region.width, height: region.height }).png().toBuffer());
      const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
      for (let y = 0; y < region.height; y++)
        for (let x = 0; x < region.width; x++) {
          const m = regionMask.data[y * region.width + x]! / 255;
          if (!m) continue;
          const di = ((y0 + y) * image.width + x0 + x) * 4;
          const si = (y * region.width + x) * 4;
          for (let ch = 0; ch < 4; ch++) out.data[di + ch] = out.data[di + ch]! + (back.data[si + ch]! - out.data[di + ch]!) * m;
        }
      return out;
    },
  };
}

function cropMask(m: Mask, x: number, y: number, w: number, h: number): Mask {
  const out = createMask(w, h);
  for (let j = 0; j < h; j++) out.data.set(m.data.subarray((y + j) * m.width + x, (y + j) * m.width + x + w), j * w);
  return out;
}

export function imageProviders(services: Services): ImageGenProvider[] {
  const list: ImageGenProvider[] = [];
  if (services.config.imageGen) list.push(httpImageProvider(services.config.imageGen));
  list.push(builtinImageProvider);
  return list;
}

export function imageProvider(services: Services, id?: string | null): ImageGenProvider {
  const list = imageProviders(services);
  if (id) {
    const p = list.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown image provider "${id}". Available: ${list.map((x) => x.id).join(', ')}.`);
    return p;
  }
  return list[0]!;
}

function generation(kind: GenerationInfo['kind'], prompt: string, provider: ImageGenProvider, maskAssetId: string | null): GenerationInfo {
  return { kind, prompt: prompt.slice(0, 2000), provider: provider.id, maskAssetId, createdAt: new Date().toISOString() };
}

/** Generative fill of a canvas area: a new layer with the result, masked to the area. */
export async function generativeFillOps(
  services: Services,
  state: ProjectState,
  canvasId: string,
  selection: Selection,
  prompt: string,
  opts: { providerId?: string | null; projectId: string; ownerId: string; signal?: AbortSignal },
): Promise<{ ops: Operation[]; layerId: string; provider: string; maskAssetId: string }> {
  const canvas = state.nodes[canvasId] as SceneNode<'canvas'>;
  const { width: W, height: H } = canvas.props;
  const host = services.renderHost();
  const image = await compositeRaster(host, state, canvasId);
  const hard = await selectionToMask(host, selection, W, H);
  const b = maskBounds(hard, 1);
  if (!b) throw new Error('The selection is empty.');
  // A slightly soft edge blends the new pixels into the old ones.
  const mask = blurMask(hard, 1.5);
  const provider = imageProvider(services, opts.providerId);
  const out = await provider.inpaint({ image, mask, prompt, ...(opts.signal ? { signal: opts.signal } : {}) });
  const x0 = Math.max(0, b.x - 2);
  const y0 = Math.max(0, b.y - 2);
  const w = Math.min(W, b.x + b.width + 2) - x0;
  const h = Math.min(H, b.y + b.height + 2) - y0;
  const patch = crop(clipToMask(out, mask), x0, y0, w, h);
  const name = prompt.trim() ? `Generative fill: ${prompt.trim().slice(0, 60)}` : 'Generative fill';
  const patchId = await uploadRaster(services, patch, `${name}.png`, opts.projectId, opts.ownerId, { tags: ['generated'] });
  const maskAssetId = await uploadRaster(services, hard, 'generated area.png', opts.projectId, opts.ownerId, { asMask: true, tags: ['mask', 'generated'] });
  const layer = makeNode('layer', layerProps('raster', { name, assetId: patchId, x: x0, y: y0, width: w, height: h, mask: { source: { kind: 'mask', assetId: maskAssetId }, inverted: false, enabled: true }, generation: generation('fill', prompt, provider, maskAssetId) }));
  return { ops: [{ kind: 'create', parentId: canvas.id, index: canvas.children.length, nodes: [layer] }], layerId: layer.id, provider: provider.id, maskAssetId };
}

/** Generative extend: grow the canvas and fill the new margins from the image (outpainting). */
export async function generativeExtendOps(
  services: Services,
  state: ProjectState,
  canvasId: string,
  pad: { top: number; right: number; bottom: number; left: number },
  prompt: string,
  opts: { providerId?: string | null; projectId: string; ownerId: string; signal?: AbortSignal },
): Promise<{ ops: Operation[]; layerId: string; provider: string; maskAssetId: string; width: number; height: number }> {
  const canvas = state.nodes[canvasId] as SceneNode<'canvas'>;
  const { width: W, height: H } = canvas.props;
  const NW = W + pad.left + pad.right;
  const NH = H + pad.top + pad.bottom;
  if (NW === W && NH === H) throw new Error('Give at least one side to extend.');
  if (NW > 8192 || NH > 8192) throw new Error('The extended canvas would be larger than 8192 px.');
  const host = services.renderHost();
  const image = await compositeRaster(host, state, canvasId);
  const big = createRaster(NW, NH);
  const hard = createMask(NW, NH, 255);
  for (let y = 0; y < H; y++) {
    big.data.set(image.data.subarray(y * W * 4, (y + 1) * W * 4), ((y + pad.top) * NW + pad.left) * 4);
    hard.data.fill(0, (y + pad.top) * NW + pad.left, (y + pad.top) * NW + pad.left + W);
  }
  const provider = imageProvider(services, opts.providerId);
  const out = await provider.inpaint({ image: big, mask: hard, prompt, ...(opts.signal ? { signal: opts.signal } : {}) });
  const mask = blurMask(hard, 1);
  const name = prompt.trim() ? `Generative extend: ${prompt.trim().slice(0, 60)}` : 'Generative extend';
  const patchId = await uploadRaster(services, clipToMask(out, mask), `${name}.png`, opts.projectId, opts.ownerId, { tags: ['generated'] });
  const maskAssetId = await uploadRaster(services, hard, 'extended area.png', opts.projectId, opts.ownerId, { asMask: true, tags: ['mask', 'generated'] });
  const ops = await canvasResizeOps(services, state, canvasId, NW, NH, pad.left, pad.top, opts.projectId, opts.ownerId);
  const layer = makeNode('layer', layerProps('raster', { name, assetId: patchId, x: 0, y: 0, width: NW, height: NH, mask: { source: { kind: 'mask', assetId: maskAssetId }, inverted: false, enabled: true }, generation: generation('extend', prompt, provider, maskAssetId) }));
  // Just above a background fill, below everything else, so existing content stays on top.
  const bottom = canvas.children[0] ? (state.nodes[canvas.children[0]] as SceneNode<'layer'>) : null;
  const index = bottom?.props.layerType === 'fill' ? 1 : 0;
  ops.push({ kind: 'create', parentId: canvas.id, index, nodes: [layer] });
  return { ops, layerId: layer.id, provider: provider.id, maskAssetId, width: NW, height: NH };
}
