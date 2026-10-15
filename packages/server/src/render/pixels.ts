import sharp from 'sharp';
import type { ProjectState, Selection } from '@omnix/core';
import type { Mask, Raster } from '@omnix/imaging';
import { renderCanvasDocument, renderSingleLayer, selectionMask, type CanvasLike } from '@omnix/render';
import type { Services } from '../services.js';
import type { ServerRenderHost } from './serverHost.js';

/**
 * Pixel access on the server, mirroring what the image editor does in the browser: rasters of a
 * whole canvas or a single layer (canvas-sized, canvas coordinates), selection masks, and
 * uploading results as assets.
 */

export function canvasToRaster(c: CanvasLike): Raster {
  const ctx = (c as unknown as { getContext(t: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } }).getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: new Uint8ClampedArray(img.data) };
}

export async function compositeRaster(host: ServerRenderHost, state: ProjectState, canvasId: string): Promise<Raster> {
  await host.prepare(state, canvasId);
  return canvasToRaster(renderCanvasDocument(host, state, canvasId, { scale: 1 }));
}

export async function layerRaster(host: ServerRenderHost, state: ProjectState, canvasId: string, layerId: string, includeMask = true): Promise<Raster> {
  await host.prepare(state, canvasId);
  return canvasToRaster(renderSingleLayer(host, state, layerId, { includeMask }));
}

export async function selectionToMask(host: ServerRenderHost, sel: Selection, width: number, height: number): Promise<Mask> {
  if (sel.kind === 'mask') await host.loadAsset(sel.assetId);
  return selectionMask(host, sel, width, height, 1);
}

export async function rasterPng(r: Raster | Mask, asMask = false): Promise<Buffer> {
  const channels = asMask ? 1 : 4;
  return sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.width, height: r.height, channels } }).png().toBuffer();
}

export async function decodeRaster(data: Buffer): Promise<Raster> {
  const { data: px, info } = await sharp(data, { failOn: 'none' }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength) };
}

/** Store a raster or mask as a PNG asset in the project and return its id. */
export async function uploadRaster(services: Services, r: Raster | Mask, name: string, projectId: string, ownerId: string, options: { asMask?: boolean; tags?: string[]; source?: 'generated' | 'import' } = {}): Promise<string> {
  const png = await rasterPng(r, options.asMask);
  const a = await services.assets.ingestBuffer(png, { name, ownerId, projectId, mimeHint: 'image/png', tags: options.tags ?? (options.asMask ? ['mask'] : []), source: { kind: options.source ?? 'generated', projectId } });
  return a.id;
}

/** Keep only the pixels inside a mask (alpha multiplied), e.g. a fill patch over its hole. */
export function clipToMask(r: Raster, m: Mask): Raster {
  const out = new Uint8ClampedArray(r.data);
  for (let p = 0; p < m.data.length; p++) out[p * 4 + 3] = Math.round((out[p * 4 + 3]! * m.data[p]!) / 255);
  return { width: r.width, height: r.height, data: out };
}

/** A layer's shape (its alpha) as a canvas-sized mask asset: used to aim an adjustment at one layer. */
export async function layerAlphaMaskAsset(services: Services, state: ProjectState, canvasId: string, layerId: string, projectId: string, ownerId: string, name = 'layer shape.png'): Promise<string> {
  const r = await layerRaster(services.renderHost(), state, canvasId, layerId, true);
  const m = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.width * r.height) };
  for (let p = 0; p < m.data.length; p++) m.data[p] = r.data[p * 4 + 3]!;
  return uploadRaster(services, m, name, projectId, ownerId, { asMask: true });
}

/** The canvas a layer belongs to. */
export function canvasIdOf(state: ProjectState, nodeId: string): string | null {
  let cur: ProjectState['nodes'][string] | undefined = state.nodes[nodeId];
  while (cur && cur.type !== 'canvas') cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  return cur?.id ?? null;
}
