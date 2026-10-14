import express from 'express';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Services } from '../services.js';
import { h, requireUser } from './middleware.js';
import { streamToTemp } from '../storage/blobs.js';
import { ProjectError } from '../projects/service.js';
import { assetSummary, requireAsset, visibleAssets } from '../mcp/tools/assets.js';
import type { AssetRecord } from '../assets/pipeline.js';
import { ToolError } from '../mcp/registry.js';

async function requireVisible(services: Services, userId: string, id: string): Promise<AssetRecord> {
  try {
    return await requireAsset(services, userId, id);
  } catch (e) {
    if (e instanceof ToolError) throw new ProjectError('Asset not found', 404);
    throw e;
  }
}

/** Send a blob with HTTP range support so video can stream and scrub in the browser. */
async function sendBlob(services: Services, req: express.Request, res: express.Response, blobId: string, mime: string, filename?: string): Promise<void> {
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  if (filename && req.query.download === '1') res.set('Content-Disposition', `attachment; filename="${filename.replace(/["\\]/g, '_')}"`);
  if (services.blobs.kind === 'local') {
    const p = await services.blobs.localPath(blobId);
    await new Promise<void>((resolve, reject) => res.sendFile(p, { headers: { 'Content-Type': mime }, acceptRanges: true, lastModified: false, etag: true }, (err) => (err ? reject(err) : resolve())));
    return;
  }
  const data = await services.blobs.get(blobId);
  if (!data) throw new ProjectError('File missing from storage', 404);
  const range = req.headers.range;
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) });
    res.end(data.subarray(start, end + 1));
    return;
  }
  res.set('Accept-Ranges', 'bytes').send(data);
}

export function assetRoutes(services: Services): express.Router {
  const r = express.Router();

  r.get(
    '/',
    h(async (req, res) => {
      const user = requireUser(req);
      const q = z
        .object({ q: z.string().optional(), kind: z.string().optional(), tag: z.string().optional(), projectId: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().min(0).optional() })
        .parse(req.query);
      let list = await visibleAssets(services, user.id);
      if (q.kind) list = list.filter((a) => a.kind === q.kind);
      if (q.tag) list = list.filter((a) => a.tags.includes(q.tag!));
      if (q.projectId) list = list.filter((a) => a.projectIds.includes(q.projectId!));
      if (q.q) {
        const needle = q.q.toLowerCase();
        list = list.filter((a) => a.name.toLowerCase().includes(needle) || a.tags.some((t) => t.toLowerCase().includes(needle)) || a.kind === needle);
      }
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const total = list.length;
      const offset = q.offset ?? 0;
      const tags = [...new Set(list.flatMap((a) => a.tags))].sort();
      res.json({ total, tags, assets: list.slice(offset, offset + (q.limit ?? 100)).map((a) => ({ ...assetSummary(a, ''), proxyStatus: a.proxyStatus, hasThumbnail: !!a.thumbnailBlob, waveform: a.waveform ? a.waveform.filter((_, i) => i % 3 === 0) : undefined, owners: a.owners.length, projectIds: a.projectIds })) });
    }),
  );

  /**
   * Upload: raw request body (any content type). Name via `?name=` or the x-filename header.
   * Identical files are deduplicated by content hash.
   */
  r.post(
    '/',
    h(async (req, res) => {
      const user = requireUser(req);
      const name = String(req.query.name ?? req.headers['x-filename'] ?? 'upload');
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      if (projectId) await services.projects.requireAccess(projectId, user.id, 'write');
      const tags = req.query.tags ? String(req.query.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
      const tmp = await streamToTemp(req, services.config.maxUploadBytes);
      if (tmp.size === 0) {
        await fs.rm(tmp.path, { force: true });
        throw new ProjectError('The upload was empty', 400);
      }
      const existed = !!(await services.assets.get(tmp.sha256));
      const asset = await services.assets.ingestFile(tmp.path, { name, ownerId: user.id, ...(projectId ? { projectId } : {}), tags, mimeHint: String(req.headers['content-type'] ?? '') }, tmp.sha256);
      res.status(existed ? 200 : 201).json({ asset: { ...assetSummary(asset, ''), proxyStatus: asset.proxyStatus, waveform: asset.waveform, exif: asset.exif }, deduplicated: existed });
    }),
  );

  /** Import from a URL (the server downloads it). */
  r.post(
    '/import-url',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ url: z.string().url(), name: z.string().optional(), projectId: z.string().optional(), tags: z.array(z.string()).optional() }).parse(req.body);
      if (body.projectId) await services.projects.requireAccess(body.projectId, user.id, 'write');
      const asset = await importFromUrl(services, body.url, { ownerId: user.id, ...(body.name ? { name: body.name } : {}), ...(body.projectId ? { projectId: body.projectId } : {}), tags: body.tags ?? [] });
      res.status(201).json({ asset: assetSummary(asset, '') });
    }),
  );

  r.get(
    '/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const a = await requireVisible(services, user.id, String(req.params.id));
      res.json({ asset: { ...a, owners: undefined, ownedByMe: a.owners.includes(user.id) } });
    }),
  );

  r.patch(
    '/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const a = await requireVisible(services, user.id, String(req.params.id));
      const body = z.object({ name: z.string().max(200).optional(), tags: z.array(z.string().max(40)).max(50).optional() }).parse(req.body);
      const next = await services.assets.update(a.id, { ...(body.name ? { name: body.name } : {}), ...(body.tags ? { tags: [...new Set(body.tags.map((t) => t.trim()).filter(Boolean))] } : {}) });
      res.json({ asset: assetSummary(next, '') });
    }),
  );

  /** Remove the asset from my library (the bytes stay while other owners or projects use them). */
  r.delete(
    '/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const a = await requireVisible(services, user.id, String(req.params.id));
      const owners = a.owners.filter((o) => o !== user.id);
      if (owners.length === 0 && a.projectIds.length === 0) {
        await services.store.delete('assets', a.id);
        await services.blobs.delete(a.id);
        if (a.thumbnailBlob) await services.blobs.delete(a.thumbnailBlob);
        if (a.proxyBlob) await services.blobs.delete(a.proxyBlob);
      } else {
        await services.assets.update(a.id, { owners });
      }
      res.json({ ok: true });
    }),
  );

  r.get(
    '/:id/file',
    h(async (req, res) => {
      const user = requireUser(req);
      const a = await requireVisible(services, user.id, String(req.params.id));
      await sendBlob(services, req, res, a.id, a.mime, a.name);
    }),
  );

  r.get(
    '/:id/thumbnail',
    h(async (req, res) => {
      const user = requireUser(req);
      const a = await requireVisible(services, user.id, String(req.params.id));
      if (!a.thumbnailBlob) throw new ProjectError('No thumbnail for this asset', 404);
      await sendBlob(services, req, res, a.thumbnailBlob, 'image/webp');
    }),
  );

  /** Editing proxy (falls back to the original when no proxy is needed). */
  r.get(
    '/:id/proxy',
    h(async (req, res) => {
      const user = requireUser(req);
      const a = await requireVisible(services, user.id, String(req.params.id));
      if (a.proxyBlob) await sendBlob(services, req, res, a.proxyBlob, 'video/mp4');
      else await sendBlob(services, req, res, a.id, a.mime);
    }),
  );

  return r;
}

/** Download a URL into the asset library with size and scheme limits. */
export async function importFromUrl(services: Services, url: string, options: { ownerId: string; name?: string; projectId?: string; tags?: string[]; source?: AssetRecord['source'] }): Promise<AssetRecord> {
  const u = new URL(url);
  if (!['http:', 'https:', 'data:'].includes(u.protocol)) throw new ProjectError('Only http(s) and data: URLs can be imported', 400);
  if (u.protocol === 'data:') {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new ProjectError('Malformed data URL', 400);
    const data = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!));
    return services.assets.ingestBuffer(data, { name: options.name ?? 'pasted', ownerId: options.ownerId, ...(options.projectId ? { projectId: options.projectId } : {}), tags: options.tags ?? [], mimeHint: m[1] ?? '', source: options.source ?? { kind: 'url' } });
  }
  if (isPrivateHost(u.hostname)) throw new ProjectError('Importing from private network addresses is not allowed', 400);
  const resp = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!resp.ok || !resp.body) throw new ProjectError(`Download failed: HTTP ${resp.status}`, 400);
  const len = Number(resp.headers.get('content-length') ?? 0);
  if (len > services.config.maxUploadBytes) throw new ProjectError('File is too large to import', 413);
  const { Readable } = await import('node:stream');
  const tmp = await streamToTemp(Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream), services.config.maxUploadBytes);
  const name = options.name ?? decodeURIComponent(u.pathname.split('/').pop() || 'download');
  return services.assets.ingestFile(tmp.path, { name, ownerId: options.ownerId, ...(options.projectId ? { projectId: options.projectId } : {}), tags: options.tags ?? [], mimeHint: resp.headers.get('content-type') ?? '', source: options.source ?? { kind: 'url', url } }, tmp.sha256);
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h === '::1' || h.startsWith('[::1') || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80')) return true;
  return false;
}
