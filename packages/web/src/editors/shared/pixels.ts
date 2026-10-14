import type { ProjectState, Selection } from '@omnix/core';
import { renderCanvasDocument, renderSingleLayer, selectionMask, type CanvasLike } from '@omnix/render';
import type { Mask, Raster } from '@omnix/imaging';
import type { BrowserRenderHost } from '../../render/browserHost.js';
import { uploadFile } from '../../lib/api.js';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./imaging.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
  }
  return worker;
}

/** Run an imaging operation in the worker. Input buffers are copied, outputs transferred back. */
export function runImaging<T = Raster>(op: string, args: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, op, args });
  });
}

export function canvasToRaster(c: CanvasLike): Raster {
  const ctx = c.getContext('2d')!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function rasterToCanvas(r: Raster | Mask, asMask = false): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = r.width;
  c.height = r.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(r.width, r.height);
  if (asMask || r.data.length === r.width * r.height) {
    for (let p = 0; p < r.width * r.height; p++) {
      const v = r.data[p]!;
      img.data[p * 4] = v;
      img.data[p * 4 + 1] = v;
      img.data[p * 4 + 2] = v;
      img.data[p * 4 + 3] = 255;
    }
  } else img.data.set(r.data);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The flattened canvas at full resolution (for sampling and pixel tools). */
export function compositeRaster(host: BrowserRenderHost, state: ProjectState, canvasId: string): Raster {
  return canvasToRaster(renderCanvasDocument(host, state, canvasId, { scale: 1 }));
}

export function layerRaster(host: BrowserRenderHost, state: ProjectState, layerId: string): Raster {
  return canvasToRaster(renderSingleLayer(host, state, layerId, { includeMask: true }));
}

export function selectionToMask(host: BrowserRenderHost, sel: Selection, w: number, h: number): Mask {
  return selectionMask(host, sel, w, h, 1);
}

async function canvasBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/png'));
}

/** Upload a raster (or mask) as a PNG asset; registers it with the host so it renders immediately. */
export async function uploadRaster(host: BrowserRenderHost, r: Raster | Mask, name: string, projectId: string, asMask = false): Promise<string> {
  const c = rasterToCanvas(r, asMask);
  const blob = await canvasBlob(c);
  const { asset } = await uploadFile(blob, { name, projectId, tags: asMask ? ['mask'] : [] });
  if (asMask) host.putMask(asset.id, r as Mask);
  host.putImage(asset.id, await createImageBitmap(c));
  return asset.id;
}

/** Mask out pixels outside the selection (keeps the raster size). */
export function clipToMask(r: Raster, m: Mask): Raster {
  const out = new Uint8ClampedArray(r.data);
  for (let p = 0; p < m.data.length; p++) out[p * 4 + 3] = (out[p * 4 + 3]! * m.data[p]!) / 255;
  return { width: r.width, height: r.height, data: out };
}

export function maskBoundsOf(m: Mask): { x: number; y: number; width: number; height: number } | null {
  let minX = m.width;
  let minY = m.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++)
      if (m.data[y * m.width + x]! > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
