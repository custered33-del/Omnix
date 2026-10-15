import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import { createCanvas } from '@napi-rs/canvas';
import { parseCubeLut, applyLut3D, createRaster } from '@omnix/imaging';
import type { DocStore } from '../storage/store.js';
import { C } from '../storage/store.js';
import type { BlobStore } from '../storage/blobs.js';
import { sha256File } from '../storage/blobs.js';
import type { OmnixConfig } from '../config.js';
import { extractFrame, makeProxy, probe, waveformPeaks, type MediaInfo } from '../util/media.js';
import type { JobQueue } from '../jobs/queue.js';
import { analyzeAsset } from './library.js';

export type AssetKind = 'image' | 'video' | 'audio' | 'lut' | 'font' | 'text' | 'data' | 'other';

export interface AssetRecord {
  /** SHA-256 of the file content. Identical files share one record (deduplication). */
  id: string;
  name: string;
  mime: string;
  kind: AssetKind;
  size: number;
  owners: string[];
  projectIds: string[];
  tags: string[];
  /** Tags Omnix works out itself (orientation, main colors, length, transparency...). */
  autoTags?: string[];
  /** Perceptual fingerprint of pictures and video frames, for finding near-duplicates. */
  phash?: string;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  hasAudio?: boolean;
  videoCodec?: string | null;
  audioCodec?: string | null;
  colorProfile?: string | null;
  colorSpace?: string | null;
  exif?: Record<string, string | number>;
  lutSize?: number;
  thumbnailBlob?: string | null;
  proxyBlob?: string | null;
  /** MP3 of the audio track, made on demand for browsers without the original codec. */
  audioProxyBlob?: string | null;
  proxyStatus: 'none' | 'pending' | 'ready' | 'failed';
  waveform?: number[];
  source: { kind: 'upload' | 'url' | 'generated' | 'export' | 'code' | 'import'; url?: string; prompt?: string; tool?: string; projectId?: string };
  createdAt: string;
  updatedAt: string;
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/opus',
  cube: 'application/x-cube-lut',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  ppt: 'application/vnd.ms-powerpoint',
  pps: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
  key: 'application/x-iwork-keynote-sffkey',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  lottie: 'application/json',
  psd: 'image/vnd.adobe.photoshop',
};

/** Sniff the real type from magic bytes; fall back to the extension. */
export function detectMime(head: Buffer, filename: string, hint?: string): string {
  const b = head;
  const at = (i: number, s: string) => b.subarray(i, i + s.length).toString('latin1') === s;
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(4, 'ftyp')) {
    const brand = b.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return filename.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/webm';
  if (at(0, 'ID3') || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (at(0, '%PDF')) return 'application/pdf';
  if (at(0, '8BPS')) return 'image/vnd.adobe.photoshop';
  if (at(0, 'wOF2')) return 'font/woff2';
  if (at(0, 'wOFF')) return 'font/woff';
  if (at(0, 'OTTO')) return 'font/otf';
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'font/ttf';
  if (at(0, 'PK')) {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return EXT_MIME[ext] ?? 'application/zip';
  }
  const text = b.subarray(0, 256).toString('utf8').trimStart();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? hint ?? 'application/octet-stream';
}

export function kindOf(mime: string): AssetKind {
  if (mime === 'application/x-cube-lut') return 'lut';
  if (mime.startsWith('image/') && mime !== 'image/vnd.adobe.photoshop') return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('font/')) return 'font';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json') return 'data';
  return 'other';
}

/** Browser-playable codecs; anything else gets an editing proxy. */
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);

export interface IngestOptions {
  name: string;
  mimeHint?: string;
  ownerId: string;
  projectId?: string;
  tags?: string[];
  source?: AssetRecord['source'];
}

export class AssetPipeline {
  constructor(
    private readonly store: DocStore,
    private readonly blobs: BlobStore,
    private readonly config: OmnixConfig,
    private readonly jobs: JobQueue,
    private readonly onChange: (a: AssetRecord) => void = () => {},
  ) {
    jobs.register<{ assetId: string }, { proxyBlob: string }>('asset.proxy', async (ctx) => {
      const a = await this.get(ctx.job.input.assetId);
      if (!a) throw new Error('Asset disappeared');
      const src = await this.blobs.localPath(a.id);
      const out = path.join(os.tmpdir(), `omnix-proxy-${crypto.randomBytes(6).toString('hex')}.mp4`);
      try {
        await makeProxy(this.config.ffmpegPath, src, out, 540, (s) => ctx.progress(a.duration ? s / a.duration : 0, 'Transcoding proxy'));
        const proxyBlob = await this.blobs.putFile(out);
        await this.update(a.id, { proxyBlob, proxyStatus: 'ready' });
        return { proxyBlob };
      } catch (e) {
        await this.update(a.id, { proxyStatus: 'failed' });
        throw e;
      } finally {
        await fs.rm(out, { force: true });
      }
    });
  }

  async get(id: string): Promise<AssetRecord | undefined> {
    return this.store.get<AssetRecord>(C.assets, id);
  }

  async update(id: string, patch: Partial<AssetRecord>): Promise<AssetRecord> {
    const a = await this.get(id);
    if (!a) throw new Error(`Asset not found: ${id}`);
    const next = { ...a, ...patch, updatedAt: new Date().toISOString() };
    await this.store.put(C.assets, id, next);
    this.onChange(next);
    return next;
  }

  async list(): Promise<AssetRecord[]> {
    return this.store.list<AssetRecord>(C.assets);
  }

  /** Ingest bytes already in memory (generated images, exports, code outputs). */
  async ingestBuffer(data: Buffer, options: IngestOptions): Promise<AssetRecord> {
    const tmp = path.join(os.tmpdir(), `omnix-ingest-${crypto.randomBytes(8).toString('hex')}`);
    await fs.writeFile(tmp, data);
    return this.ingestFile(tmp, options);
  }

  /** Ingest a file on disk (moved into the blob store). Deduplicates by content hash. */
  async ingestFile(tempPath: string, options: IngestOptions, knownHash?: string): Promise<AssetRecord> {
    const hash = knownHash ?? (await sha256File(tempPath));
    const existing = await this.get(hash);
    if (existing) {
      await fs.rm(tempPath, { force: true });
      const owners = existing.owners.includes(options.ownerId) ? existing.owners : [...existing.owners, options.ownerId];
      const projectIds = options.projectId && !existing.projectIds.includes(options.projectId) ? [...existing.projectIds, options.projectId] : existing.projectIds;
      const tags = [...new Set([...existing.tags, ...(options.tags ?? [])])];
      return this.update(hash, { owners, projectIds, tags });
    }
    const fh = await fs.open(tempPath, 'r');
    const head = Buffer.alloc(512);
    await fh.read(head, 0, 512, 0);
    await fh.close();
    const stat = await fs.stat(tempPath);
    const mime = detectMime(head, options.name, options.mimeHint);
    const kind = kindOf(mime);
    const now = new Date().toISOString();
    const record: AssetRecord = {
      id: hash,
      name: sanitizeName(options.name),
      mime,
      kind,
      size: stat.size,
      owners: [options.ownerId],
      projectIds: options.projectId ? [options.projectId] : [],
      tags: [...new Set(options.tags ?? [])],
      proxyStatus: 'none',
      source: options.source ?? { kind: 'upload' },
      createdAt: now,
      updatedAt: now,
    };
    // Extract metadata before moving the file (works on the temp path).
    try {
      if (kind === 'image') await this.describeImage(tempPath, record);
      else if (kind === 'video' || kind === 'audio') await this.describeMedia(tempPath, record);
      else if (kind === 'lut') await this.describeLut(tempPath, record);
    } catch (e) {
      // Metadata failure should not block storing the file; the record notes what is missing.
      record.tags.push('metadata-unavailable');
      if (this.config.dev) console.warn(`[assets] metadata extraction failed for ${options.name}:`, e instanceof Error ? e.message : e);
    }
    try {
      Object.assign(record, await analyzeAsset(this.blobs, record));
    } catch {
      record.autoTags = [];
    }
    await this.blobs.putFile(tempPath, hash);
    await this.store.put(C.assets, hash, record);
    this.onChange(record);
    if (record.proxyStatus === 'pending') {
      await this.jobs.enqueue('asset.proxy', { assetId: hash }, { title: `Proxy for ${record.name}`, ownerId: options.ownerId, projectId: options.projectId ?? null });
    }
    return record;
  }

  private async describeImage(file: string, r: AssetRecord): Promise<void> {
    const img = sharp(file, { animated: false, failOn: 'none' });
    const meta = await img.metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    r.width = rotated ? meta.height : meta.width;
    r.height = rotated ? meta.width : meta.height;
    r.colorSpace = meta.space ?? null;
    r.colorProfile = meta.icc ? iccDescription(meta.icc) ?? 'embedded' : meta.space === 'srgb' ? 'sRGB (assumed)' : null;
    if (meta.exif) r.exif = summarizeExif(meta.exif);
    const thumb = await sharp(file, { failOn: 'none' }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    r.thumbnailBlob = await this.blobs.put(thumb);
  }

  private async describeMedia(file: string, r: AssetRecord): Promise<void> {
    const info: MediaInfo = await probe(this.config.ffprobePath, file);
    r.duration = info.duration;
    r.hasAudio = info.hasAudio;
    r.audioCodec = info.audioCodec;
    if (info.hasVideo) {
      r.kind = 'video';
      r.width = info.width ?? undefined;
      r.height = info.height ?? undefined;
      r.fps = info.fps ?? undefined;
      r.videoCodec = info.videoCodec;
      r.colorSpace = info.colorSpace;
      const frame = await extractFrame(this.config.ffmpegPath, file, Math.min(1, info.duration * 0.1), 640);
      r.thumbnailBlob = await this.blobs.put(await sharp(frame).resize(320, 320, { fit: 'inside' }).webp({ quality: 78 }).toBuffer());
      const needsProxy = (info.height ?? 0) > 720 || !PLAYABLE_VIDEO.has(info.videoCodec ?? '');
      r.proxyStatus = needsProxy ? 'pending' : 'none';
    } else {
      r.kind = 'audio';
    }
    if (info.hasAudio) {
      r.waveform = await waveformPeaks(this.config.ffmpegPath, file, 600);
      if (r.kind === 'audio') r.thumbnailBlob = await this.blobs.put(await waveformImage(r.waveform));
    }
  }

  private async describeLut(file: string, r: AssetRecord): Promise<void> {
    const lut = parseCubeLut(await fs.readFile(file, 'utf8'));
    r.lutSize = lut.size;
    // Preview: a hue/lightness gradient pushed through the LUT.
    const g = createRaster(256, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const h = (x / 256) * 6;
        const l = 1 - y / 80;
        const c = [Math.abs(h - 3) - 1, 2 - Math.abs(h - 2), 2 - Math.abs(h - 4)].map((v) => Math.max(0, Math.min(1, v)) * l * 255);
        g.data[i] = c[0]!;
        g.data[i + 1] = c[1]!;
        g.data[i + 2] = c[2]!;
        g.data[i + 3] = 255;
      }
    const out = applyLut3D(g, lut, 1);
    r.thumbnailBlob = await this.blobs.put(await sharp(Buffer.from(out.data.buffer), { raw: { width: 256, height: 64, channels: 4 } }).webp().toBuffer());
  }
}

function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
}

function iccDescription(icc: Buffer): string | null {
  // ICC 'desc' tag (v2 textDescriptionType or v4 multiLocalizedUnicodeType).
  try {
    const count = icc.readUInt32BE(128);
    for (let i = 0; i < count; i++) {
      const off = 132 + i * 12;
      const sig = icc.subarray(off, off + 4).toString('latin1');
      if (sig !== 'desc') continue;
      const start = icc.readUInt32BE(off + 4);
      const type = icc.subarray(start, start + 4).toString('latin1');
      if (type === 'desc') {
        const len = icc.readUInt32BE(start + 8);
        return icc.subarray(start + 12, start + 12 + len - 1).toString('latin1').trim();
      }
      if (type === 'mluc') {
        const recLen = icc.readUInt32BE(start + 20);
        const strOff = icc.readUInt32BE(start + 24);
        const raw = icc.subarray(start + strOff, start + strOff + recLen);
        let s = '';
        for (let j = 0; j + 1 < raw.length; j += 2) s += String.fromCharCode(raw.readUInt16BE(j));
        return s.trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Keep a useful, privacy-conscious subset of EXIF (no GPS coordinates). */
function summarizeExif(buf: Buffer): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  try {
    const e = exifReader(buf) as unknown as Record<string, Record<string, unknown> | undefined>;
    const img = e.Image ?? e.image ?? {};
    const photo = e.Photo ?? e.exif ?? {};
    const pick = (src: Record<string, unknown>, key: string, as = key) => {
      const v = src[key];
      if (v === undefined || v === null) return;
      if (v instanceof Date) out[as] = v.toISOString();
      else if (typeof v === 'number' || typeof v === 'string') out[as] = typeof v === 'string' ? v.replace(/\u0000/g, '').trim() : v;
    };
    pick(img, 'Make');
    pick(img, 'Model');
    pick(img, 'Software');
    pick(img, 'Orientation');
    pick(photo, 'DateTimeOriginal');
    pick(photo, 'ExposureTime');
    pick(photo, 'FNumber');
    pick(photo, 'ISOSpeedRatings', 'ISO');
    pick(photo, 'FocalLength');
    pick(photo, 'LensModel');
    if (e.GPSInfo || e.gps) out.HasGPS = 'yes (not shown)';
  } catch {
    // Corrupt EXIF is ignored.
  }
  return out;
}

async function waveformImage(peaks: number[]): Promise<Buffer> {
  const w = 320;
  const h = 120;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#eef1f8';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#3b5bdb';
  for (let x = 0; x < w; x++) {
    const p = peaks[Math.floor((x / w) * peaks.length)] ?? 0;
    const bh = Math.max(1, p * (h - 16));
    ctx.fillRect(x, (h - bh) / 2, 1, bh);
  }
  return sharp(c.toBuffer('image/png')).webp({ quality: 80 }).toBuffer();
}
