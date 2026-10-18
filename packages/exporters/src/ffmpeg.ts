import type { ClipProps, Keyframe, ProjectState, SceneNode } from '@omnix/core';
import { clipDuration, clipsOf, requireNodeOfType, tracksOf } from '@omnix/core';

/**
 * Export presets and ffmpeg argument builders. Video frames are rendered by Omnix (so the
 * export matches the preview exactly) and piped to ffmpeg as raw RGBA; audio is mixed by an
 * ffmpeg filter graph built from the timeline (trims, speed, reverse, volume automation,
 * pan, ducking).
 */

export type PresetCategory = 'social' | 'web' | 'broadcast' | 'audio';

export interface VideoPreset {
  id: string;
  label: string;
  category: PresetCategory;
  description: string;
  width: number | null;
  height: number | null;
  /** null keeps the sequence frame rate. */
  fps: number | null;
  container: 'mp4' | 'mov' | 'webm' | 'wav' | 'mp3';
  video: string[] | null;
  audio: string[] | null;
  /** Fit strategy when the aspect ratio differs: letterbox or crop to fill. */
  fit: 'contain' | 'cover';
  maxDuration?: number;
}

const H264 = (crf: number, preset = 'medium') => ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const AAC = (kbps: number) => ['-c:a', 'aac', '-b:a', `${kbps}k`, '-ar', '48000'];

export const VIDEO_PRESETS: VideoPreset[] = [
  { id: 'youtube-1080p', label: 'YouTube 1080p', category: 'social', description: 'H.264 + AAC, 1920x1080, high quality', width: 1920, height: 1080, fps: null, container: 'mp4', video: H264(18), audio: AAC(192), fit: 'contain' },
  { id: 'youtube-4k', label: 'YouTube 4K', category: 'social', description: 'H.264 + AAC, 3840x2160', width: 3840, height: 2160, fps: null, container: 'mp4', video: H264(18, 'slow'), audio: AAC(256), fit: 'contain' },
  { id: 'reels', label: 'Instagram Reels / TikTok / Shorts', category: 'social', description: 'Vertical 9:16, 1080x1920, cropped to fill', width: 1080, height: 1920, fps: 30, container: 'mp4', video: H264(20), audio: AAC(160), fit: 'cover', maxDuration: 180 },
  { id: 'square', label: 'Instagram square', category: 'social', description: '1:1, 1080x1080, cropped to fill', width: 1080, height: 1080, fps: 30, container: 'mp4', video: H264(20), audio: AAC(160), fit: 'cover' },
  { id: 'x-video', label: 'X (Twitter)', category: 'social', description: 'H.264 + AAC, 1280x720', width: 1280, height: 720, fps: 30, container: 'mp4', video: [...H264(22), '-maxrate', '5M', '-bufsize', '10M'], audio: AAC(128), fit: 'contain', maxDuration: 140 },
  { id: 'web-1080p', label: 'Web 1080p (MP4)', category: 'web', description: 'H.264, balanced size', width: 1920, height: 1080, fps: null, container: 'mp4', video: H264(23), audio: AAC(128), fit: 'contain' },
  { id: 'web-720p', label: 'Web 720p (MP4)', category: 'web', description: 'H.264, small files', width: 1280, height: 720, fps: null, container: 'mp4', video: H264(24), audio: AAC(128), fit: 'contain' },
  { id: 'web-webm', label: 'Web (WebM VP9)', category: 'web', description: 'VP9 + Opus, open format', width: null, height: null, fps: null, container: 'webm', video: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'], audio: ['-c:a', 'libopus', '-b:a', '128k'], fit: 'contain' },
  { id: 'prores-hq', label: 'ProRes 422 HQ', category: 'broadcast', description: 'Mastering / broadcast delivery, 24-bit PCM audio', width: null, height: null, fps: null, container: 'mov', video: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0'], audio: ['-c:a', 'pcm_s24le', '-ar', '48000'], fit: 'contain' },
  { id: 'dnxhr-hq', label: 'DNxHR HQ', category: 'broadcast', description: 'Avid-friendly intermediate', width: null, height: null, fps: null, container: 'mov', video: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p'], audio: ['-c:a', 'pcm_s16le', '-ar', '48000'], fit: 'contain' },
  { id: 'audio-wav', label: 'Audio only (WAV)', category: 'audio', description: '48 kHz 24-bit PCM', width: null, height: null, fps: null, container: 'wav', video: null, audio: ['-c:a', 'pcm_s24le', '-ar', '48000'], fit: 'contain' },
  { id: 'audio-mp3', label: 'Audio only (MP3)', category: 'audio', description: '320 kbps', width: null, height: null, fps: null, container: 'mp3', video: null, audio: ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000'], fit: 'contain' },
];

export function presetById(id: string): VideoPreset {
  const p = VIDEO_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown export preset: ${id}`);
  return p;
}

/** The output size for a sequence under a preset (even dimensions, as encoders require). */
export function outputSize(preset: VideoPreset, seqW: number, seqH: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(preset.width ?? seqW), height: even(preset.height ?? seqH) };
}

/** Video filter that scales rendered frames into the preset frame. */
export function scaleFilter(preset: VideoPreset, outW: number, outH: number): string {
  return preset.fit === 'cover'
    ? `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${outW}:${outH}`
    : `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/* ------------------------------------------------------------------ */
/* Audio graph                                                          */
/* ------------------------------------------------------------------ */

export interface AudioSource {
  /** Local file path ffmpeg can read. */
  path: string;
  hasAudio: boolean;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** atempo accepts 0.5..2.0 (older ffmpeg) per instance; chain filters for other speeds. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s >= 2 - 1e-9) {
    out.push('atempo=2.0');
    s /= 2;
  }
  while (s <= 0.5 + 1e-9) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

/** A piecewise-linear ffmpeg expression in t (seconds) for keyframed volume (dB) plus a base gain. */
export function volumeExpression(keys: Keyframe[] | undefined, baseDb: number, offset: number): string {
  if (!keys || keys.length === 0) return dbToGain(baseDb).toFixed(6);
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  const g = (db: number) => dbToGain(db + baseDb);
  let expr = g(sorted[sorted.length - 1]!.value).toFixed(6);
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const ta = a.time + offset;
    const tb = b.time + offset;
    const seg = a.easing === 'hold' ? g(a.value).toFixed(6) : `(${g(a.value).toFixed(6)}+(${(g(b.value) - g(a.value)).toFixed(6)})*(t-${ta.toFixed(4)})/${Math.max(1e-6, tb - ta).toFixed(4)})`;
    expr = `if(lt(t,${tb.toFixed(4)}),${seg},${expr})`;
  }
  return `if(lt(t,${(sorted[0]!.time + offset).toFixed(4)}),${g(sorted[0]!.value).toFixed(6)},${expr})`;
}

export interface AudioGraph {
  /** Input files in order (ffmpeg -i), after any video pipe input. */
  inputs: string[];
  /** filter_complex string, empty when there is no audio. */
  filter: string;
  /** Output label of the final mix, e.g. "[aout]", or null for silence. */
  output: string | null;
}

/**
 * Build the audio mix for a sequence. `inputOffset` is the index of the first audio input
 * (1 when input 0 is the piped video).
 */
export function buildAudioGraph(state: ProjectState, sequenceId: string, sources: (assetId: string) => AudioSource | null, options: { inputOffset: number; duration: number; sampleRate?: number }): AudioGraph {
  requireNodeOfType(state, sequenceId, 'sequence');
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  const parts: string[] = [];
  const trackOutputs: { trackId: string; label: string; ducking: SceneNode<'track'>['props']['ducking'] }[] = [];
  const sr = options.sampleRate ?? 48000;
  let n = 0;
  for (const track of tracksOf(state, sequenceId)) {
    const tp = track.props;
    if (tp.muted || tp.trackType === 'title' || tp.trackType === 'effect' || tp.trackType === 'animation') continue;
    const clipLabels: string[] = [];
    for (const clip of clipsOf(state, track.id)) {
      const p: ClipProps = clip.props;
      if (!p.assetId) continue;
      const src = sources(p.assetId);
      if (!src || !src.hasAudio) continue;
      let idx = inputIndex.get(src.path);
      if (idx === undefined) {
        idx = options.inputOffset + inputs.length;
        inputs.push(src.path);
        inputIndex.set(src.path, idx);
      }
      const label = `a${n++}`;
      const chain: string[] = [`atrim=start=${p.in.toFixed(4)}:end=${p.out.toFixed(4)}`, 'asetpts=PTS-STARTPTS', `aresample=${sr}`, 'aformat=channel_layouts=stereo'];
      if (p.reverse) chain.push('areverse');
      if (p.speedRamp && p.speedRamp.length) {
        // Ramped audio is approximated with the ramp's average speed (pitch-preserving).
        const avg = clipDuration({ ...p, start: 0 }) > 0 ? (p.out - p.in) / clipDuration(p) : 1;
        chain.push(...atempoChain(avg));
      } else chain.push(...atempoChain(p.speed));
      chain.push(`volume='${volumeExpression(p.keyframes.volume, p.volume, 0)}':eval=frame`);
      // Fades, in timeline seconds (after the speed change), before the clip is moved into place.
      const len = clipDuration(p);
      if (p.fadeIn && p.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${Math.min(p.fadeIn, len).toFixed(4)}`);
      if (p.fadeOut && p.fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, len - p.fadeOut).toFixed(4)}:d=${Math.min(p.fadeOut, len).toFixed(4)}`);
      chain.push(`adelay=${Math.round(p.start * 1000)}:all=1`);
      parts.push(`[${idx}:a]${chain.join(',')}[${label}]`);
      clipLabels.push(`[${label}]`);
    }
    if (!clipLabels.length) continue;
    const mixed = `t${track.id.replace(/\W/g, '')}`;
    const panL = Math.min(1, 1 - tp.pan);
    const panR = Math.min(1, 1 + tp.pan);
    const gain = dbToGain(tp.gain);
    const trackChain = [`volume=${gain.toFixed(6)}`, `pan=stereo|c0=${panL.toFixed(4)}*c0|c1=${panR.toFixed(4)}*c1`];
    parts.push(`${clipLabels.join('')}${clipLabels.length > 1 ? `amix=inputs=${clipLabels.length}:normalize=0:dropout_transition=0,` : ''}${trackChain.join(',')}[${mixed}]`);
    trackOutputs.push({ trackId: track.id, label: mixed, ducking: tp.ducking });
  }
  if (!trackOutputs.length) return { inputs, filter: '', output: null };

  // Ducking: compress a track using another track's signal as the sidechain.
  const finalLabels: string[] = [];
  const splitCount = new Map<string, number>();
  for (const t of trackOutputs) {
    const src = t.ducking.enabled ? trackOutputs.find((o) => o.trackId === t.ducking.sourceTrackId && o !== t) : undefined;
    if (src) splitCount.set(src.label, (splitCount.get(src.label) ?? 1) + 1);
  }
  const available = new Map<string, string[]>();
  for (const [label, count] of splitCount) {
    const outs = Array.from({ length: count }, (_, i) => `${label}s${i}`);
    parts.push(`[${label}]asplit=${count}${outs.map((o) => `[${o}]`).join('')}`);
    available.set(label, outs);
  }
  const take = (label: string) => {
    const list = available.get(label);
    return list ? list.shift()! : label;
  };
  for (const t of trackOutputs) {
    const src = t.ducking.enabled ? trackOutputs.find((o) => o.trackId === t.ducking.sourceTrackId && o !== t) : undefined;
    if (src) {
      const ratio = Math.min(20, Math.max(2, Math.abs(t.ducking.amountDb) / 2));
      const out = `${t.label}d`;
      parts.push(`[${take(t.label)}][${take(src.label)}]sidechaincompress=threshold=0.03:ratio=${ratio.toFixed(2)}:attack=20:release=300:makeup=1[${out}]`);
      finalLabels.push(`[${out}]`);
    } else finalLabels.push(`[${take(t.label)}]`);
  }
  parts.push(`${finalLabels.join('')}${finalLabels.length > 1 ? `amix=inputs=${finalLabels.length}:normalize=0:dropout_transition=0,` : ''}apad,atrim=end=${options.duration.toFixed(4)},alimiter=limit=0.98[aout]`);
  return { inputs, filter: parts.join(';'), output: '[aout]' };
}

/** Full ffmpeg argument list for a render: raw RGBA frames on stdin plus the audio graph. */
export function buildExportArgs(preset: VideoPreset, opts: { frameWidth: number; frameHeight: number; fps: number; duration: number; audio: AudioGraph; outputPath: string }): string[] {
  const { width, height } = outputSize(preset, opts.frameWidth, opts.frameHeight);
  const args = ['-v', 'error', '-stats', '-y'];
  const hasVideo = !!preset.video;
  if (hasVideo) args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opts.frameWidth}x${opts.frameHeight}`, '-r', String(opts.fps), '-i', 'pipe:0');
  for (const input of opts.audio.inputs) args.push('-i', input);
  const filters: string[] = [];
  if (hasVideo) filters.push(`[0:v]${scaleFilter(preset, width, height)},format=${preset.video!.includes('yuv422p10le') ? 'yuv422p10le' : preset.video!.includes('yuv422p') ? 'yuv422p' : 'yuv420p'}[vout]`);
  if (opts.audio.filter) filters.push(opts.audio.filter);
  if (filters.length) args.push('-filter_complex', filters.join(';'));
  if (hasVideo) args.push('-map', '[vout]', ...preset.video!);
  if (opts.audio.output && preset.audio) args.push('-map', opts.audio.output, ...preset.audio);
  else if (!hasVideo && preset.audio) {
    // Audio-only export of a silent sequence: generate silence of the right length.
    args.push('-f', 'lavfi', '-t', opts.duration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo', ...preset.audio);
  }
  args.push('-t', opts.duration.toFixed(4), opts.outputPath);
  return args;
}
