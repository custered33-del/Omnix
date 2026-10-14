import sharp from 'sharp';
import { createCanvas, ImageData as NapiImageData, type Canvas } from '@napi-rs/canvas';
import type { ProjectState } from '@omnix/core';
import { parseCubeLut, type Lut3D, type Mask } from '@omnix/imaging';
import { collectAssetNeeds, type CanvasLike, type Drawable, type RenderHost } from '@omnix/render';
import type { BlobStore } from '../storage/blobs.js';
import type { AssetPipeline, AssetRecord } from '../assets/pipeline.js';
import { extractFrame } from '../util/media.js';
import type { OmnixConfig } from '../config.js';

/** Small LRU cache keyed by string. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** Decode any image sharp understands into a canvas (works for AVIF, HEIC, TIFF, SVG...). */
export async function decodeToCanvas(data: Buffer, maxSize?: number): Promise<Canvas> {
  let img = sharp(data, { failOn: 'none' }).rotate().ensureAlpha();
  if (maxSize) img = img.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
  const { data: raw, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const c = createCanvas(info.width, info.height);
  const ctx = c.getContext('2d');
  const id = new NapiImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), info.width, info.height);
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Encode a canvas to a format with sharp (PNG/JPEG/WebP/AVIF) with color profile tagging. */
export async function encodeCanvas(c: CanvasLike, format: 'png' | 'jpeg' | 'webp' | 'avif', options: { quality?: number; colorProfile?: 'srgb' | 'display-p3' } = {}): Promise<Buffer> {
  const ctx = c.getContext('2d')!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  let s = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: c.width, height: c.height, channels: 4 } });
  s = s.withIccProfile(options.colorProfile === 'display-p3' ? 'p3' : 'srgb');
  const q = options.quality ?? 90;
  switch (format) {
    case 'png':
      return s.png({ compressionLevel: 8 }).toBuffer();
    case 'jpeg':
      return s.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    case 'webp':
      return s.webp({ quality: q }).toBuffer();
    case 'avif':
      return s.avif({ quality: Math.round(q * 0.7) }).toBuffer();
  }
}

/**
 * Server-side render host. Assets are decoded once and cached; video frames are extracted
 * with ffmpeg (from the editing proxy when one exists). Call `prepare` before rendering.
 */
export class ServerRenderHost implements RenderHost {
  scheme: 'light' | 'dark' = 'light';
  fontFallback = 'Inter, "DejaVu Sans", "Liberation Sans", sans-serif';
  private images = new Lru<Canvas>(64);
  private frames = new Lru<Canvas>(120);
  private luts = new Lru<Lut3D>(16);
  private masks = new Lru<Mask>(16);
  private records = new Map<string, AssetRecord>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly assets: AssetPipeline,
    private readonly config: OmnixConfig,
  ) {}

  createCanvas(width: number, height: number): CanvasLike {
    return createCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height))) as unknown as CanvasLike;
  }

  image(assetId: string): Drawable | null {
    return (this.images.get(assetId) as unknown as Drawable) ?? null;
  }

  videoFrame(assetId: string, time: number): Drawable | null {
    const rec = this.records.get(assetId);
    const key = `${assetId}@${frameKey(time, rec?.fps)}`;
    return (this.frames.get(key) as unknown as Drawable) ?? this.image(assetId);
  }

  lut(assetId: string): Lut3D | undefined {
    return this.luts.get(assetId);
  }

  mask(assetId: string): Mask | undefined {
    return this.masks.get(assetId);
  }

  /** Load every asset a render of `rootId` (at `time`) needs. Missing assets are skipped. */
  async prepare(state: ProjectState, rootId: string, time?: number): Promise<void> {
    const needs = collectAssetNeeds(state, rootId, time);
    await Promise.all([...needs.images].map((id) => this.loadAsset(id)));
    await Promise.all(needs.frames.map((f) => this.loadFrame(f.assetId, f.time)));
  }

  async loadAsset(id: string): Promise<void> {
    if (this.images.get(id) || this.luts.get(id) || this.masks.get(id)) return;
    const rec = await this.assets.get(id);
    if (!rec) return;
    this.records.set(id, rec);
    try {
      if (rec.kind === 'image') {
        const data = await this.blobs.get(id);
        if (!data) return;
        const c = await decodeToCanvas(data, 8192);
        this.images.set(id, c);
        // Grayscale images double as selection masks.
        const ctx = c.getContext('2d');
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const m = new Uint8ClampedArray(c.width * c.height);
        for (let p = 0; p < m.length; p++) m[p] = Math.round((img.data[p * 4]! * img.data[p * 4 + 3]!) / 255);
        this.masks.set(id, { width: c.width, height: c.height, data: m });
      } else if (rec.kind === 'video') {
        const thumb = rec.thumbnailBlob ? await this.blobs.get(rec.thumbnailBlob) : null;
        if (thumb) this.images.set(id, await decodeToCanvas(thumb));
      } else if (rec.kind === 'lut') {
        const data = await this.blobs.get(id);
        if (data) this.luts.set(id, parseCubeLut(data.toString('utf8')));
      }
    } catch {
      // Undecodable media renders as empty rather than failing the whole frame.
    }
  }

  async loadFrame(assetId: string, time: number): Promise<void> {
    let rec = this.records.get(assetId);
    if (!rec) {
      rec = await this.assets.get(assetId);
      if (!rec) return;
      this.records.set(assetId, rec);
    }
    if (rec.kind !== 'video') return;
    const key = `${assetId}@${frameKey(time, rec.fps)}`;
    if (this.frames.get(key)) return;
    try {
      const source = rec.proxyBlob ? await this.blobs.localPath(rec.proxyBlob) : await this.blobs.localPath(assetId);
      const png = await extractFrame(this.config.ffmpegPath, source, time, 1920);
      this.frames.set(key, await decodeToCanvas(png));
    } catch {
      // Leave the poster frame in place.
    }
  }

  /** Inject a decoded frame directly (used by the streaming video exporter). */
  putFrame(assetId: string, time: number, canvas: Canvas, fps?: number): void {
    this.frames.set(`${assetId}@${frameKey(time, fps ?? this.records.get(assetId)?.fps)}`, canvas);
  }
}

function frameKey(time: number, fps?: number): string {
  const f = fps && fps > 0 ? fps : 30;
  return String(Math.round(time * f));
}
