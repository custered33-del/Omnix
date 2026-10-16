import crypto from 'node:crypto';
import { applyOp, childrenOf, clipEnd, clipPropsAt, clipsOf, requireNodeOfType, tracksOf, type ProjectState, type SceneNode } from '@omnix/core';
import type { CanvasLike } from '@omnix/render';
import type { Services } from '../services.js';
import { encodeCanvas } from '../render/serverHost.js';
import { DecoderPool, type DecoderSource } from '../export/decoders.js';
import { renderWithFrames } from '../export/videoExport.js';
import type { CaptionSegment, SpeechProvider } from '../captions/stt.js';
import { captionSegments } from '../captions/core.js';

/*
 * What Claude needs to work on a video as well as a person does: what is said and when (a
 * transcript), what each moment looks like (frames with a coordinate grid, so it can say where
 * things are), what is on screen in the edit (clips, titles and overlays with their boxes), and a
 * point tracker, so an overlay can follow something that moves, such as a hand.
 */

/** The sequence rendered at the given times (largest side `maxSide` pixels), optionally without some clips. */
export async function sequenceFrames(services: Services, state: ProjectState, sequenceId: string, times: number[], maxSide: number, options: { exclude?: string[] } = {}): Promise<{ time: number; canvas: CanvasLike; scale: number }[]> {
  let s = state;
  for (const id of options.exclude ?? []) if (s.nodes[id]) s = applyOp(s, { kind: 'delete', id }).state;
  const seq = requireNodeOfType(s, sequenceId, 'sequence');
  const scale = Math.min(1, maxSide / Math.max(seq.props.width, seq.props.height));
  const host = services.renderHost();
  await host.prepare(s, sequenceId);
  const media = new Map<string, DecoderSource>();
  for (const n of Object.values(s.nodes)) {
    const id = n.type === 'clip' ? (n.props as { assetId: string | null }).assetId : null;
    if (!id || media.has(id)) continue;
    const a = await services.assets.get(id);
    if (a?.kind === 'video') media.set(id, { path: await services.blobs.localPath(id), width: a.width ?? 0, height: a.height ?? 0, fps: a.fps ?? 30, duration: a.duration ?? 0 });
  }
  const pool = new DecoderPool(services.config.ffmpegPath, Math.round(seq.props.width * scale), Math.round(seq.props.height * scale));
  const out: { time: number; canvas: CanvasLike; scale: number }[] = [];
  try {
    for (const time of times) out.push({ time, canvas: await renderWithFrames(host, s, sequenceId, time, scale, media, pool), scale });
  } finally {
    pool.closeAll();
  }
  return out;
}

const niceStep = (span: number) => [50, 100, 200, 250, 500, 1000].find((s) => span / s <= 12) ?? 2000;

/** Draw a labelled grid in sequence pixels, and the time, over a rendered frame. */
export function drawGrid(canvas: CanvasLike, scale: number, seqW: number, seqH: number, time: number): void {
  const g = canvas.getContext('2d')!;
  const step = niceStep(Math.max(seqW, seqH));
  g.save();
  g.lineWidth = 1;
  g.font = '11px sans-serif';
  for (let x = step; x < seqW; x += step) {
    g.strokeStyle = 'rgba(255,0,170,0.45)';
    g.beginPath();
    g.moveTo(x * scale + 0.5, 0);
    g.lineTo(x * scale + 0.5, seqH * scale);
    g.stroke();
    label(g, String(x), x * scale + 2, 12);
  }
  for (let y = step; y < seqH; y += step) {
    g.strokeStyle = 'rgba(255,0,170,0.45)';
    g.beginPath();
    g.moveTo(0, y * scale + 0.5);
    g.lineTo(seqW * scale, y * scale + 0.5);
    g.stroke();
    label(g, String(y), 2, y * scale - 2);
  }
  label(g, `${time.toFixed(2)} s`, seqW * scale - 60, seqH * scale - 6);
  g.restore();
}

function label(g: NonNullable<ReturnType<CanvasLike['getContext']>>, text: string, x: number, y: number): void {
  const w = text.length * 6.5 + 4;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(x - 1, y - 11, w, 14);
  g.fillStyle = '#ffffff';
  g.fillText(text, x + 1, y);
}

export async function framePng(canvas: CanvasLike): Promise<Buffer> {
  return encodeCanvas(canvas, 'png');
}

export interface OnScreenItem {
  id: string;
  kind: 'video' | 'image' | 'title' | 'animation';
  name: string;
  text?: string;
  /** Box in sequence pixels (top-left origin); null when the size is unknown. */
  box: { x: number; y: number; width: number; height: number } | null;
  center: { x: number; y: number };
  scale: number;
  rotation: number;
  opacity: number;
}

/** Everything visible at time t, top-most first, with where it sits on the frame. */
export async function onScreenAt(services: Services, state: ProjectState, sequenceId: string, t: number): Promise<OnScreenItem[]> {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  const W = seq.props.width;
  const H = seq.props.height;
  const items: OnScreenItem[] = [];
  for (const track of tracksOf(state, sequenceId)) {
    if (track.props.hidden || track.props.trackType === 'audio') continue;
    for (const n of childrenOf(state, track.id)) {
      if (n.type === 'animLayer') {
        const p = (n as SceneNode<'animLayer'>).props;
        if (!p.visible || t < p.start || t >= p.start + p.duration) continue;
        items.push({ id: n.id, kind: 'animation', name: p.name, box: null, center: { x: Math.round(p.x), y: Math.round(p.y) }, scale: p.scale, rotation: p.rotation, opacity: p.opacity });
      }
    }
    for (const c of clipsOf(state, track.id)) {
      const p = c.props;
      if (t < p.start || t >= clipEnd(p)) continue;
      const at = clipPropsAt(p, t);
      if (at.opacity <= 0) continue;
      const center = { x: Math.round(W / 2 + at.x), y: Math.round(H / 2 + at.y) };
      let box: OnScreenItem['box'] = null;
      let kind: OnScreenItem['kind'] = 'title';
      if (!p.title && p.assetId) {
        const a = await services.assets.get(p.assetId);
        kind = a?.kind === 'video' ? 'video' : 'image';
        if (a?.width && a.height) {
          const fit = Math.min(W / a.width, H / a.height) * at.scale;
          const w = a.width * fit;
          const h = a.height * fit;
          box = { x: Math.round(center.x - w / 2), y: Math.round(center.y - h / 2), width: Math.round(w), height: Math.round(h) };
        }
      }
      items.push({ id: c.id, kind, name: p.name, ...(p.title ? { text: p.title.text } : {}), box, center, scale: Math.round(at.scale * 100) / 100, rotation: Math.round(at.rotation), opacity: Math.round(at.opacity * 100) / 100 });
    }
  }
  return items;
}

export function describeOnScreen(items: OnScreenItem[]): string {
  if (!items.length) return 'nothing (empty frame)';
  return items
    .map((i) => `${i.kind} "${i.name}"${i.text ? ` saying "${i.text}"` : ''} (${i.id}) ${i.box ? `box x ${i.box.x}, y ${i.box.y}, ${i.box.width}×${i.box.height}` : `centred at ${i.center.x}, ${i.center.y}`}${i.scale !== 1 ? `, scale ${i.scale}` : ''}${i.rotation ? `, rotated ${i.rotation}°` : ''}${i.opacity < 1 ? `, opacity ${i.opacity}` : ''}`)
    .join('; ');
}

/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

const TRANSCRIPTS = 'transcripts';

/** The cache key for a sequence's sound: which media plays when, at what speed. */
function transcriptKey(state: ProjectState, sequenceId: string, options: { clipIds?: string[]; language?: string }): string {
  const audible: unknown[] = [];
  for (const track of tracksOf(state, sequenceId)) {
    if (track.props.muted || (track.props.trackType !== 'video' && track.props.trackType !== 'audio')) continue;
    for (const c of clipsOf(state, track.id)) if (c.props.assetId && (!options.clipIds || options.clipIds.includes(c.id))) audible.push([c.props.assetId, c.props.start, c.props.in, c.props.out, c.props.speed, c.props.reverse]);
  }
  return crypto.createHash('sha256').update(JSON.stringify([options.language ?? null, audible])).digest('hex').slice(0, 32);
}

/** A transcript made earlier for exactly this sound, if any (nothing is transcribed here). */
export async function cachedTranscript(services: Services, state: ProjectState, sequenceId: string): Promise<CaptionSegment[]> {
  return (await services.store.get<{ segments: CaptionSegment[] }>(TRANSCRIPTS, transcriptKey(state, sequenceId, {})))?.segments ?? [];
}

/** What was said and when, in sequence time. Cached until the clips' sound changes. */
export async function sequenceTranscript(services: Services, state: ProjectState, sequenceId: string, provider: SpeechProvider, options: { clipIds?: string[]; language?: string; projectId: string }): Promise<{ segments: CaptionSegment[]; hasText: boolean; cached: boolean }> {
  const key = transcriptKey(state, sequenceId, options);
  const hit = await services.store.get<{ segments: CaptionSegment[]; hasText: boolean }>(TRANSCRIPTS, key);
  if (hit) return { ...hit, cached: true };
  const r = await captionSegments(services, state, { projectId: options.projectId, sequenceId, ...(options.clipIds ? { clipIds: options.clipIds } : {}), ...(options.language ? { language: options.language } : {}) }, provider, () => {});
  // Timing-only results are not kept, so words appear once the speech model is available.
  if (r.hasText) await services.store.put(TRANSCRIPTS, key, r);
  return { ...r, cached: false };
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/* ------------------------------------------------------------------ */
/* Point tracking                                                      */
/* ------------------------------------------------------------------ */

export interface TrackedPoint {
  time: number;
  x: number;
  y: number;
  /** 0..1: how closely this frame matched what was being followed. */
  confidence: number;
}

function gray(canvas: CanvasLike): { w: number; h: number; d: Float32Array } {
  const g = canvas.getContext('2d')!;
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < d.length; i++) d[i] = 0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!;
  return { w: canvas.width, h: canvas.height, d };
}

/**
 * Follow the patch around (x, y) at the first frame through the others: template matching by sum
 * of absolute differences in a window around the last position, with the template slowly updated
 * so gradual changes (a hand turning) are followed. Coordinates are in frame pixels.
 */
export function trackPatch(frames: { w: number; h: number; d: Float32Array }[], x: number, y: number, radius: number, search: number): { x: number; y: number; confidence: number }[] {
  const f0 = frames[0]!;
  const r = Math.max(2, Math.round(radius));
  const size = 2 * r + 1;
  const tpl = new Float32Array(size * size);
  const at = (f: { w: number; h: number; d: Float32Array }, px: number, py: number) => f.d[Math.min(f.h - 1, Math.max(0, py)) * f.w + Math.min(f.w - 1, Math.max(0, px))]!;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) tpl[j * size + i] = at(f0, Math.round(x) - r + i, Math.round(y) - r + j);
  let cx = Math.round(x);
  let cy = Math.round(y);
  const out = [{ x, y, confidence: 1 }];
  for (let k = 1; k < frames.length; k++) {
    const f = frames[k]!;
    let best = Infinity;
    let bx = cx;
    let by = cy;
    for (let dy = -search; dy <= search; dy++) {
      for (let dx = -search; dx <= search; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        let sad = 0;
        for (let j = 0; j < size && sad < best; j += 2) for (let i = 0; i < size; i += 2) sad += Math.abs(at(f, px - r + i, py - r + j) - tpl[j * size + i]!);
        if (sad < best) {
          best = sad;
          bx = px;
          by = py;
        }
      }
    }
    cx = bx;
    cy = by;
    const samples = Math.ceil(size / 2) ** 2;
    const confidence = Math.max(0, Math.min(1, 1 - best / samples / 60));
    out.push({ x: cx, y: cy, confidence: Math.round(confidence * 100) / 100 });
    // Adapt to gradual change, more slowly when the match is poor.
    const rate = 0.25 * confidence;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) tpl[j * size + i] = tpl[j * size + i]! * (1 - rate) + at(f, cx - r + i, cy - r + j) * rate;
  }
  return out;
}

/** Follow a point of the picture from `from` to `to` seconds (sequence pixels and time). */
export async function trackPoint(services: Services, state: ProjectState, sequenceId: string, input: { x: number; y: number; from: number; to: number; radius: number; maxMove: number; fps: number; exclude: string[] }): Promise<TrackedPoint[]> {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  const n = Math.max(2, Math.min(600, Math.round((input.to - input.from) * input.fps) + 1));
  const times = Array.from({ length: n }, (_, i) => input.from + ((input.to - input.from) * i) / (n - 1));
  const rendered = await sequenceFrames(services, state, sequenceId, times, 640, { exclude: input.exclude });
  const scale = rendered[0]!.scale;
  const frames = rendered.map((r) => gray(r.canvas));
  // How far the point may move between two tracked frames, in frame pixels.
  const search = Math.max(4, Math.min(60, Math.round(input.maxMove * scale)));
  const path = trackPatch(frames, input.x * scale, input.y * scale, input.radius * scale, search);
  void seq;
  return path.map((p, i) => ({ time: Math.round(times[i]! * 1000) / 1000, x: Math.round(p.x / scale), y: Math.round(p.y / scale), confidence: p.confidence }));
}
