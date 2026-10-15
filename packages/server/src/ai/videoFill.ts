import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { type ClipGeneration, type Operation, type ProjectState, type SceneNode } from '@omnix/core';
import { createMask, type Mask, type Raster } from '@omnix/imaging';
import type { Services } from '../services.js';
import { imageProvider } from './generative.js';

/**
 * Generative fill for video regions (feature 46): remove or replace something inside a rectangle
 * or ellipse of a clip (a logo, a watermark, a passer-by) from a prompt. Frames are decoded with
 * ffmpeg, the region is filled on keyframes and blended between them (steadier and much faster than
 * filling every frame), and the result is encoded as a new clip with the original sound. The clip keeps
 * a record of the original media and the region, so the editor can show the mask and switch back.
 */

export interface VideoRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  shape?: 'rect' | 'ellipse';
}

export interface VideoFillInput {
  projectId: string;
  clipId: string;
  /** Region in sequence (frame) pixels, the way it looks on the stage. */
  region: VideoRegion;
  prompt: string;
  providerId?: string | null;
}

/** Map a stage-space rectangle to the clip's source pixels (the clip is drawn "contain"-fitted, centered, then offset and scaled). */
export function stageToSource(region: VideoRegion, clip: SceneNode<'clip'>['props'], seq: { width: number; height: number }, src: { width: number; height: number }): VideoRegion {
  if (Math.abs(clip.rotation) > 0.01) throw new Error('Straighten the clip (rotation 0) before filling a region.');
  const s = Math.min(seq.width / src.width, seq.height / src.height) * clip.scale;
  const left = seq.width / 2 + clip.x - (src.width * s) / 2;
  const top = seq.height / 2 + clip.y - (src.height * s) / 2;
  const x = Math.max(0, Math.floor((region.x - left) / s));
  const y = Math.max(0, Math.floor((region.y - top) / s));
  const x1 = Math.min(src.width, Math.ceil((region.x + region.width - left) / s));
  const y1 = Math.min(src.height, Math.ceil((region.y + region.height - top) / s));
  if (x1 - x < 2 || y1 - y < 2) throw new Error('The region is outside the clip.');
  return { x, y, width: x1 - x, height: y1 - y, shape: region.shape ?? 'rect' };
}

function regionMask(w: number, h: number, r: VideoRegion): Mask {
  const m = createMask(w, h);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  for (let y = Math.max(0, r.y - 2); y < Math.min(h, r.y + r.height + 2); y++)
    for (let x = Math.max(0, r.x - 2); x < Math.min(w, r.x + r.width + 2); x++) {
      let inside: number;
      if (r.shape === 'ellipse') {
        const d = ((x + 0.5 - cx) / (r.width / 2)) ** 2 + ((y + 0.5 - cy) / (r.height / 2)) ** 2;
        inside = d <= 1 ? 1 : Math.max(0, 1 - (Math.sqrt(d) - 1) * 6);
      } else {
        const dx = Math.max(r.x - (x + 0.5), x + 0.5 - (r.x + r.width), 0);
        const dy = Math.max(r.y - (y + 0.5), y + 0.5 - (r.y + r.height), 0);
        inside = Math.max(0, 1 - Math.hypot(dx, dy) / 2);
      }
      m.data[y * w + x] = Math.round(inside * 255);
    }
  return m;
}

/** Work on a window around the region (fast), with enough context for the fill. */
function windowAround(w: number, h: number, r: VideoRegion): VideoRegion {
  const pad = Math.max(32, Math.round(Math.max(r.width, r.height) * 0.9));
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  return { x, y, width: Math.min(w, r.x + r.width + pad) - x, height: Math.min(h, r.y + r.height + pad) - y };
}

function cut(frame: Buffer, w: number, win: VideoRegion): Raster {
  const data = new Uint8ClampedArray(win.width * win.height * 4);
  for (let y = 0; y < win.height; y++) data.set(frame.subarray(((win.y + y) * w + win.x) * 4, ((win.y + y) * w + win.x + win.width) * 4), y * win.width * 4);
  return { width: win.width, height: win.height, data };
}

function cutMask(m: Mask, win: VideoRegion): Mask {
  const out = createMask(win.width, win.height);
  for (let y = 0; y < win.height; y++) out.data.set(m.data.subarray((win.y + y) * m.width + win.x, (win.y + y) * m.width + win.x + win.width), y * win.width);
  return out;
}

export async function runVideoFill(services: Services, state: ProjectState, input: VideoFillInput, ownerId: string, progress: (f: number, m: string) => void, signal: AbortSignal): Promise<{ ops: Operation[]; assetId: string; frames: number }> {
  const clip = state.nodes[input.clipId] as SceneNode<'clip'> | undefined;
  if (!clip || clip.type !== 'clip' || !clip.props.assetId) throw new Error('Choose a video clip.');
  let seq: SceneNode | undefined = clip;
  while (seq && seq.type !== 'sequence') seq = seq.parentId ? state.nodes[seq.parentId] : undefined;
  if (!seq) throw new Error('The clip is not in a sequence.');
  const asset = await services.assets.get(clip.props.assetId);
  if (!asset || asset.kind !== 'video' || !asset.width || !asset.height) throw new Error('Generative fill works on video clips.');
  const p = clip.props;
  // Fill at up to 1280 px wide: plenty for a region fix, and keeps the job quick.
  const scale = Math.min(1, 1280 / asset.width);
  const W = Math.max(2, Math.round((asset.width * scale) / 2) * 2);
  const H = Math.max(2, Math.round((asset.height * scale) / 2) * 2);
  const srcRegion = stageToSource(input.region, p, (seq as SceneNode<'sequence'>).props, { width: asset.width, height: asset.height });
  const region: VideoRegion = { x: Math.round(srcRegion.x * scale), y: Math.round(srcRegion.y * scale), width: Math.max(2, Math.round(srcRegion.width * scale)), height: Math.max(2, Math.round(srcRegion.height * scale)), shape: srcRegion.shape ?? 'rect' };
  const fps = asset.fps || 30;
  const start = p.in;
  const length = Math.max(1 / fps, p.out - p.in);
  const total = Math.max(1, Math.round(length * fps));
  const sourcePath = await services.blobs.localPath(clip.props.assetId);
  const outPath = path.join(os.tmpdir(), `omnix-fill-${crypto.randomBytes(6).toString('hex')}.mp4`);
  const ff = services.config.ffmpegPath;

  const decoder = spawn(ff, ['-v', 'error', '-ss', start.toFixed(4), '-t', length.toFixed(4), '-i', sourcePath, '-vf', `scale=${W}:${H},fps=${fps}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const encoder = spawn(ff, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-', '-ss', start.toFixed(4), '-t', length.toFixed(4), '-i', sourcePath, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outPath], { stdio: ['pipe', 'ignore', 'pipe'] });
  let encErr = '';
  encoder.stderr.on('data', (d: Buffer) => (encErr = (encErr + d.toString()).slice(-4000)));
  let decErr = '';
  decoder.stderr.on('data', (d: Buffer) => (decErr = (decErr + d.toString()).slice(-4000)));
  encoder.stdin.on('error', () => {});
  const encoded = new Promise<number>((resolve) => encoder.on('close', (c) => resolve(c ?? 1)));
  const kill = () => {
    decoder.kill('SIGKILL');
    encoder.kill('SIGKILL');
  };
  signal.addEventListener('abort', kill, { once: true });

  const provider = imageProvider(services, input.providerId);
  const mask = regionMask(W, H, region);
  const win = windowAround(W, H, region);
  const winMask = cutMask(mask, win);
  const frameBytes = W * H * 4;
  // Keyframes every ~0.25 s (every frame for very short clips).
  const step = Math.max(1, Math.min(Math.round(fps / 4), Math.ceil(total / 4)));
  const pending: Buffer[] = [];
  let prevKey: { index: number; patch: Raster } | null = null;
  let written = 0;

  const write = async (frame: Buffer) => {
    if (!encoder.stdin.write(frame)) await new Promise<void>((r) => encoder.stdin.once('drain', r));
  };
  const paste = (frame: Buffer, a: Raster, b: Raster | null, t: number) => {
    for (let y = 0; y < win.height; y++)
      for (let x = 0; x < win.width; x++) {
        const m = winMask.data[y * win.width + x]! / 255;
        if (!m) continue;
        const di = ((win.y + y) * W + win.x + x) * 4;
        const si = (y * win.width + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const v = b ? a.data[si + ch]! * (1 - t) + b.data[si + ch]! * t : a.data[si + ch]!;
          frame[di + ch] = Math.round(frame[di + ch]! * (1 - m) + v * m);
        }
      }
  };
  const flush = async (key: { index: number; patch: Raster }) => {
    // Frames between the previous keyframe and this one blend the two patches.
    for (let k = 0; k < pending.length; k++) {
      const idx = written;
      const t = prevKey ? (idx - prevKey.index) / Math.max(1, key.index - prevKey.index) : 1;
      paste(pending[k]!, prevKey?.patch ?? key.patch, prevKey ? key.patch : null, Math.max(0, Math.min(1, t)));
      await write(pending[k]!);
      written++;
    }
    pending.length = 0;
    prevKey = key;
  };

  let buffer: Buffer = Buffer.alloc(0);
  let index = 0;
  try {
    for await (const chunk of decoder.stdout as AsyncIterable<Buffer>) {
      if (signal.aborted) throw new Error('Cancelled');
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= frameBytes) {
        const frame = Buffer.from(buffer.subarray(0, frameBytes));
        buffer = buffer.subarray(frameBytes);
        if (index % step === 0) {
          const window = cut(frame, W, win);
          const filled = await provider.inpaint({ image: window, mask: winMask, prompt: input.prompt, signal });
          // The keyframe itself gets its own patch; earlier pending frames blend toward it.
          const key = { index, patch: filled };
          await flush(key);
          paste(frame, filled, null, 0);
          await write(frame);
          written++;
        } else pending.push(frame);
        index++;
        if (index % 5 === 0) progress(Math.min(0.95, index / total), `Filling frame ${index} of ${total}`);
      }
    }
    // Tail frames after the last keyframe keep its patch.
    if (prevKey) for (const f of pending.splice(0)) {
      paste(f, (prevKey as { patch: Raster }).patch, null, 0);
      await write(f);
      written++;
    }
    encoder.stdin.end();
    const code = await encoded;
    if (code !== 0) throw new Error(`Encoding failed: ${encErr.split('\n').filter(Boolean).slice(-2).join(' | ') || decErr.slice(-200)}`);
    if (!written) throw new Error(`Could not read frames from the clip${decErr ? `: ${decErr.split('\n').filter(Boolean).pop()}` : ''}.`);
    progress(0.97, 'Saving the new clip');
    const rec = await services.assets.ingestFile(outPath, { name: `${asset.name.replace(/\.[^.]+$/, '')} (filled).mp4`, ownerId, projectId: input.projectId, mimeHint: 'video/mp4', tags: ['generated'], source: { kind: 'generated', projectId: input.projectId } });
    const gen: ClipGeneration = { kind: 'fill', prompt: input.prompt.slice(0, 2000), provider: provider.id, maskAssetId: null, createdAt: new Date().toISOString(), region: { x: srcRegion.x, y: srcRegion.y, width: srcRegion.width, height: srcRegion.height }, sourceAssetId: clip.props.assetId, sourceIn: p.in, sourceOut: p.out };
    const newLength = rec.duration ?? length;
    const ops: Operation[] = [{ kind: 'update', id: clip.id, set: { assetId: rec.id, in: 0, out: Math.min(newLength, p.out - p.in), sourceDuration: newLength, generation: p.generation ? { ...gen, sourceAssetId: p.generation.sourceAssetId, sourceIn: p.generation.sourceIn, sourceOut: p.generation.sourceOut } : gen } }];
    return { ops, assetId: rec.id, frames: written };
  } catch (e) {
    kill();
    await fs.rm(outPath, { force: true });
    throw e;
  } finally {
    signal.removeEventListener('abort', kill);
  }
}
