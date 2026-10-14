import { spawn } from 'node:child_process';

/** Thin, promise-based wrappers around ffmpeg/ffprobe with timeouts and captured errors. */

export interface MediaInfo {
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  pixelFormat: string | null;
  colorSpace: string | null;
  rotation: number;
  container: string | null;
}

export class MediaError extends Error {
  constructor(message: string, readonly stderr = '') {
    super(message);
    this.name = 'MediaError';
  }
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export function run(cmd: string, args: string[], options: { input?: Buffer; timeoutMs?: number; onStderr?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new MediaError(`${cmd} timed out after ${options.timeoutMs}ms`, err));
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      if (options.onStderr) for (const line of s.split(/\r|\n/)) if (line.trim()) options.onStderr(line);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new MediaError(`${cmd} could not start: ${e.message}. Is it installed?`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new MediaError(`${cmd} exited with code ${code}: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`, err));
    });
    child.stdin.on('error', () => {});
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function parseRate(r: string | undefined): number | null {
  if (!r || r === '0/0') return null;
  const [a, b] = r.split('/').map(Number);
  if (!a || !b) return null;
  return Math.round((a / b) * 1000) / 1000;
}

export async function probe(ffprobe: string, file: string): Promise<MediaInfo> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  const j = JSON.parse(stdout.toString()) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type: string; codec_name?: string; disposition?: { attached_pic?: number }; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; sample_rate?: string; channels?: number; pix_fmt?: string; color_space?: string; duration?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[];
  };
  // Cover art in audio files is a 'video' stream flagged as an attached picture; ignore it.
  const v = j.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const rotation = Number(v?.tags?.rotate ?? v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0);
  const duration = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  const swap = Math.abs(rotation) % 180 === 90;
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: v ? (swap ? v.height ?? null : v.width ?? null) : null,
    height: v ? (swap ? v.width ?? null : v.height ?? null) : null,
    fps: v ? parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate) : null,
    hasVideo: !!v,
    hasAudio: !!a,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    channels: a?.channels ?? null,
    pixelFormat: v?.pix_fmt ?? null,
    colorSpace: v?.color_space ?? null,
    rotation,
    container: j.format?.format_name ?? null,
  };
}

/** Extract one frame as PNG or JPEG (optionally scaled to a max width). */
export async function extractFrame(ffmpeg: string, file: string, time: number, maxWidth?: number, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  const args = ['-v', 'error', '-ss', Math.max(0, time).toFixed(3), '-i', file, '-frames:v', '1'];
  if (maxWidth) args.push('-vf', `scale='min(${maxWidth},iw)':-2`);
  args.push('-f', 'image2pipe', '-vcodec', format === 'png' ? 'png' : 'mjpeg');
  if (format === 'jpeg') args.push('-q:v', '4');
  args.push('pipe:1');
  const { stdout } = await run(ffmpeg, args, { timeoutMs: 60_000 });
  if (!stdout.length) {
    // Seeking past the last keyframe can yield nothing; retry slightly earlier.
    if (time > 0.1) return extractFrame(ffmpeg, file, Math.max(0, time - 0.5), maxWidth, format);
    throw new MediaError('No frame decoded');
  }
  return stdout;
}

/** MP3 audio track for browsers that cannot decode the original audio codec. */
export async function makeAudioProxy(ffmpeg: string, file: string, out: string): Promise<void> {
  await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', out], { timeoutMs: 30 * 60_000 });
}

/** Transcode a browser-friendly, low-resolution editing proxy (H.264 + AAC, fast start). */
export async function makeProxy(ffmpeg: string, file: string, out: string, height = 540, onProgress?: (seconds: number) => void): Promise<void> {
  await run(
    ffmpeg,
    ['-v', 'error', '-stats', '-y', '-i', file, '-vf', `scale=-2:'min(${height},ih)'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out],
    {
      timeoutMs: 60 * 60_000,
      onStderr: (line) => {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(line);
        if (m && onProgress) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      },
    },
  );
}

/** Peak amplitudes (0..1) for drawing waveforms, `points` buckets across the whole file. */
export async function waveformPeaks(ffmpeg: string, file: string, points = 800): Promise<number[]> {
  const rate = 4000;
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { timeoutMs: 10 * 60_000 });
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  if (samples.length === 0) return new Array(points).fill(0);
  const per = Math.max(1, Math.floor(samples.length / points));
  const peaks: number[] = [];
  for (let i = 0; i < points; i++) {
    let m = 0;
    const start = i * per;
    const end = Math.min(samples.length, start + per);
    for (let j = start; j < end; j++) m = Math.max(m, Math.abs(samples[j]!));
    peaks.push(Math.round(Math.min(1, m) * 1000) / 1000);
  }
  return peaks;
}

/** Decode audio to mono float samples (for captions/VAD). */
export async function decodeAudioMono(ffmpeg: string, file: string, rate = 16000): Promise<Float32Array> {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { timeoutMs: 10 * 60_000 });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + Math.floor(stdout.byteLength / 4) * 4));
}

export async function ffmpegAvailable(ffmpeg: string): Promise<boolean> {
  try {
    await run(ffmpeg, ['-version'], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}
