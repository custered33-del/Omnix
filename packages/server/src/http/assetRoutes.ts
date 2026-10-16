import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractFrame, makeAudioProxy } from '../util/media.js';
import { z } from 'zod';
import type { Services } from '../services.js';
import { h, requireUser } from './middleware.js';
import { streamToTemp } from '../storage/blobs.js';
import { BlockedUrlError, safeFetch, type SafeResponse } from '../util/safeFetch.js';
import { ProjectError } from '../projects/service.js';
import { assetSummary, requireAsset, visibleAssets } from '../mcp/tools/assets.js';
import type { AssetRecord } from '../assets/pipeline.js';
import { ToolError } from '../mcp/registry.js';
import { assetUsage, ensureAnalyzed, mergeAssets, releaseAsset, searchAssets, similarGroups, similarTo, type AssetUse } from '../assets/library.js';

async function requireVisible(services: Services, userId: string, id: string): Promise<AssetRecord> {
  try {
    return await requireAsset(services, userId, id);
  } catch (e) {
    if (e instanceof ToolError) throw new ProjectError('Asset not found', 404);
    throw e;
  }
}

/** Kinds of file a browser can show without running anything inside them. */
const SHOWN_INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain|font\/[\w.+-]+)$/i;

/** A Content-Disposition value that survives any file name. */
export function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Send a blob with HTTP range support so video can stream and scrub in the browser.
 * Uploaded files are other people's content on Omnix's own address: an SVG or HTML file opened
 * directly could run scripts as whoever opens it. So every file is sandboxed, and anything but
 * plain pictures, media, PDFs and text downloads instead of opening. Pictures in pages still load.
 */
export async function sendBlob(services: Services, req: express.Request, res: express.Response, blobId: string, mime: string, filename?: string, download = false): Promise<void> {
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  // Only files that a browser could open as a page (SVG, HTML, XML...) can run scripts, so only they
  // are sandboxed. Sound and video are not: Firefox silences sandboxed media played through Web Audio.
  if (!/^(audio|video)\//i.test(mime)) res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (download || (filename && req.query.download === '1') || !SHOWN_INLINE.test(mime)) res.set('Content-Disposition', attachmentHeader(filename ?? 'file'));
  if (services.blobs.kind === 'local') {
    // The data folder is usually .omnix-data: without dotfiles 'allow', express refuses every file in it.
    const p = await services.blobs.localPath(blobId);
    await new Promise<void>((resolve, reject) => res.sendFile(p, { headers: { 'Content-Type': mime }, acceptRanges: true, lastModified: false, etag: true, dotfiles: 'allow' }, (err) => (err ? reject(err) : resolve())));
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

/** The library as one person sees it, with fingerprints filled in and where each asset is used. */
export async function libraryFor(services: Services, userId: string): Promise<{ list: AssetRecord[]; usage: Map<string, AssetUse[]> }> {
  let list = await visibleAssets(services, userId);
  // Older assets get their automatic tags and fingerprint the first time the library is opened.
  const missing = list.filter((a) => !a.autoTags).slice(0, 60);
  if (missing.length) {
    const done = new Map((await Promise.all(missing.map((a) => ensureAnalyzed(services, a)))).map((a) => [a.id, a]));
    list = list.map((a) => done.get(a.id) ?? a);
  }
  const projects = await services.projects.listForUser(userId, { includeArchived: true });
  return { list, usage: await assetUsage(services, projects) };
}

export function assetRoutes(services: Services): express.Router {
  const r = express.Router();
  const listed = (a: AssetRecord, usage: Map<string, AssetUse[]>) => ({
    ...assetSummary(a, ''),
    autoTags: a.autoTags ?? [],
    proxyStatus: a.proxyStatus,
    hasThumbnail: !!a.thumbnailBlob,
    waveform: a.waveform ? a.waveform.filter((_, i) => i % 3 === 0) : undefined,
    owners: a.owners.length,
    projectIds: a.projectIds,
    usedIn: (usage.get(a.id) ?? []).map((u) => ({ projectId: u.projectId, projectName: u.projectName, count: u.nodeIds.length })),
  });

  r.get(
    '/',
    h(async (req, res) => {
      const user = requireUser(req);
      const q = z
        .object({ q: z.string().optional(), kind: z.string().optional(), tag: z.string().optional(), projectId: z.string().optional(), sort: z.enum(['newest', 'oldest', 'name', 'size', 'relevance']).optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().min(0).optional() })
        .parse(req.query);
      const { list: all, usage } = await libraryFor(services, user.id);
      const list = searchAssets(all, { ...(q.q ? { query: q.q } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.tag ? { tag: q.tag } : {}), ...(q.projectId ? { projectId: q.projectId } : {}), ...(q.sort ? { sort: q.sort } : {}), usage });
      const total = list.length;
      const offset = q.offset ?? 0;
      const tags = [...new Set(list.flatMap((a) => a.tags))].sort();
      const autoTags = [...new Set(list.flatMap((a) => a.autoTags ?? []))].sort();
      const similar = similarGroups(all).length;
      res.json({ total, tags, autoTags, similarGroups: similar, assets: list.slice(offset, offset + (q.limit ?? 100)).map((a) => listed(a, usage)) });
    }),
  );

  /** Groups of near-duplicate files (resized or re-encoded copies), best copy first. */
  r.get(
    '/similar',
    h(async (req, res) => {
      const user = requireUser(req);
      const { list, usage } = await libraryFor(services, user.id);
      res.json({ groups: similarGroups(list).map((g) => g.map((a) => listed(a, usage))) });
    }),
  );

  /** Keep one copy: every project the person can edit switches to it, and the others leave the library. */
  r.post(
    '/merge',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ keep: z.string(), drop: z.array(z.string()).min(1).max(50) }).parse(req.body);
      for (const id of [body.keep, ...body.drop]) await requireVisible(services, user.id, id);
      const author = { type: 'human' as const, id: user.id, name: user.name };
      const result = await mergeAssets(services, user.id, body.keep, body.drop, async (projectId, ops, label) => {
        await services.projects.commit(projectId, ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, author, { label, via: 'ui' });
        return 'committed';
      });
      res.json(result);
    }),
  );

  /** Tag, untag or remove many assets at once. */
  r.post(
    '/bulk',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ ids: z.array(z.string()).min(1).max(500), addTags: z.array(z.string().max(40)).max(20).optional(), removeTags: z.array(z.string().max(40)).max(20).optional(), remove: z.boolean().optional() }).parse(req.body);
      let changed = 0;
      for (const id of body.ids) {
        const a = await requireVisible(services, user.id, id);
        if (body.remove) {
          await releaseAsset(services, a, user.id);
          changed++;
          continue;
        }
        const add = (body.addTags ?? []).map((t) => t.trim()).filter(Boolean);
        const drop = new Set((body.removeTags ?? []).map((t) => t.trim().toLowerCase()));
        const tags = [...new Set([...a.tags.filter((t) => !drop.has(t.toLowerCase())), ...add])];
        if (tags.join('\u0000') !== a.tags.join('\u0000')) {
          await services.assets.update(a.id, { tags });
          changed++;
        }
      }
      res.json({ changed });
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
      // A new file that looks like one already in the library (a resized or re-saved copy).
      const similar = existed ? [] : similarTo(asset, await visibleAssets(services, user.id)).slice(0, 3).map(({ asset: s, distance }) => ({ id: s.id, name: s.name, distance, width: s.width, height: s.height }));
      res.status(existed ? 200 : 201).json({ asset: { ...assetSummary(asset, ''), autoTags: asset.autoTags ?? [], proxyStatus: asset.proxyStatus, waveform: asset.waveform, exif: asset.exif }, deduplicated: existed, similar });
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
      const a = await ensureAnalyzed(services, await requireVisible(services, user.id, String(req.params.id)));
      const { list, usage } = await libraryFor(services, user.id);
      const similar = similarTo(a, list).map(({ asset: s, distance }) => ({ id: s.id, name: s.name, distance, width: s.width, height: s.height, size: s.size }));
      res.json({ asset: { ...a, owners: undefined, ownedByMe: a.owners.includes(user.id), usedIn: usage.get(a.id) ?? [], similar } });
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
      await releaseAsset(services, a, user.id);
      res.json({ ok: true });
    }),
  );

  r.use(assetFileRoutes(services, (req, id) => requireVisible(services, requireUser(req).id, id)));

  return r;
}

const frameCache = new Map<string, Buffer>();
const audioJobs = new Map<string, Promise<string>>();

/**
 * Routes that serve an asset's bytes (original, thumbnail, editing proxy, single frames and
 * MP3 audio). `resolve` decides which assets a request may see: the signed-in library, or
 * only the media a shared presentation uses.
 */
export function assetFileRoutes(services: Services, resolve: (req: express.Request, id: string) => Promise<AssetRecord>): express.Router {
  const r = express.Router({ mergeParams: true });
  r.get(
    '/:id/file',
    h(async (req, res) => {
      const a = await resolve(req, String(req.params.id));
      await sendBlob(services, req, res, a.id, a.mime, a.name);
    }),
  );

  r.get(
    '/:id/thumbnail',
    h(async (req, res) => {
      const a = await resolve(req, String(req.params.id));
      if (!a.thumbnailBlob) throw new ProjectError('No thumbnail for this asset', 404);
      await sendBlob(services, req, res, a.thumbnailBlob, 'image/webp');
    }),
  );

  /** Editing proxy (falls back to the original when no proxy is needed). */
  r.get(
    '/:id/proxy',
    h(async (req, res) => {
      const a = await resolve(req, String(req.params.id));
      if (a.proxyBlob) await sendBlob(services, req, res, a.proxyBlob, 'video/mp4');
      else await sendBlob(services, req, res, a.id, a.mime);
    }),
  );

  /**
   * A single decoded frame (JPEG). Fallback for browsers that cannot decode the video codec;
   * frames are cached in memory by time and size.
   */
  r.get(
    '/:id/frame',
    h(async (req, res) => {
      const a = await resolve(req, String(req.params.id));
      if (a.kind !== 'video') throw new ProjectError('Frames are only available for video assets', 400);
      const fps = a.fps ?? 30;
      const t = Math.min(Math.max(0, Number(req.query.t ?? 0) || 0), Math.max(0, (a.duration ?? 0) - 1 / fps));
      const frame = Math.round(t * fps);
      const w = Math.min(1920, Math.max(64, Number(req.query.w ?? 960) || 960));
      const key = `${a.id}:${frame}:${w}`;
      let buf = frameCache.get(key);
      if (!buf) {
        buf = await extractFrame(services.config.ffmpegPath, await services.blobs.localPath(a.proxyBlob ?? a.id), frame / fps, w, 'jpeg');
        frameCache.set(key, buf);
        if (frameCache.size > 600) frameCache.delete(frameCache.keys().next().value!);
      }
      res.setHeader('content-type', 'image/jpeg');
      res.setHeader('cache-control', 'private, max-age=86400');
      res.end(buf);
    }),
  );

  /** MP3 audio, transcoded on first request and kept (for browsers without AAC and other codecs). */
  r.get(
    '/:id/audio',
    h(async (req, res) => {
      const a = await resolve(req, String(req.params.id));
      if (a.kind !== 'video' && a.kind !== 'audio') throw new ProjectError('This asset has no audio', 400);
      let blob = a.audioProxyBlob ?? null;
      if (!blob) {
        let job = audioJobs.get(a.id);
        if (!job) {
          job = (async () => {
            const out = path.join(os.tmpdir(), `omnix-audio-${crypto.randomBytes(6).toString('hex')}.mp3`);
            try {
              await makeAudioProxy(services.config.ffmpegPath, await services.blobs.localPath(a.id), out);
              const id = await services.blobs.putFile(out);
              await services.assets.update(a.id, { audioProxyBlob: id });
              return id;
            } finally {
              await fs.rm(out, { force: true });
              audioJobs.delete(a.id);
            }
          })();
          audioJobs.set(a.id, job);
        }
        blob = await job;
      }
      await sendBlob(services, req, res, blob, 'audio/mpeg');
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
  // The address is checked again where the connection is made, and after every redirect.
  let resp: SafeResponse;
  try {
    resp = await safeFetch(u.toString(), { timeoutMs: 60_000 });
  } catch (e) {
    if (e instanceof BlockedUrlError) throw new ProjectError(e.message, 400);
    throw new ProjectError(`Download failed: ${e instanceof Error ? e.message : String(e)}`, 400);
  }
  if (resp.status < 200 || resp.status >= 300) {
    resp.body.resume();
    throw new ProjectError(`Download failed: HTTP ${resp.status}`, 400);
  }
  const len = Number(resp.headers['content-length'] ?? 0);
  if (len > services.config.maxUploadBytes) {
    resp.body.destroy();
    throw new ProjectError('File is too large to import', 413);
  }
  const tmp = await streamToTemp(resp.body, services.config.maxUploadBytes);
  const name = options.name ?? decodeURIComponent(new URL(resp.url).pathname.split('/').pop() || 'download');
  return services.assets.ingestFile(tmp.path, { name, ownerId: options.ownerId, ...(options.projectId ? { projectId: options.projectId } : {}), tags: options.tags ?? [], mimeHint: String(resp.headers['content-type'] ?? ''), source: options.source ?? { kind: 'url', url } }, tmp.sha256);
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
