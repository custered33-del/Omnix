import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createCanvas, ImageData as NapiImageData, type Canvas } from '@napi-rs/canvas';

/**
 * Streaming video decoders for export. Each decoder reads one source file forward at a
 * fixed rate and hands out frames by timestamp; seeking backwards restarts it.
 */
export interface DecoderSource {
  path: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

class FrameReader {
  private buffers: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private waiters: (() => void)[] = [];
  readonly frameBytes: number;

  constructor(
    readonly proc: ChildProcessWithoutNullStreams,
    w: number,
    h: number,
  ) {
    this.frameBytes = w * h * 4;
    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffers.push(chunk);
      this.buffered += chunk.length;
      if (this.buffered > this.frameBytes * 4) proc.stdout.pause();
      this.wake();
    });
    proc.stdout.on('end', () => {
      this.ended = true;
      this.wake();
    });
    proc.on('error', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async next(): Promise<Buffer | null> {
    while (this.buffered < this.frameBytes) {
      if (this.ended) return null;
      this.proc.stdout.resume();
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const all = this.buffers.length === 1 ? this.buffers[0]! : Buffer.concat(this.buffers);
    const frame = Buffer.from(all.subarray(0, this.frameBytes));
    const rest = all.subarray(this.frameBytes);
    this.buffers = rest.length ? [rest] : [];
    this.buffered = rest.length;
    if (this.buffered < this.frameBytes * 2) this.proc.stdout.resume();
    return frame;
  }

  kill(): void {
    try {
      this.proc.kill('SIGKILL');
    } catch {
      // gone
    }
  }
}

interface ActiveDecoder {
  reader: FrameReader;
  startTime: number;
  index: number;
  last: Canvas | null;
  lastIndex: number;
}

export class DecoderPool {
  private decoders = new Map<string, ActiveDecoder>();
  private sizes = new Map<string, { w: number; h: number }>();

  constructor(
    private readonly ffmpeg: string,
    private readonly maxW: number,
    private readonly maxH: number,
  ) {}

  private size(src: DecoderSource): { w: number; h: number } {
    const key = src.path;
    const cached = this.sizes.get(key);
    if (cached) return cached;
    const s = Math.min(1, this.maxW / src.width, this.maxH / src.height);
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const size = { w: even(src.width * s), h: even(src.height * s) };
    this.sizes.set(key, size);
    return size;
  }

  private start(key: string, src: DecoderSource, time: number): ActiveDecoder {
    const { w, h } = this.size(src);
    const t0 = Math.max(0, time - 0.001);
    const proc = spawn(this.ffmpeg, ['-v', 'error', '-ss', t0.toFixed(4), '-i', src.path, '-an', '-vf', `fps=${src.fps},scale=${w}:${h}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stderr.resume();
    const d: ActiveDecoder = { reader: new FrameReader(proc, w, h), startTime: t0, index: -1, last: null, lastIndex: -1 };
    this.decoders.set(key, d);
    return d;
  }

  /** The decoded frame nearest to `time` (seconds in the source), or null past the end. */
  async frameAt(key: string, src: DecoderSource, time: number): Promise<Canvas | null> {
    const { w, h } = this.size(src);
    const t = Math.min(Math.max(0, time), Math.max(0, src.duration - 1 / src.fps));
    let d = this.decoders.get(key);
    const want = (dec: ActiveDecoder) => Math.round((t - dec.startTime) * src.fps);
    // Restart when seeking backwards or far ahead (more than 3 s of decoding).
    if (!d || want(d) < d.lastIndex || want(d) - d.index > src.fps * 3) {
      d?.reader.kill();
      d = this.start(key, src, t);
    }
    const target = Math.max(0, want(d));
    if (d.lastIndex === target && d.last) return d.last;
    let buf: Buffer | null = null;
    while (d.index < target) {
      buf = await d.reader.next();
      if (!buf) break;
      d.index++;
    }
    if (!buf) return d.last;
    const c = createCanvas(w, h);
    c.getContext('2d').putImageData(new NapiImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), w, h), 0, 0);
    d.last = c;
    d.lastIndex = target;
    return c;
  }

  closeAll(): void {
    for (const d of this.decoders.values()) d.reader.kill();
    this.decoders.clear();
  }
}
