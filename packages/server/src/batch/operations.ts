import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import type { Author, FilterKind } from '@omnix/core';
import { applyFilter, applyLut3D, colorGrade, parseCubeLut, removeBackground, styleLut, upscale, type Raster } from '@omnix/imaging';
import type { Services } from '../services.js';
import type { User } from '../auth/users.js';
import type { AssetKind, AssetRecord } from '../assets/pipeline.js';
import { decodeRaster } from '../render/pixels.js';
import { run } from '../util/media.js';

/**
 * Batch processing (feature 54): one action applied to many files or documents. Operations on
 * library files make new files next to the originals (nothing is overwritten); operations on
 * project documents commit, or propose for review, one change per document. Other modules and
 * plugins add operations with registerBatchOperation.
 */

export type BatchTarget = { assetId: string } | { projectId: string; documentId: string };

export interface BatchItemResult {
  status: 'done' | 'failed' | 'skipped';
  message?: string;
  outputAssetId?: string;
  outputName?: string;
  commitId?: string;
  proposalId?: string;
}

export interface BatchRunContext {
  services: Services;
  user: User;
  author: Author;
  signal: AbortSignal;
  /** How document changes land: committed directly, or as a proposal to review. */
  apply: (projectId: string, ops: import('@omnix/core').Operation[], label: string) => Promise<{ status: 'committed' | 'proposed'; id: string }>;
  /** Tags added to every file a batch makes (always includes "batch"). */
  outputTags: string[];
  /** Only proposals are allowed (an approval-mode Claude connection). */
  proposeOnly: boolean;
}

export interface BatchOperation<P extends z.ZodRawShape = z.ZodRawShape> {
  id: string;
  label: string;
  description: string;
  group: 'image' | 'video' | 'audio' | 'document';
  /** Uses an AI model or AI-style analysis (background removal, upscaling, style match, commands). */
  ai?: boolean;
  /** Library file kinds this applies to; absent for document operations. */
  kinds?: AssetKind[];
  /** Project document types this applies to (canvas, sequence, document, deck, codeWorkspace). */
  documentTypes?: string[];
  params: P;
  run(ctx: BatchRunContext, target: BatchTarget, params: z.infer<z.ZodObject<P>>): Promise<BatchItemResult>;
}

export function defineBatchOperation<P extends z.ZodRawShape>(op: BatchOperation<P>): BatchOperation {
  return op as unknown as BatchOperation;
}

export function registerBatchOperation(services: Services, op: BatchOperation): void {
  const list = batchOperations(services);
  const i = list.findIndex((o) => o.id === op.id);
  if (i >= 0) list[i] = op;
  else list.push(op);
  services.ext.batchOperations = list;
}

/** Operations that come and go (plugin tools): asked for whenever the list is needed. */
export function registerBatchProvider(services: Services, provider: () => BatchOperation[]): void {
  services.ext.batchProviders = [...((services.ext.batchProviders as (() => BatchOperation[])[] | undefined) ?? []), provider];
}

export function batchOperations(services: Services): BatchOperation[] {
  const dynamic = ((services.ext.batchProviders as (() => BatchOperation[])[] | undefined) ?? []).flatMap((p) => p());
  return [...((services.ext.batchOperations as BatchOperation[] | undefined) ?? []), ...dynamic];
}

/* ------------------------------------------------------------------ */
/* Helpers for file operations                                        */
/* ------------------------------------------------------------------ */

const IMAGE_OUT = ['png', 'jpeg', 'webp', 'avif'] as const;
type ImageFormat = (typeof IMAGE_OUT)[number];

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'file';
}

async function assetOf(ctx: BatchRunContext, target: BatchTarget): Promise<AssetRecord> {
  if (!('assetId' in target)) throw new Error('This operation works on library files.');
  const a = await ctx.services.assets.get(target.assetId);
  if (!a) throw new Error('The file is no longer in the library.');
  return a;
}

async function sourceBytes(ctx: BatchRunContext, a: AssetRecord): Promise<Buffer> {
  const data = await ctx.services.blobs.get(a.id);
  if (!data) throw new Error('The file is missing from storage.');
  return data;
}

/** Store a result next to the original, tagged so the whole batch is easy to find. */
async function saveOutput(ctx: BatchRunContext, source: AssetRecord, data: Buffer | { file: string }, name: string, mime: string, op: string): Promise<BatchItemResult> {
  const options = { name, ownerId: ctx.user.id, mimeHint: mime, tags: [...new Set(['batch', ...ctx.outputTags])], source: { kind: 'generated' as const, tool: `batch:${op}`, fromAssetId: source.id } };
  const out = 'file' in data ? await ctx.services.assets.ingestFile(data.file, options) : await ctx.services.assets.ingestBuffer(data, options);
  // Results land in the same projects as their source, so they are easy to place.
  if (source.projectIds.length) await ctx.services.assets.update(out.id, { projectIds: [...new Set([...out.projectIds, ...source.projectIds])] });
  return { status: 'done', outputAssetId: out.id, outputName: out.name };
}

/** The format to write: the requested one, else the source's own when it is a web format, else PNG. */
function outFormat(a: AssetRecord, requested: string | undefined, transparent: boolean): ImageFormat {
  if (requested && (IMAGE_OUT as readonly string[]).includes(requested)) return requested as ImageFormat;
  const own = a.mime.split('/')[1] === 'jpg' ? 'jpeg' : (a.mime.split('/')[1] as string);
  if ((IMAGE_OUT as readonly string[]).includes(own) && !(own === 'jpeg' && transparent)) return own as ImageFormat;
  return 'png';
}

async function encode(r: Raster, format: ImageFormat, quality = 88): Promise<Buffer> {
  const img = sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), { raw: { width: r.width, height: r.height, channels: 4 } });
  switch (format) {
    case 'jpeg':
      return img.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
    case 'webp':
      return img.webp({ quality }).toBuffer();
    case 'avif':
      return img.avif({ quality: Math.round(quality * 0.7) }).toBuffer();
    default:
      return img.png({ compressionLevel: 8 }).toBuffer();
  }
}

function hasTransparency(r: Raster): boolean {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! < 255) return true;
  return false;
}

const zFormat = z.enum(IMAGE_OUT).optional().describe('Output format (default: same as the source)');

/** A pixel operation on pictures: decode, transform, save a new file. */
function imageOperation<P extends z.ZodRawShape>(def: Omit<BatchOperation<P>, 'run' | 'group' | 'kinds'> & { suffix: string | ((p: z.infer<z.ZodObject<P>>) => string); transform: (r: Raster, p: z.infer<z.ZodObject<P>>, ctx: BatchRunContext) => Promise<Raster> | Raster; forcePng?: boolean }): BatchOperation {
  return defineBatchOperation({
    ...def,
    group: 'image',
    kinds: ['image'],
    async run(ctx, target, params) {
      const a = await assetOf(ctx, target);
      if (a.mime === 'image/svg+xml') return { status: 'skipped', message: 'Vector (SVG) files are left as they are.' };
      const src = await decodeRaster(await sourceBytes(ctx, a));
      const out = await def.transform(src, params, ctx);
      const p = params as { format?: string; quality?: number };
      const format = def.forcePng ? 'png' : outFormat(a, p.format, hasTransparency(out));
      const suffix = typeof def.suffix === 'function' ? def.suffix(params) : def.suffix;
      return saveOutput(ctx, a, await encode(out, format, p.quality), `${baseName(a.name)}-${suffix}.${format === 'jpeg' ? 'jpg' : format}`, `image/${format}`, def.id);
    },
  });
}

async function lutFromAsset(ctx: BatchRunContext, assetId: string) {
  const lut = await ctx.services.assets.get(assetId);
  if (!lut || lut.kind !== 'lut') throw new Error('Pick a .cube LUT file from the library.');
  return { record: lut, lut: parseCubeLut((await sourceBytes(ctx, lut)).toString('utf8')) };
}

/** An ffmpeg operation on video or audio: run, then save the output file as a new asset. */
function mediaOperation<P extends z.ZodRawShape>(def: Omit<BatchOperation<P>, 'run'> & { suffix: string | ((p: z.infer<z.ZodObject<P>>) => string); ext: (a: AssetRecord, p: z.infer<z.ZodObject<P>>) => string; args: (input: string, output: string, a: AssetRecord, p: z.infer<z.ZodObject<P>>, ctx: BatchRunContext) => Promise<string[]> | string[] }): BatchOperation {
  return defineBatchOperation({
    ...def,
    async run(ctx, target, params) {
      const a = await assetOf(ctx, target);
      const input = await ctx.services.blobs.localPath(a.id);
      const ext = def.ext(a, params);
      const suffix = typeof def.suffix === 'function' ? def.suffix(params) : def.suffix;
      const out = path.join(os.tmpdir(), `omnix-batch-${crypto.randomBytes(6).toString('hex')}.${ext}`);
      try {
        await run(ctx.services.config.ffmpegPath, ['-v', 'error', '-y', '-i', input, ...(await def.args(input, out, a, params, ctx)), out], { timeoutMs: 30 * 60_000 });
        const mime = { mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }[ext] ?? a.mime;
        // The file moves into the library.
        return await saveOutput(ctx, a, { file: out }, `${baseName(a.name)}-${suffix}.${ext}`, mime, def.id);
      } catch (e) {
        await fs.rm(out, { force: true });
        throw e;
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* Built-in operations                                                */
/* ------------------------------------------------------------------ */

const ASPECTS = { '1:1': 1, '4:5': 4 / 5, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16, '2:3': 2 / 3 } as const;
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'] as const;

export function builtinBatchOperations(): BatchOperation[] {
  return [
    defineBatchOperation({
      id: 'image.resize',
      label: 'Resize',
      description: 'Fit pictures inside a size, or fill it exactly (cropping the overflow). Smaller pictures are not enlarged unless you allow it.',
      group: 'image',
      kinds: ['image'],
      params: { width: z.number().int().min(16).max(8000).optional(), height: z.number().int().min(16).max(8000).optional(), mode: z.enum(['fit', 'fill']).default('fit'), enlarge: z.boolean().default(false), format: zFormat, quality: z.number().int().min(1).max(100).default(88) },
      async run(ctx, target, p) {
        const a = await assetOf(ctx, target);
        if (!p.width && !p.height) throw new Error('Give a width, a height or both.');
        const img = sharp(await sourceBytes(ctx, a), { failOn: 'none', animated: false }).rotate();
        const meta = await img.metadata();
        const format = outFormat(a, p.format, !!meta.hasAlpha);
        const resized = img.resize({ ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}), fit: p.mode === 'fill' ? 'cover' : 'inside', withoutEnlargement: !p.enlarge });
        const data = await (format === 'jpeg' ? resized.flatten({ background: '#ffffff' }).jpeg({ quality: p.quality, mozjpeg: true }) : format === 'webp' ? resized.webp({ quality: p.quality }) : format === 'avif' ? resized.avif({ quality: Math.round(p.quality * 0.7) }) : resized.png()).toBuffer();
        const size = `${p.width ?? ''}x${p.height ?? ''}`.replace(/^x|x$/g, '');
        return saveOutput(ctx, a, data, `${baseName(a.name)}-${size}.${format === 'jpeg' ? 'jpg' : format}`, `image/${format}`, 'image.resize');
      },
    }),
    defineBatchOperation({
      id: 'image.convert',
      label: 'Convert format',
      description: 'Save pictures as PNG, JPEG, WebP or AVIF (JPEG puts transparent areas on white).',
      group: 'image',
      kinds: ['image'],
      params: { format: z.enum(IMAGE_OUT), quality: z.number().int().min(1).max(100).default(85) },
      async run(ctx, target, p) {
        const a = await assetOf(ctx, target);
        const r = await decodeRaster(await sourceBytes(ctx, a));
        return saveOutput(ctx, a, await encode(r, p.format, p.quality), `${baseName(a.name)}.${p.format === 'jpeg' ? 'jpg' : p.format}`, `image/${p.format}`, 'image.convert');
      },
    }),
    defineBatchOperation({
      id: 'image.crop',
      label: 'Crop to a shape',
      description: 'Crop pictures to an aspect ratio around their center (square for avatars, 9:16 for stories, 16:9 for slides).',
      group: 'image',
      kinds: ['image'],
      params: { aspect: z.enum(Object.keys(ASPECTS) as [keyof typeof ASPECTS, ...(keyof typeof ASPECTS)[]]), format: zFormat },
      async run(ctx, target, p) {
        const a = await assetOf(ctx, target);
        const img = sharp(await sourceBytes(ctx, a), { failOn: 'none' }).rotate();
        const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const ratio = ASPECTS[p.aspect];
        let w = info.width;
        let h = Math.round(w / ratio);
        if (h > info.height) {
          h = info.height;
          w = Math.round(h * ratio);
        }
        const left = Math.floor((info.width - w) / 2);
        const top = Math.floor((info.height - h) / 2);
        const cropped = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).extract({ left, top, width: w, height: h }).raw().toBuffer();
        const r = { width: w, height: h, data: new Uint8ClampedArray(cropped.buffer, cropped.byteOffset, cropped.byteLength) };
        const format = outFormat(a, p.format, hasTransparency(r));
        return saveOutput(ctx, a, await encode(r, format), `${baseName(a.name)}-${p.aspect.replace(':', 'x')}.${format === 'jpeg' ? 'jpg' : format}`, `image/${format}`, 'image.crop');
      },
    }),
    imageOperation({
      id: 'image.grade',
      label: 'Color grade',
      description: 'Adjust exposure (stops), contrast, saturation, temperature and tint the same way on every picture.',
      params: { exposure: z.number().min(-3).max(3).default(0), contrast: z.number().min(-100).max(100).default(0), saturation: z.number().min(-100).max(100).default(0), temperature: z.number().min(-100).max(100).default(0), tint: z.number().min(-100).max(100).default(0), format: zFormat },
      suffix: 'graded',
      transform: (r, p) => colorGrade(r, { exposure: p.exposure, contrast: p.contrast, saturation: p.saturation, temperature: p.temperature, tint: p.tint }),
    }),
    imageOperation({
      id: 'image.lut',
      label: 'Apply a LUT',
      description: 'Apply a .cube color look from the library to every picture.',
      params: { lutAssetId: z.string().describe('A LUT file in the library'), intensity: z.number().min(0).max(1).default(1), format: zFormat },
      suffix: 'look',
      transform: async (r, p, ctx) => applyLut3D(r, (await lutFromAsset(ctx, p.lutAssetId)).lut, p.intensity),
    }),
    imageOperation({
      id: 'image.filter',
      label: 'Filter',
      description: 'Blur, sharpen, grain, pixelate, black and white, sepia, vignette, emboss or edges.',
      params: { filter: z.enum(['gaussianBlur', 'sharpen', 'noise', 'pixelate', 'grayscale', 'sepia', 'vignette', 'emboss', 'edgeDetect']), amount: z.number().min(0).max(4).optional(), radius: z.number().min(0).max(200).optional(), format: zFormat },
      suffix: (p) => p.filter.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
      transform: (r, p) => applyFilter(r, p.filter as FilterKind, { ...(p.amount !== undefined ? { amount: p.amount } : {}), ...(p.radius !== undefined ? { radius: p.radius } : {}) }),
    }),
    imageOperation({
      id: 'image.watermark',
      label: 'Watermark',
      description: 'Write a line of text (a credit or copyright) into a corner of every picture.',
      params: { text: z.string().min(1).max(120), position: z.enum(CORNERS).default('bottom-right'), opacity: z.number().min(0.05).max(1).default(0.6), size: z.number().min(0.01).max(0.2).default(0.035).describe('Text height as a share of the picture width'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'), format: zFormat },
      suffix: 'marked',
      transform: (r, p) => {
        const c = createCanvas(r.width, r.height);
        const g = c.getContext('2d');
        g.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
        const px = Math.max(10, Math.round(r.width * p.size));
        const pad = Math.round(px * 0.8);
        g.font = `600 ${px}px Inter, sans-serif`;
        g.globalAlpha = p.opacity;
        g.fillStyle = p.color;
        g.shadowColor = 'rgba(0,0,0,0.45)';
        g.shadowBlur = px * 0.25;
        const w = g.measureText(p.text).width;
        const x = p.position.endsWith('left') ? pad : p.position === 'center' ? (r.width - w) / 2 : r.width - pad - w;
        const y = p.position.startsWith('top') ? pad + px : p.position === 'center' ? r.height / 2 + px / 3 : r.height - pad;
        g.fillText(p.text, x, y);
        const img = g.getImageData(0, 0, r.width, r.height);
        return { width: r.width, height: r.height, data: new Uint8ClampedArray(img.data) };
      },
    }),
    imageOperation({
      id: 'image.removeBackground',
      label: 'Remove background',
      description: 'Cut the subject out of every picture (transparent PNG). Auto finds the background from the edges; chroma removes a green or blue screen.',
      ai: true,
      params: { method: z.enum(['auto', 'chroma']).default('auto'), keyColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), tolerance: z.number().min(0).max(1).optional() },
      suffix: 'cutout',
      forcePng: true,
      transform: (r, p) => removeBackground(r, { method: p.method, ...(p.keyColor ? { keyColor: p.keyColor } : {}), ...(p.tolerance !== undefined ? { tolerance: p.tolerance } : {}) }).raster,
    }),
    imageOperation({
      id: 'image.upscale',
      label: 'Upscale',
      description: 'Enlarge pictures 2, 3 or 4 times with detail-preserving resampling.',
      ai: true,
      params: { factor: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2), format: zFormat },
      suffix: (p) => `${p.factor}x`,
      transform: (r, p) => {
        if (Math.max(r.width, r.height) * p.factor > 8192) throw new Error(`Too large to upscale ${p.factor}× (the result would pass 8192 pixels).`);
        return upscale(r, p.factor);
      },
    }),
    imageOperation({
      id: 'image.styleMatch',
      label: 'Match a reference look',
      description: 'Give every picture the color and tone of a reference picture from the library.',
      ai: true,
      params: { referenceAssetId: z.string().describe('A picture in the library'), strength: z.number().min(0).max(1).default(0.8), format: zFormat },
      suffix: 'matched',
      transform: async (r, p, ctx) => {
        const ref = await ctx.services.assets.get(p.referenceAssetId);
        if (!ref || ref.kind !== 'image') throw new Error('Pick a reference picture from the library.');
        const refRaster = await decodeRaster(await sharp(await sourceBytes(ctx, ref), { failOn: 'none' }).resize(512, 512, { fit: 'inside' }).png().toBuffer());
        const small = await decodeRaster(await sharp(await encode(r, 'png')).resize(512, 512, { fit: 'inside' }).png().toBuffer());
        return applyLut3D(r, styleLut(small, refRaster, { strength: p.strength }), 1);
      },
    }),
    mediaOperation({
      id: 'video.transcode',
      label: 'Convert video',
      description: 'Re-encode video as MP4 (H.264) or WebM (VP9), optionally scaled down to a maximum height.',
      group: 'video',
      kinds: ['video'],
      params: { format: z.enum(['mp4', 'webm']).default('mp4'), maxHeight: z.union([z.literal(2160), z.literal(1440), z.literal(1080), z.literal(720), z.literal(480)]).optional(), quality: z.enum(['high', 'balanced', 'small']).default('balanced') },
      suffix: (p) => `${p.maxHeight ? `${p.maxHeight}p` : 'converted'}`,
      ext: (_a, p) => p.format,
      args: (_i, _o, _a, p) => {
        const crf = { high: 18, balanced: 23, small: 30 }[p.quality];
        const scale = p.maxHeight ? ['-vf', `scale=-2:'min(${p.maxHeight},ih)'`] : [];
        return p.format === 'mp4' ? [...scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'] : [...scale, '-c:v', 'libvpx-vp9', '-crf', String(crf + 8), '-b:v', '0', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'];
      },
    }),
    mediaOperation({
      id: 'video.lut',
      label: 'Apply a LUT to video',
      description: 'Bake a .cube color look from the library into every video.',
      group: 'video',
      kinds: ['video'],
      params: { lutAssetId: z.string() },
      suffix: 'look',
      ext: () => 'mp4',
      args: async (_i, _o, _a, p, ctx) => {
        const { record } = await lutFromAsset(ctx, p.lutAssetId);
        const lutPath = await ctx.services.blobs.localPath(record.id);
        return ['-vf', `lut3d=file='${lutPath.replace(/'/g, "\\'")}'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'];
      },
    }),
    mediaOperation({
      id: 'video.extractAudio',
      label: 'Extract audio',
      description: 'Save the soundtrack of each video as an MP3.',
      group: 'video',
      kinds: ['video'],
      params: {},
      suffix: 'audio',
      ext: () => 'mp3',
      args: () => ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
    }),
    mediaOperation({
      id: 'audio.normalize',
      label: 'Even out loudness',
      description: 'Normalize loudness to a target (−14 LUFS for streaming and social, −16 for podcasts, −23 for broadcast).',
      group: 'audio',
      kinds: ['audio', 'video'],
      params: { lufs: z.union([z.literal(-14), z.literal(-16), z.literal(-23)]).default(-14) },
      suffix: (p) => `${-p.lufs}lufs`,
      ext: (a) => (a.kind === 'video' ? 'mp4' : a.mime === 'audio/wav' ? 'wav' : 'mp3'),
      args: (_i, _o, a, p) => [...(a.kind === 'video' ? ['-c:v', 'copy'] : []), '-af', `loudnorm=I=${p.lufs}:TP=-1.5:LRA=11`, ...(a.kind === 'video' ? ['-c:a', 'aac', '-b:a', '192k'] : a.mime === 'audio/wav' ? [] : ['-c:a', 'libmp3lame', '-q:a', '2'])],
    }),
    mediaOperation({
      id: 'audio.convert',
      label: 'Convert audio',
      description: 'Save audio as MP3, WAV or M4A (AAC).',
      group: 'audio',
      kinds: ['audio'],
      params: { format: z.enum(['mp3', 'wav', 'm4a']).default('mp3') },
      suffix: 'converted',
      ext: (_a, p) => p.format,
      args: (_i, _o, _a, p) => (p.format === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : p.format === 'm4a' ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'pcm_s16le']),
    }),
  ];
}
