import { z } from 'zod';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { importPsd, type ImportedPsdLayer } from '@omnix/exporters';
import { layerProps, makeNode, type LayerProps, type SceneNode } from '@omnix/core';
import type { Raster } from '@omnix/imaging';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser, author as authorOf } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';

/**
 * Importers that turn files into editable project content. PSD: every layer becomes an Omnix
 * layer (pixels as assets, groups kept, masks as editable layer masks, blend modes and opacity kept).
 */
export interface PsdImportResult {
  canvasId: string;
  layers: number;
  notes: string[];
}

async function rasterPng(r: Raster): Promise<Buffer> {
  return sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.width, height: r.height, channels: 4 } }).png().toBuffer();
}

/** Place a PSD layer mask (in its own bounds) onto a full-canvas grayscale mask. */
async function maskPng(l: ImportedPsdLayer, width: number, height: number): Promise<Buffer> {
  const out = Buffer.alloc(width * height, l.maskDefault);
  const m = l.mask!;
  for (let y = 0; y < m.height; y++) {
    const dy = y + l.maskTop;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < m.width; x++) {
      const dx = x + l.maskLeft;
      if (dx < 0 || dx >= width) continue;
      // ag-psd mask image data is RGBA with the mask value in each color channel.
      out[dy * width + dx] = m.data[(y * m.width + x) * 4]!;
    }
  }
  return sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

export async function importPsdIntoProject(services: Services, projectId: string, assetId: string, by: { userId: string; author: ReturnType<typeof authorOf> }, name?: string): Promise<PsdImportResult> {
  const asset = await services.assets.get(assetId);
  if (!asset || !(asset.owners.includes(by.userId) || asset.projectIds.includes(projectId))) throw new ProjectError('Asset not found', 404);
  if (asset.mime !== 'image/vnd.adobe.photoshop') throw new ProjectError('That file is not a Photoshop document', 400);
  const data = await services.blobs.get(asset.id);
  if (!data) throw new ProjectError('Asset file is missing', 404);
  let psd;
  try {
    psd = importPsd(data, (w, h) => createCanvas(w, h));
  } catch (e) {
    throw new ProjectError(`Could not read the PSD: ${(e as Error).message}`, 400);
  }
  const notes: string[] = [];
  const state = await services.projects.state(projectId);
  const canvas = makeNode('canvas', { name: name ?? asset.name.replace(/\.psd$/i, ''), width: psd.width, height: psd.height, background: null });
  canvas.parentId = state.rootId;
  const nodes: SceneNode[] = [canvas];
  let count = 0;
  const ingest = async (buf: Buffer, file: string, tags: string[]) => (await services.assets.ingestBuffer(buf, { name: file, ownerId: by.userId, projectId, mimeHint: 'image/png', tags, source: { kind: 'import', projectId } })).id;

  const build = async (layers: ImportedPsdLayer[], parent: SceneNode) => {
    for (const l of layers) {
      const base: Partial<LayerProps> = { name: l.name, visible: !l.hidden, opacity: l.opacity, blendMode: l.blendMode };
      let node: SceneNode<'layer'>;
      if (l.children) {
        node = makeNode('layer', layerProps('group', base));
      } else if (l.pixels) {
        const id = await ingest(await rasterPng(l.pixels), `${l.name}.png`, ['psd-layer']);
        node = makeNode('layer', layerProps('raster', { ...base, assetId: id, x: l.left, y: l.top, width: l.pixels.width, height: l.pixels.height }));
        if (l.text !== null) notes.push(`Text layer "${l.name}" was imported as pixels so it looks exactly as in Photoshop.`);
      } else {
        // Empty or unsupported layer (adjustment/fill without pixels): keep a placeholder group so order is preserved.
        notes.push(`Layer "${l.name}" has no pixels (adjustment or effect layer) and was imported empty.`);
        node = makeNode('layer', layerProps('group', base));
      }
      if (l.mask) {
        const mid = await ingest(await maskPng(l, psd.width, psd.height), `${l.name} mask.png`, ['mask']);
        node.props.mask = { source: { kind: 'mask', assetId: mid }, inverted: false, enabled: true };
      }
      node.parentId = parent.id;
      parent.children.push(node.id);
      nodes.push(node);
      count++;
      if (l.children) await build(l.children, node);
    }
  };
  await build(psd.layers, canvas);
  if (count === 0 && psd.composite) {
    const id = await ingest(await rasterPng(psd.composite), `${canvas.props.name}.png`, ['psd-layer']);
    const node = makeNode('layer', layerProps('raster', { name: 'Background', assetId: id, width: psd.width, height: psd.height }));
    node.parentId = canvas.id;
    canvas.children.push(node.id);
    nodes.push(node);
    count = 1;
    notes.push('This PSD has no layers; the flattened image was imported.');
  }
  await services.projects.commit(projectId, { kind: 'create', parentId: state.rootId, nodes }, by.author, { label: `Import ${asset.name}`, via: by.author.type === 'ai' ? 'mcp' : 'ui' });
  return { canvasId: canvas.id, layers: count, notes };
}

useModule(({ services, router }) => {
  router.post(
    '/projects/:id/import/psd',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const body = z.object({ assetId: z.string(), name: z.string().max(200).optional() }).parse(req.body);
      res.json(await importPsdIntoProject(services, projectId, body.assetId, { userId: user.id, author: authorOf(req) }, body.name));
    }),
  );
});
