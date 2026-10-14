import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { clipEnd, clipsOf, makeNode, requireNodeOfType, tracksOf, type Author, type Operation, type ProjectState, type SceneNode, type TitleSpec } from '@omnix/core';
import type { Services } from '../services.js';
import { decodeAudioMono } from '../util/media.js';
import { encodeWav, toCaptionLines, type CaptionSegment, type SpeechProvider } from './stt.js';

/** Caption building blocks shared by the captions module and the MCP tools (no route or module registration here). */

export const DEFAULT_CAPTION_STYLE: TitleSpec = {
  text: '',
  fontFamily: 'Inter',
  fontSize: 44,
  fontWeight: 600,
  color: '#ffffff',
  background: '#000000b3',
  align: 'center',
  caption: true,
};

/** Find or create the captions track (placed at the top so captions draw above video). */
export function captionTrackOps(state: ProjectState, sequenceId: string): { trackId: string; ops: Operation[] } {
  const existing = tracksOf(state, sequenceId).find((t) => t.props.trackType === 'title' && t.props.name === 'Captions');
  if (existing) return { trackId: existing.id, ops: [] };
  const track = makeNode('track', { name: 'Captions', trackType: 'title' });
  return { trackId: track.id, ops: [{ kind: 'create', parentId: sequenceId, index: 0, nodes: [track] }] };
}

/** Caption clips for timed segments (replacing captions that overlap them on the captions track). */
export function captionClipOps(state: ProjectState, sequenceId: string, segments: CaptionSegment[], style: Partial<TitleSpec> = {}): Operation[] {
  const { trackId, ops } = captionTrackOps(state, sequenceId);
  if (!ops.length) {
    for (const c of clipsOf(state, trackId)) {
      if (segments.some((s) => s.start < clipEnd(c.props) && s.end > c.props.start)) ops.push({ kind: 'delete', id: c.id });
    }
  }
  for (const s of segments) {
    const clip = makeNode('clip', {
      name: s.text ? s.text.slice(0, 40) : 'Caption',
      start: Math.max(0, s.start),
      in: 0,
      out: Math.max(0.2, s.end - s.start),
      title: { ...DEFAULT_CAPTION_STYLE, ...style, text: s.text, caption: true },
    });
    ops.push({ kind: 'create', parentId: trackId, nodes: [clip] });
  }
  return ops;
}

export interface CaptionJobInput {
  projectId: string;
  sequenceId: string;
  clipIds?: string[];
  language?: string;
  style?: Partial<TitleSpec>;
  author: Author;
}

/** Listen to the sequence's clips and return timed caption lines (nothing is changed yet). */
export async function captionSegments(services: Services, state: ProjectState, input: Omit<CaptionJobInput, 'author'>, provider: SpeechProvider, progress: (f: number, m: string) => void): Promise<{ segments: CaptionSegment[]; hasText: boolean }> {
  requireNodeOfType(state, input.sequenceId, 'sequence');
  const sources: SceneNode<'clip'>[] = [];
  for (const track of tracksOf(state, input.sequenceId)) {
    if (track.props.muted || (track.props.trackType !== 'video' && track.props.trackType !== 'audio')) continue;
    for (const c of clipsOf(state, track.id)) if (c.props.assetId && !c.props.reverse && (!input.clipIds || input.clipIds.includes(c.id))) sources.push(c);
  }
  const all: CaptionSegment[] = [];
  let hasText = true;
  let i = 0;
  for (const clip of sources) {
    i++;
    const asset = await services.assets.get(clip.props.assetId!);
    if (!asset?.hasAudio) continue;
    progress((i - 1) / Math.max(1, sources.length), `Listening to ${clip.props.name}`);
    const file = await services.blobs.localPath(asset.id);
    const rate = 16000;
    const full = await decodeAudioMono(services.config.ffmpegPath, file, rate);
    const a = Math.max(0, Math.floor(clip.props.in * rate));
    const b = Math.min(full.length, Math.ceil(clip.props.out * rate));
    const samples = full.subarray(a, b);
    const wav = path.join(os.tmpdir(), `omnix-stt-${crypto.randomBytes(5).toString('hex')}.wav`);
    await fs.writeFile(wav, encodeWav(samples, rate));
    try {
      const r = await provider.transcribe({ wavPath: wav, samples, sampleRate: rate, ...(input.language ? { language: input.language } : {}) });
      hasText &&= r.hasText;
      for (const s of toCaptionLines(r.segments)) {
        // Map source-relative times to the timeline (speed changes stretch them).
        const start = clip.props.start + s.start / clip.props.speed;
        const end = Math.min(clipEnd(clip.props), clip.props.start + s.end / clip.props.speed);
        if (end > start) all.push({ start, end, text: s.text });
      }
    } finally {
      await fs.rm(wav, { force: true });
    }
  }
  all.sort((x, y) => x.start - y.start);
  return { segments: all, hasText };
}

