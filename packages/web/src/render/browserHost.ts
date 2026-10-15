import type { CanvasLike, Drawable, RenderHost } from '@omnix/render';
import { parseCubeLut, type Lut3D, type Mask } from '@omnix/imaging';
import { get, type AssetSummary } from '../lib/api.js';

/** What this browser can decode (some builds ship without H.264/AAC). Probed once. */
let codecCache: { h264: boolean; vp9: boolean; aac: boolean } | null = null;
function codecs() {
  if (!codecCache) {
    const v = document.createElement('video');
    codecCache = {
      h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"') !== '',
      vp9: v.canPlayType('video/webm; codecs="vp9"') !== '',
      aac: v.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '',
    };
  }
  return codecCache;
}

type Entry<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error' };

/**
 * Render host for the browser. Media loads lazily: the first render shows placeholders,
 * and `subscribe` listeners fire when assets arrive so views can redraw.
 */
export class BrowserRenderHost implements RenderHost {
  fontFallback = '"Inter Variable", Inter, "Helvetica Neue", Arial, sans-serif';
  scheme: 'light' | 'dark' = 'light';
  private meta = new Map<string, Entry<AssetSummary>>();
  private images = new Map<string, Entry<ImageBitmap>>();
  private luts = new Map<string, Entry<Lut3D>>();
  private masks = new Map<string, Mask>();
  private videos = new Map<string, HTMLVideoElement>();
  private listeners = new Set<() => void>();
  /** Bumped whenever any media finishes loading (part of cache keys). */
  version = 0;

  /**
   * Where asset files come from: the signed-in API by default, or a public presentation link
   * (`/api/present/<shareId>/assets`) that only serves the media its deck uses.
   */
  constructor(private readonly base = '/api/assets') {}

  private url(id: string, path = '') {
    return `${this.base}/${id}${path}`;
  }
  private notifyQueued = false;

  createCanvas(width: number, height: number): CanvasLike {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    return c as unknown as CanvasLike;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.version++;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    requestAnimationFrame(() => {
      this.notifyQueued = false;
      for (const l of this.listeners) l();
    });
  }

  assetMeta(id: string): AssetSummary | null {
    const e = this.meta.get(id);
    if (e?.state === 'ready') return e.value;
    if (!e) {
      this.meta.set(id, { state: 'loading' });
      get<{ asset: AssetSummary }>(this.url(id)).then(
        (r) => {
          this.meta.set(id, { state: 'ready', value: r.asset });
          this.notify();
        },
        () => this.meta.set(id, { state: 'error' }),
      );
    }
    return null;
  }

  image(id: string): Drawable | null {
    const e = this.images.get(id);
    if (e?.state === 'ready') return e.value as unknown as Drawable;
    if (e) return null;
    this.images.set(id, { state: 'loading' });
    void (async () => {
      try {
        let meta = this.meta.get(id);
        if (!meta || meta.state !== 'ready') {
          const r = await get<{ asset: AssetSummary }>(this.url(id));
          this.meta.set(id, { state: 'ready', value: r.asset });
          meta = this.meta.get(id);
        }
        const kind = meta?.state === 'ready' ? meta.value.kind : 'image';
        const url = kind === 'image' ? this.url(id, '/file') : this.url(id, '/thumbnail');
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        const bitmap = await decodeImage(await res.blob(), meta?.state === 'ready' ? meta.value : undefined);
        this.images.set(id, { state: 'ready', value: bitmap });
        this.notify();
      } catch {
        this.images.set(id, { state: 'error' });
      }
    })();
    return null;
  }

  /** Preload an image and resolve when it is ready (used by tools that need pixels). */
  async imageAsync(id: string): Promise<ImageBitmap | null> {
    this.image(id);
    for (let i = 0; i < 600; i++) {
      const e = this.images.get(id);
      if (e?.state === 'ready') return e.value;
      if (e?.state === 'error') return null;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  /** Assets whose video the browser cannot decode; frames come from the server instead. */
  private frameFallback = new Set<string>();
  private serverFrames = new Map<string, { want: number; loading: number | null; frames: Map<number, ImageBitmap>; last: ImageBitmap | null }>();

  /** Whether this browser can play the asset's video (H.264 support varies by browser build). */
  canPlayVideo(id: string): boolean {
    if (this.frameFallback.has(id)) return false;
    const meta = this.meta.get(id);
    const mime = meta?.state === 'ready' ? meta.value.mime : 'video/mp4';
    const ok = mime.includes('webm') ? codecs().vp9 : codecs().h264;
    if (!ok) this.frameFallback.add(id);
    return ok;
  }

  /** URL for playing an asset's audio, falling back to an MP3 transcode when the codec is unsupported. */
  audioSource(id: string): string {
    const meta = this.meta.get(id);
    const m = meta?.state === 'ready' ? meta.value : null;
    if (m?.kind === 'audio' && document.createElement('audio').canPlayType(m.mime) !== '') return this.url(id, '/file');
    if (m?.kind === 'video' && codecs().aac && this.canPlayVideo(id)) return this.url(id, '/proxy');
    return this.url(id, '/audio');
  }

  /** Frame from the server at time t (quantized to the source frame rate); shows the nearest loaded frame meanwhile. */
  private serverFrame(id: string, time: number): Drawable | null {
    const fps = this.assetMeta(id)?.fps ?? 30;
    const frame = Math.max(0, Math.round(time * fps));
    let e = this.serverFrames.get(id);
    if (!e) {
      e = { want: frame, loading: null, frames: new Map(), last: null };
      this.serverFrames.set(id, e);
    }
    e.want = frame;
    const hit = e.frames.get(frame);
    if (hit) return hit as unknown as Drawable;
    const pump = () => {
      const st = this.serverFrames.get(id)!;
      if (st.loading !== null || st.frames.has(st.want)) return;
      const f = st.want;
      st.loading = f;
      fetch(this.url(id, `/frame?t=${(f / fps).toFixed(3)}&w=960`), { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((b) => createImageBitmap(b))
        .then((bmp) => {
          st.frames.set(f, bmp);
          st.last = bmp;
          // Keep memory bounded: drop the oldest frames.
          if (st.frames.size > 240) st.frames.delete(st.frames.keys().next().value!);
          this.notify();
        })
        .catch(() => {})
        .finally(() => {
          st.loading = null;
          if (st.want !== f) pump();
        });
    };
    pump();
    return (e.last as unknown as Drawable) ?? this.image(id);
  }

  /** URL of an asset's editing proxy (video playback in presentations). */
  proxySource(id: string): string {
    return this.url(id, '/proxy');
  }

  /** A video element on the editing proxy for an asset. */
  videoElement(id: string): HTMLVideoElement {
    let v = this.videos.get(id);
    if (!v) {
      v = document.createElement('video');
      v.src = this.url(id, '/proxy');
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      v.crossOrigin = 'use-credentials';
      // The renderer reads width/height for layout; mirror the intrinsic video size onto them.
      v.addEventListener('loadedmetadata', () => {
        v!.width = v!.videoWidth;
        v!.height = v!.videoHeight;
      });
      v.addEventListener('error', () => {
        this.frameFallback.add(id);
        this.notify();
      });
      v.addEventListener('seeked', () => this.notify());
      v.addEventListener('loadeddata', () => this.notify());
      this.videos.set(id, v);
    }
    return v;
  }

  videoFrame(id: string, time: number): Drawable | null {
    const meta = this.assetMeta(id);
    if (meta && meta.kind !== 'video') return this.image(id);
    if (meta && !this.canPlayVideo(id)) return this.serverFrame(id, time);
    const v = this.videoElement(id);
    if (v.readyState >= 2) {
      const fps = meta?.fps ?? 30;
      if (!v.seeking && Math.abs(v.currentTime - time) > 0.5 / fps && v.paused) v.currentTime = Math.max(0, time);
      return v as unknown as Drawable;
    }
    if (v.readyState === 0 && !v.seeking) v.currentTime = Math.max(0, time);
    return this.image(id);
  }

  lut(id: string): Lut3D | undefined {
    const e = this.luts.get(id);
    if (e?.state === 'ready') return e.value;
    if (!e) {
      this.luts.set(id, { state: 'loading' });
      fetch(this.url(id, '/file'), { credentials: 'same-origin' })
        .then((r) => r.text())
        .then((txt) => {
          this.luts.set(id, { state: 'ready', value: parseCubeLut(txt) });
          this.notify();
        })
        .catch(() => this.luts.set(id, { state: 'error' }));
    }
    return undefined;
  }

  mask(id: string): Mask | undefined {
    const cached = this.masks.get(id);
    if (cached) return cached;
    const img = this.image(id) as unknown as ImageBitmap | null;
    if (!img) return undefined;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const m = new Uint8ClampedArray(c.width * c.height);
    for (let p = 0; p < m.length; p++) m[p] = Math.round((data[p * 4]! * data[p * 4 + 3]!) / 255);
    const mask = { width: c.width, height: c.height, data: m };
    this.masks.set(id, mask);
    return mask;
  }

  /** Register a mask computed locally (before its asset upload finishes). */
  putMask(id: string, mask: Mask): void {
    this.masks.set(id, mask);
    this.notify();
  }

  /** Register a decoded image under an asset id (e.g. right after uploading it). */
  putImage(id: string, bitmap: ImageBitmap): void {
    this.images.set(id, { state: 'ready', value: bitmap });
    this.notify();
  }

  dispose(): void {
    for (const v of this.videos.values()) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    this.videos.clear();
    this.listeners.clear();
  }
}

/**
 * Decode a fetched picture. Browsers cannot make a bitmap from an SVG file directly, so SVG goes
 * through an image element, drawn at the size the library measured for it.
 */
export async function decodeImage(blob: Blob, size?: { width?: number | null; height?: number | null }): Promise<ImageBitmap> {
  if (!/svg/i.test(blob.type)) return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = Math.max(1, Math.round(size?.width || img.naturalWidth || 300));
    const height = Math.max(1, Math.round(size?.height || img.naturalHeight || 150));
    return await createImageBitmap(img, { resizeWidth: width, resizeHeight: height });
  } finally {
    URL.revokeObjectURL(url);
  }
}
