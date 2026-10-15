import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { ProjectState, SceneNode } from '@omnix/core';
import { childrenOf, closest, requireNodeOfType } from '@omnix/core';
import { layerBounds, renderCanvasDocument, renderSingleLayer, renderSpriteSheet, type CanvasLike } from '@omnix/render';
import { exportPsd, exportSvg, encodeGif, encodeApng, exportLottie, spriteAtlas, toSrt, toVtt, VIDEO_PRESETS, type CaptionCue } from '@omnix/exporters';
import type { Raster } from '@omnix/imaging';
import type { Services } from '../services.js';
import { h, requireUser } from '../http/middleware.js';
import { encodeCanvas } from '../render/serverHost.js';
import { exportVideo, renderWithFrames } from './videoExport.js';
import { DecoderPool } from './decoders.js';
import { ProjectError } from '../projects/service.js';
import { clipsOf, clipEnd, tracksOf } from '@omnix/core';
import { useModule } from '../app.js';
import { defineTool, ToolError, zProjectId, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { signedFileUrl, verifyFileSignature } from '../http/signedUrls.js';
import { sendBlob } from '../http/assetRoutes.js';

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'avif', 'svg', 'psd'] as const;
export const ANIMATION_FORMATS = ['gif', 'apng', 'webm', 'mp4', 'lottie', 'spritesheet'] as const;
export const CAPTION_FORMATS = ['srt', 'vtt'] as const;

export const ExportRequest = z.object({
  nodeId: z.string().describe('Canvas, sequence, document or deck id.'),
  format: z.string().describe('png, jpeg, webp, avif, svg, psd | a video preset id | gif, apng, webm, mp4, lottie, spritesheet | srt, vtt | docx, pdf, md, html | pptx, pdf'),
  scale: z.number().min(0.05).max(4).optional(),
  quality: z.number().min(1).max(100).optional(),
  colorProfile: z.enum(['srgb', 'display-p3']).optional(),
  transparent: z.boolean().optional(),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  loops: z.number().int().min(0).max(1000).optional(),
});
export type ExportRequest = z.infer<typeof ExportRequest>;

export interface ExportOutput {
  data?: Buffer;
  filePath?: string;
  name: string;
  mime: string;
  notes: string[];
}

export type ExportHandler = (services: Services, state: ProjectState, node: SceneNode, req: ExportRequest, ctx: { signal: AbortSignal; progress: (f: number, m: string) => void }) => Promise<ExportOutput | null>;

/** Other modules (documents, slides) register format handlers here. */
export function registerExportHandler(services: Services, handler: ExportHandler): void {
  const list = (services.ext.exportHandlers as ExportHandler[] | undefined) ?? [];
  list.push(handler);
  services.ext.exportHandlers = list;
}

const safe = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'export';

async function exportCanvas(services: Services, state: ProjectState, node: SceneNode<'canvas'>, req: ExportRequest, layer?: SceneNode<'layer'>): Promise<ExportOutput> {
  const host = services.renderHost();
  await host.prepare(state, node.id);
  const base = safe(node.props.name);
  const fmt = req.format as (typeof IMAGE_FORMATS)[number];
  if (layer && fmt !== 'psd' && fmt !== 'svg') {
    // One layer's own pixels (with its filters and mask), cropped to its content.
    const scale = req.scale ?? 1;
    const full = renderSingleLayer(host, state, layer.id, { scale });
    const b = layerBounds(host, state, layer.id);
    const x0 = Math.max(0, Math.floor(b.x * scale));
    const y0 = Math.max(0, Math.floor(b.y * scale));
    const w = Math.max(1, Math.min(full.width, Math.ceil((b.x + b.width) * scale)) - x0);
    const h = Math.max(1, Math.min(full.height, Math.ceil((b.y + b.height) * scale)) - y0);
    const out = host.createCanvas(w, h) as CanvasLike;
    const ctx = out.getContext('2d')!;
    if (fmt === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(full as never, -x0, -y0);
    const data = await encodeCanvas(out, fmt, { quality: req.quality ?? 90, colorProfile: req.colorProfile ?? node.props.colorProfile });
    return { data, name: `${base}-${safe(layer.props.name)}.${fmt === 'jpeg' ? 'jpg' : fmt}`, mime: `image/${fmt}`, notes: fmt === 'jpeg' ? ['JPEG has no transparency; the layer is on white.'] : [] };
  }
  const layerNote = layer ? [`${fmt.toUpperCase()} exports the whole canvas "${node.props.name}"; use png, jpeg, webp or avif for one layer.`] : [];
  if (fmt === 'psd') {
    const r = exportPsd(host, state, node.id);
    return { data: r.data, name: `${base}.psd`, mime: 'image/vnd.adobe.photoshop', notes: [...layerNote, ...r.notes] };
  }
  if (fmt === 'svg') {
    const svg = exportSvg(host, state, node.id, { encodePng: (c) => (c as unknown as { toBuffer(m: string): Buffer }).toBuffer('image/png').toString('base64') });
    return { data: Buffer.from(svg), name: `${base}.svg`, mime: 'image/svg+xml', notes: layerNote };
  }
  const canvas = renderCanvasDocument(host, state, node.id, { scale: req.scale ?? 1, transparent: req.transparent && fmt !== 'jpeg' });
  const data = await encodeCanvas(canvas, fmt, { quality: req.quality ?? 90, colorProfile: req.colorProfile ?? node.props.colorProfile });
  const notes = fmt === 'jpeg' && req.transparent ? ['JPEG has no transparency; the background was filled with white.'] : [];
  return { data, name: `${base}.${fmt === 'jpeg' ? 'jpg' : fmt}`, mime: `image/${fmt}`, notes };
}

async function renderFrames(services: Services, state: ProjectState, seqId: string, req: ExportRequest, progress: (f: number, m: string) => void, signal: AbortSignal): Promise<{ frames: Raster[]; fps: number }> {
  const seq = requireNodeOfType(state, seqId, 'sequence');
  const fps = seq.props.fps;
  const start = req.start ?? 0;
  const end = req.end ?? seq.props.duration;
  const count = Math.max(1, Math.min(2000, Math.round((end - start) * fps)));
  const scale = req.scale ?? Math.min(1, 640 / Math.max(seq.props.width, seq.props.height));
  const host = services.renderHost();
  await host.prepare(state, seqId);
  const media = new Map<string, import('./decoders.js').DecoderSource>();
  for (const id of new Set(Object.values(state.nodes).flatMap((n) => (n.type === 'clip' && (n.props as { assetId: string | null }).assetId ? [(n.props as { assetId: string }).assetId] : [])))) {
    const a = await services.assets.get(id);
    if (a?.kind === 'video') media.set(id, { path: await services.blobs.localPath(id), width: a.width ?? 0, height: a.height ?? 0, fps: a.fps ?? 30, duration: a.duration ?? 0 });
  }
  const pool = new DecoderPool(services.config.ffmpegPath, Math.round(seq.props.width * scale), Math.round(seq.props.height * scale));
  const frames: Raster[] = [];
  try {
    for (let i = 0; i < count; i++) {
      if (signal.aborted) throw new Error('Export cancelled');
      const canvas = await renderWithFrames(host, state, seqId, start + i / fps, scale, media, pool, { transparent: !!req.transparent });
      const img = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      frames.push({ width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(img.data) });
      if (i % 5 === 0) progress((i / count) * 0.9, `Rendering frame ${i + 1} of ${count}`);
    }
  } finally {
    pool.closeAll();
  }
  return { frames, fps };
}

async function encodeWebmOrMp4(services: Services, frames: Raster[], fps: number, format: 'webm' | 'mp4', loops: number): Promise<Buffer> {
  const out = path.join(os.tmpdir(), `omnix-anim-${crypto.randomBytes(5).toString('hex')}.${format}`);
  const { width, height } = frames[0]!;
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
  if (format === 'webm') args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-auto-alt-ref', '0');
  else args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart');
  args.push(out);
  void loops;
  const proc = spawn(services.config.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
  for (const f of frames) {
    if (!proc.stdin.write(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength))) await new Promise<void>((r) => proc.stdin.once('drain', r));
  }
  proc.stdin.end();
  const code = await new Promise<number>((r) => proc.on('close', (c) => r(c ?? 1)));
  if (code !== 0) throw new Error(`Encoding failed: ${err.slice(-300)}`);
  const data = await fs.readFile(out);
  await fs.rm(out, { force: true });
  return data;
}

async function exportSequence(services: Services, state: ProjectState, node: SceneNode<'sequence'>, req: ExportRequest, ctx: { signal: AbortSignal; progress: (f: number, m: string) => void }): Promise<ExportOutput> {
  const base = safe(node.props.name);
  const fmt = req.format;
  if ((CAPTION_FORMATS as readonly string[]).includes(fmt)) {
    const cues: CaptionCue[] = [];
    for (const track of tracksOf(state, node.id)) {
      for (const c of clipsOf(state, track.id)) if (c.props.title?.caption) cues.push({ start: c.props.start, end: clipEnd(c.props), text: c.props.title.text });
    }
    cues.sort((a, b) => a.start - b.start);
    if (!cues.length) throw new ProjectError('This sequence has no captions yet. Generate or add captions first.', 400);
    return { data: Buffer.from(fmt === 'srt' ? toSrt(cues) : toVtt(cues)), name: `${base}.${fmt}`, mime: fmt === 'srt' ? 'application/x-subrip' : 'text/vtt', notes: [] };
  }
  if (fmt === 'lottie') {
    const host = services.renderHost();
    await host.prepare(state, node.id);
    const { json, notes } = exportLottie(state, node.id, (assetId, crop) => {
      const img = host.image(assetId) as unknown as { width: number; height: number } | null;
      if (!img) return null;
      const w = crop?.w ?? img.width;
      const hh = crop?.h ?? img.height;
      const c = host.createCanvas(w, hh);
      c.getContext('2d')!.drawImage(img as unknown as CanvasImageSource, crop?.x ?? 0, crop?.y ?? 0, w, hh, 0, 0, w, hh);
      return { dataUri: `data:image/png;base64,${(c as unknown as { toBuffer(m: string): Buffer }).toBuffer('image/png').toString('base64')}`, w, h: hh };
    });
    return { data: Buffer.from(JSON.stringify(json)), name: `${base}.json`, mime: 'application/json', notes };
  }
  if (fmt === 'spritesheet') {
    const host = services.renderHost();
    await host.prepare(state, node.id);
    const layer = childrenOf(state, node.id)
      .flatMap((t) => childrenOf(state, t.id))
      .find((n): n is SceneNode<'animLayer'> => n.type === 'animLayer');
    if (!layer) throw new ProjectError('Sprite sheets are made from an animation layer; this sequence has none.', 400);
    const scale = req.scale ?? 1;
    const fw = Math.round(node.props.width * scale);
    const fh = Math.round(node.props.height * scale);
    const sheet = renderSpriteSheet(host, layer.props, node.props.fps, fw, fh);
    const png = await encodeCanvas(sheet.canvas, 'png');
    return { data: png, name: `${base}-spritesheet.png`, mime: 'image/png', notes: [`${sheet.frameCount} frames of ${fw}x${fh} in a ${sheet.columns}x${sheet.rows} grid. Export "spritesheet-json" for the atlas.`] };
  }
  if (fmt === 'spritesheet-json') {
    const layer = childrenOf(state, node.id)
      .flatMap((t) => childrenOf(state, t.id))
      .find((n): n is SceneNode<'animLayer'> => n.type === 'animLayer');
    if (!layer) throw new ProjectError('This sequence has no animation layer.', 400);
    const scale = req.scale ?? 1;
    const count = Math.max(1, layer.props.frames.length ? layer.props.frames.reduce((a, f) => a + Math.max(1, f.hold), 0) : Math.round(layer.props.duration * node.props.fps));
    const atlas = spriteAtlas(base, `${base}-spritesheet.png`, count, Math.ceil(Math.sqrt(count)), Math.round(node.props.width * scale), Math.round(node.props.height * scale), node.props.fps);
    return { data: Buffer.from(JSON.stringify(atlas, null, 2)), name: `${base}-spritesheet.json`, mime: 'application/json', notes: [] };
  }
  if (fmt === 'gif' || fmt === 'apng' || ((fmt === 'webm' || fmt === 'mp4') && node.props.purpose === 'animation')) {
    const { frames, fps } = await renderFrames(services, state, node.id, req, ctx.progress, ctx.signal);
    ctx.progress(0.92, 'Encoding');
    if (fmt === 'gif') return { data: encodeGif(frames, { fps, loops: req.loops ?? (node.props.playback === 'once' ? 1 : 0) }), name: `${base}.gif`, mime: 'image/gif', notes: [] };
    if (fmt === 'apng') return { data: encodeApng(frames, { fps, loops: req.loops ?? (node.props.playback === 'once' ? 1 : 0) }), name: `${base}.png`, mime: 'image/apng', notes: [] };
    return { data: await encodeWebmOrMp4(services, frames, fps, fmt, req.loops ?? 0), name: `${base}.${fmt}`, mime: `video/${fmt}`, notes: [] };
  }
  const preset = VIDEO_PRESETS.find((p) => p.id === fmt);
  if (!preset) throw new ProjectError(`Unknown export format for a sequence: ${fmt}`, 400);
  const r = await exportVideo(services, state, node.id, { presetId: preset.id, ...(req.start !== undefined ? { start: req.start } : {}), ...(req.end !== undefined ? { end: req.end } : {}), signal: ctx.signal, onProgress: ctx.progress });
  const mime = preset.container === 'mp3' ? 'audio/mpeg' : preset.container === 'wav' ? 'audio/wav' : preset.container === 'mov' ? 'video/quicktime' : `video/${preset.container}`;
  return { filePath: r.path, name: `${base}.${preset.container}`, mime, notes: [] };
}

/** Run an export and store the result in the asset library. */
export async function runExport(services: Services, projectId: string, req: ExportRequest, ownerId: string, ctx: { signal: AbortSignal; progress: (f: number, m: string) => void }) {
  const state = await services.projects.state(projectId);
  const node = state.nodes[req.nodeId];
  if (!node) throw new ProjectError(`Node not found: ${req.nodeId}`, 404);
  let output: ExportOutput | null = null;
  for (const handler of (services.ext.exportHandlers as ExportHandler[] | undefined) ?? []) {
    output = await handler(services, state, node, req, ctx);
    if (output) break;
  }
  if (!output) {
    if (node.type === 'canvas' || node.type === 'layer') {
      const canvas = node.type === 'canvas' ? (node as SceneNode<'canvas'>) : closest(state, node.id, 'canvas')!;
      if (!(IMAGE_FORMATS as readonly string[]).includes(req.format)) throw new ProjectError(`Images export as ${IMAGE_FORMATS.join(', ')}`, 400);
      output = await exportCanvas(services, state, canvas, req, node.type === 'layer' ? (node as SceneNode<'layer'>) : undefined);
    } else if (node.type === 'sequence') {
      output = await exportSequence(services, state, node as SceneNode<'sequence'>, req, ctx);
    } else {
      throw new ProjectError(`Nothing to export for a ${node.type} in format ${req.format}`, 400);
    }
  }
  ctx.progress(0.995, 'Saving to the asset library');
  const tags = ['export', req.format];
  const asset = output.filePath
    ? await services.assets.ingestFile(output.filePath, { name: output.name, ownerId, projectId, tags, mimeHint: output.mime, source: { kind: 'export', projectId } })
    : await services.assets.ingestBuffer(output.data!, { name: output.name, ownerId, projectId, tags, mimeHint: output.mime, source: { kind: 'export', projectId } });
  return { assetId: asset.id, name: output.name, mime: asset.mime, size: asset.size, notes: output.notes, downloadUrl: `/api/assets/${asset.id}/file?download=1` };
}

function exportTools(services: Services): ToolDef[] {
  return [
    defineTool({
      name: 'export_file',
      title: 'Export a file',
      description:
        'Export a canvas (png, jpeg, webp, avif, svg, psd) or one layer of it (png, jpeg, webp, avif: just that layer, cropped to its content), a video or animation sequence (a preset id such as youtube-1080p or instagram-reel, or gif, apng, webm, mp4, lottie, spritesheet; srt or vtt for captions), a document (docx, pdf, md, html), a slideshow (pptx, pdf, pdf-notes, png) or a code workspace (zip, ipynb). Returns a download link that works for 24 hours. The file is added to your asset library, so this needs a connection that can edit; the project itself is not changed.',
      category: 'export',
      access: 'write',
      input: { projectId: zProjectId, nodeId: z.string(), format: z.string().min(2).max(40), scale: z.number().min(0.05).max(4).optional(), quality: z.number().min(1).max(100).optional(), start: z.number().min(0).optional(), end: z.number().min(0).optional(), transparent: z.boolean().optional() },
      output: z.object({ name: z.string(), url: z.string(), expiresAt: z.string(), assetId: z.string(), size: z.number(), notes: z.array(z.string()) }),
      example: { input: { projectId: 'prj_8Kq2...', nodeId: 'dck_1', format: 'pptx' }, output: { name: 'Launch.pptx', url: 'https://omnix.example.com/api/files/9f2c...?exp=1760000000&sig=...', expiresAt: '2026-10-15T18:00:00.000Z', assetId: '9f2c...', size: 482113, notes: [] } },
      async handler(args, ctx) {
        if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only, and exporting adds a file to the library. Ask the user to export, or to connect with edit access.');
        await ctx.requireProject(args.projectId, 'read');
        const { projectId, ...rest } = args;
        const request = ExportRequest.parse(rest);
        const job = await services.jobs.enqueue('export', { projectId, request }, { title: `Export ${request.format.toUpperCase()}`, ownerId: ctx.principal.user.id, projectId });
        const done = await services.jobs.wait(job.id);
        if (done.status !== 'done') throw new ToolError(`Export failed: ${done.error ?? done.status}`);
        const r = done.result as Awaited<ReturnType<typeof runExport>>;
        const link = await signedFileUrl(services, r.assetId);
        return { text: `Exported ${r.name} (${Math.round(r.size / 1024)} KB). Download: ${link.url}${r.notes.length ? `\nNotes: ${r.notes.join(' ')}` : ''}`, data: { name: r.name, url: link.url, expiresAt: link.expiresAt, assetId: r.assetId, size: r.size, notes: r.notes } };
      },
    }),
  ] as unknown as ToolDef[];
}

useModule(({ services, router }) => {
  registerToolProvider(services, exportTools);

  /** Signed, expiring download links (see signedFileUrl). */
  router.get(
    '/files/:id',
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!(await verifyFileSignature(services, id, String(req.query.exp ?? ''), String(req.query.sig ?? '')))) throw new ProjectError('This download link is invalid or has expired.', 403);
      const a = await services.assets.get(id);
      if (!a) throw new ProjectError('File not found', 404);
      await sendBlob(services, req, res, a.id, a.mime, a.name, true);
    }),
  );

  services.jobs.register<{ projectId: string; request: ExportRequest }, Awaited<ReturnType<typeof runExport>>>('export', async (ctx) => {
    const meta = await services.projects.getMeta(ctx.job.input.projectId);
    const result = await runExport(services, ctx.job.input.projectId, ctx.job.input.request, ctx.job.ownerId, { signal: ctx.signal, progress: ctx.progress });
    await services.activity.record({ projectId: meta.id, projectName: meta.name, actor: { type: 'human', id: ctx.job.ownerId, name: 'Export' }, kind: 'export', summary: `Exported ${result.name}`, via: 'system', jobId: ctx.job.id });
    return result;
  });

  router.get('/export/presets', (_req, res) => {
    res.json({ video: VIDEO_PRESETS.map(({ id, label, category, description, width, height, fps, container, maxDuration }) => ({ id, label, category, description, width, height, fps, container, maxDuration })), image: IMAGE_FORMATS, animation: ANIMATION_FORMATS, captions: CAPTION_FORMATS });
  });

  router.post(
    '/projects/:id/export',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'read');
      const body = ExportRequest.parse(req.body);
      const state = await services.projects.state(projectId);
      const node = state.nodes[body.nodeId];
      if (!node) throw new ProjectError('Node not found', 404);
      const job = await services.jobs.enqueue('export', { projectId, request: body }, { title: `Export ${body.format.toUpperCase()}`, ownerId: user.id, projectId });
      if (req.query.wait === 'true') {
        const done = await services.jobs.wait(job.id);
        res.status(done.status === 'done' ? 200 : 500).json({ job: done });
        return;
      }
      res.status(202).json({ job });
    }),
  );
});
