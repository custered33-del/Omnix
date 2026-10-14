import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ProjectState } from '@omnix/core';
import { contentDuration, requireNodeOfType } from '@omnix/core';
import { renderSequenceFrame, type CanvasLike, type Drawable, type RenderHost } from '@omnix/render';
import { buildAudioGraph, buildExportArgs, outputSize, presetById, type VideoPreset } from '@omnix/exporters';
import type { Services } from '../services.js';
import type { ServerRenderHost } from '../render/serverHost.js';
import { DecoderPool, type DecoderSource } from './decoders.js';

export interface VideoExportOptions {
  presetId: string;
  /** Export a range (defaults to the whole sequence content). */
  start?: number;
  end?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export interface VideoExportResult {
  path: string;
  preset: VideoPreset;
  width: number;
  height: number;
  duration: number;
  frames: number;
}

/**
 * Render a sequence to a video file. Every frame goes through the same renderer as the
 * editor preview, so effects, titles, transitions and keyframes look identical.
 */
export async function exportVideo(services: Services, state: ProjectState, sequenceId: string, options: VideoExportOptions): Promise<VideoExportResult> {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  const preset = presetById(options.presetId);
  const sp = seq.props;
  const fps = preset.fps ?? sp.fps;
  const start = Math.max(0, options.start ?? 0);
  const contentEnd = contentDuration(state, sequenceId) || sp.duration;
  let end = Math.min(options.end ?? contentEnd, preset.maxDuration ? start + preset.maxDuration : Infinity);
  if (!(end > start)) end = start + 1 / fps;
  const duration = end - start;
  const frames = Math.max(1, Math.round(duration * fps));
  // Render frames at the output resolution when it is smaller than the sequence (faster), else at sequence size.
  const out = outputSize(preset, sp.width, sp.height);
  const scale = preset.video ? Math.min(1, Math.max(out.width / sp.width, out.height / sp.height)) : 0.0625;
  const frameW = Math.max(2, Math.round((sp.width * scale) / 2) * 2);
  const frameH = Math.max(2, Math.round((sp.height * scale) / 2) * 2);

  const host = services.renderHost();
  await host.prepare(state, sequenceId);
  const assetInfo = new Map<string, DecoderSource & { hasAudio: boolean }>();
  for (const a of await collectMedia(services, state)) assetInfo.set(a.id, a);

  const ext = preset.container;
  const outPath = path.join(os.tmpdir(), `omnix-export-${crypto.randomBytes(6).toString('hex')}.${ext}`);
  const audio = buildAudioGraph(state, sequenceId, (id) => assetInfo.get(id) ?? null, { inputOffset: preset.video ? 1 : 0, duration });
  // Shift the audio graph when exporting a range that does not start at 0.
  if (start > 0 && audio.filter) audio.filter = audio.filter.replace(/\[aout\]$/, `,atrim=start=${start.toFixed(4)},asetpts=PTS-STARTPTS[aout]`).replace(/atrim=end=[\d.]+/, `atrim=end=${end.toFixed(4)}`);
  const args = buildExportArgs(preset, { frameWidth: frameW, frameHeight: frameH, fps, duration, audio, outputPath: outPath });
  const proc = spawn(services.config.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-8000);
  });
  const exited = new Promise<number>((resolve) => proc.on('close', (code) => resolve(code ?? 1)));
  proc.stdin.on('error', () => {});

  const pool = new DecoderPool(services.config.ffmpegPath, frameW, frameH);
  try {
    if (preset.video) {
      for (let i = 0; i < frames; i++) {
        if (options.signal?.aborted) throw new Error('Export cancelled');
        const t = start + i / fps;
        const canvas = await renderWithFrames(host, state, sequenceId, t, scale, assetInfo, pool);
        const ctx = canvas.getContext('2d')!;
        const img = ctx.getImageData(0, 0, frameW, frameH);
        const ok = proc.stdin.write(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
        if (!ok) await new Promise<void>((r) => proc.stdin.once('drain', r));
        if (i % 5 === 0) options.onProgress?.(i / frames, `Rendering frame ${i + 1} of ${frames}`);
      }
    }
    proc.stdin.end();
    options.onProgress?.(0.99, 'Finishing encode');
    const code = await exited;
    if (code !== 0) throw new Error(`Encoding failed: ${stderr.split('\n').filter((l) => l.trim() && !l.startsWith('frame=')).slice(-3).join(' | ')}`);
    return { path: outPath, preset, width: preset.video ? outputSize(preset, frameW, frameH).width : 0, height: preset.video ? outputSize(preset, frameW, frameH).height : 0, duration, frames };
  } catch (e) {
    proc.kill('SIGKILL');
    await fs.rm(outPath, { force: true });
    throw e;
  } finally {
    pool.closeAll();
  }
}

async function collectMedia(services: Services, state: ProjectState): Promise<(DecoderSource & { id: string; hasAudio: boolean })[]> {
  const ids = new Set<string>();
  for (const n of Object.values(state.nodes)) if (n.type === 'clip' && (n.props as { assetId: string | null }).assetId) ids.add((n.props as { assetId: string }).assetId);
  const out: (DecoderSource & { id: string; hasAudio: boolean })[] = [];
  for (const id of ids) {
    const a = await services.assets.get(id);
    if (!a || (a.kind !== 'video' && a.kind !== 'audio')) continue;
    out.push({ id, path: await services.blobs.localPath(id), width: a.width ?? 0, height: a.height ?? 0, fps: a.fps ?? 30, duration: a.duration ?? 0, hasAudio: !!a.hasAudio });
  }
  return out;
}

/**
 * Two-pass frame render: a recording pass learns which (asset, source time) frames the renderer
 * asks for, those frames are decoded, then the frame is rendered for real.
 */
export async function renderWithFrames(
  host: ServerRenderHost,
  state: ProjectState,
  sequenceId: string,
  t: number,
  scale: number,
  media: Map<string, DecoderSource>,
  pool: DecoderPool,
  options: { transparent?: boolean } = {},
): Promise<CanvasLike> {
  const wanted: { assetId: string; time: number }[] = [];
  const recorder: RenderHost = {
    createCanvas: (w, h) => host.createCanvas(Math.min(w, 4), Math.min(h, 4)),
    image: (id) => host.image(id),
    videoFrame: (assetId, time) => {
      if (media.has(assetId)) wanted.push({ assetId, time });
      return null;
    },
  };
  renderSequenceFrame(recorder, state, sequenceId, t, { scale: 0.01, draft: true });
  const frames = new Map<string, Drawable>();
  for (const w of wanted) {
    const src = media.get(w.assetId)!;
    if (!src.width) continue;
    const c = await pool.frameAt(`${w.assetId}`, src, w.time);
    if (c) frames.set(`${w.assetId}@${w.time}`, c as unknown as Drawable);
  }
  const real: RenderHost = {
    createCanvas: (w, h) => host.createCanvas(w, h),
    image: (id) => host.image(id),
    videoFrame: (assetId, time) => frames.get(`${assetId}@${time}`) ?? host.image(assetId),
    lut: (id) => host.lut(id),
    mask: (id) => host.mask(id),
    fontFallback: host.fontFallback,
  };
  return renderSequenceFrame(real, state, sequenceId, t, { scale, ...(options.transparent ? { transparent: true } : {}) });
}
