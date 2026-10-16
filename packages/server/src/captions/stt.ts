import fs from 'node:fs/promises';

/**
 * Speech-to-text for auto-captions.
 *
 * Providers:
 *  - `openai-compatible`: any server speaking the OpenAI audio transcription API
 *    (OpenAI Whisper, Groq, faster-whisper-server, LocalAI...). Configure with
 *    OMNIX_STT_URL (e.g. https://api.openai.com/v1), OMNIX_STT_API_KEY, OMNIX_STT_MODEL.
 *  - `transformers`: local Whisper through @huggingface/transformers when that optional
 *    package is installed (downloads the model on first use).
 *  - `vad` (always available): finds where speech is, producing correctly timed caption
 *    slots without words, for a person (or Claude, from a script) to fill in.
 */
export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  segments: CaptionSegment[];
  provider: string;
  /** False when the provider only detected timing (no words). */
  hasText: boolean;
  language?: string;
}

export interface SpeechProvider {
  id: string;
  label: string;
  transcribe(input: { wavPath: string; samples: Float32Array; sampleRate: number; language?: string }): Promise<TranscriptionResult>;
}

/* ------------------------------------------------------------------ */
/* Voice activity detection                                            */
/* ------------------------------------------------------------------ */

export interface VadOptions {
  frameMs?: number;
  /** Threshold relative to the noise floor (dB above). */
  sensitivityDb?: number;
  minSpeechMs?: number;
  minSilenceMs?: number;
  /** Split segments longer than this into caption-sized pieces. */
  maxSegmentMs?: number;
  padMs?: number;
}

/**
 * Energy-based voice activity detection with an adaptive noise floor and hysteresis.
 * Returns speech regions in seconds.
 */
export function detectSpeech(samples: Float32Array, sampleRate: number, options: VadOptions = {}): { start: number; end: number }[] {
  const { frameMs = 30, sensitivityDb = 10, minSpeechMs = 250, minSilenceMs = 350, maxSegmentMs = 6000, padMs = 80 } = options;
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.floor(samples.length / frameLen);
  if (frames === 0) return [];
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frameLen; i < (f + 1) * frameLen; i++) sum += samples[i]! * samples[i]!;
    db[f] = 10 * Math.log10(sum / frameLen + 1e-12);
  }
  // Noise floor: 15th percentile of frame energy.
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)]!;
  const peak = sorted[Math.floor(sorted.length * 0.98)]!;
  if (peak - floor < 6) return []; // no clear speech above the noise
  const on = floor + Math.min(sensitivityDb, (peak - floor) * 0.5);
  const off = on - 3;
  const regions: { start: number; end: number }[] = [];
  let inSpeech = false;
  let startF = 0;
  let silence = 0;
  const minSilenceFrames = Math.ceil(minSilenceMs / frameMs);
  for (let f = 0; f < frames; f++) {
    if (!inSpeech && db[f]! > on) {
      inSpeech = true;
      startF = f;
      silence = 0;
    } else if (inSpeech) {
      if (db[f]! < off) {
        silence++;
        if (silence >= minSilenceFrames) {
          regions.push({ start: startF, end: f - silence + 1 });
          inSpeech = false;
        }
      } else silence = 0;
    }
  }
  if (inSpeech) regions.push({ start: startF, end: frames });
  const toSec = (f: number) => (f * frameLen) / sampleRate;
  const pad = padMs / 1000;
  const total = samples.length / sampleRate;
  const out: { start: number; end: number }[] = [];
  for (const r of regions) {
    const s = Math.max(0, toSec(r.start) - pad);
    const e = Math.min(total, toSec(r.end) + pad);
    if ((e - s) * 1000 < minSpeechMs) continue;
    const pieces = Math.max(1, Math.ceil(((e - s) * 1000) / maxSegmentMs));
    for (let i = 0; i < pieces; i++) out.push({ start: round(s + ((e - s) * i) / pieces), end: round(s + ((e - s) * (i + 1)) / pieces) });
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export const vadProvider: SpeechProvider = {
  id: 'vad',
  label: 'Speech timing only (no transcription service configured)',
  async transcribe({ samples, sampleRate }) {
    return { segments: detectSpeech(samples, sampleRate).map((r) => ({ ...r, text: '' })), provider: 'vad', hasText: false };
  },
};

/** Build a WAV (PCM16 mono) from float samples. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), 44 + i * 2);
  return buf;
}

export function openAiCompatibleProvider(cfg: { url: string; apiKey: string | null; model: string }): SpeechProvider {
  return {
    id: 'openai-compatible',
    label: `Transcription service (${new URL(cfg.url).host}, ${cfg.model})`,
    async transcribe({ wavPath, language }) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(await fs.readFile(wavPath))], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', cfg.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      if (language) form.append('language', language);
      const resp = await fetch(`${cfg.url.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!resp.ok) throw new Error(`Transcription service returned ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      const j = (await resp.json()) as { segments?: { start: number; end: number; text: string }[]; text?: string; language?: string; duration?: number };
      const segments = (j.segments ?? (j.text ? [{ start: 0, end: j.duration ?? 0, text: j.text }] : [])).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text);
      return { segments, provider: 'openai-compatible', hasText: true, ...(j.language ? { language: j.language } : {}) };
    },
  };
}

/** Local Whisper through the optional @huggingface/transformers package. */
type AsrOutput = { chunks?: { timestamp: [number, number | null]; text: string }[]; text: string };
type AsrPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<AsrOutput>;
interface TransformersModule {
  pipeline(task: string, model: string): Promise<AsrPipeline>;
}

export async function transformersProvider(model = 'onnx-community/whisper-base'): Promise<SpeechProvider | null> {
  let mod: TransformersModule;
  try {
    const name = '@huggingface/transformers';
    mod = (await import(name)) as TransformersModule;
  } catch {
    return null;
  }
  let pipe: AsrPipeline | null = null;
  return {
    id: 'transformers',
    label: `Local Whisper (${model})`,
    async transcribe({ samples, language }) {
      const run: AsrPipeline = pipe ?? (pipe = await mod.pipeline('automatic-speech-recognition', model));
      const r = await run(samples, { return_timestamps: true, chunk_length_s: 30, ...(language ? { language } : {}) });
      const segments = (r.chunks ?? []).map((c) => ({ start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 2, text: c.text.trim() })).filter((s) => s.text);
      return { segments, provider: 'transformers', hasText: true };
    },
  };
}

/** Use `primary`, and the timing-only provider when it fails (for example the model cannot be downloaded). */
function withFallback(primary: SpeechProvider, fallback: SpeechProvider): SpeechProvider {
  return {
    id: primary.id,
    label: primary.label,
    async transcribe(input) {
      try {
        return await primary.transcribe(input);
      } catch (e) {
        console.error(`[omnix] ${primary.label} failed (${e instanceof Error ? e.message : String(e)}); captions get timing only.`);
        return fallback.transcribe(input);
      }
    },
  };
}

/** Pick the best available provider from configuration. */
export async function resolveSpeechProvider(env: NodeJS.ProcessEnv = process.env): Promise<SpeechProvider> {
  if (env.OMNIX_STT_URL) return openAiCompatibleProvider({ url: env.OMNIX_STT_URL, apiKey: env.OMNIX_STT_API_KEY ?? null, model: env.OMNIX_STT_MODEL ?? 'whisper-1' });
  // Local Whisper is the default: free, private, and needs internet only once, to download the model.
  if (env.OMNIX_STT_LOCAL !== 'false') {
    const p = await transformersProvider(env.OMNIX_STT_LOCAL_MODEL);
    if (p) return withFallback(p, vadProvider);
  }
  return vadProvider;
}

/** Split long transcript segments into readable caption lines (about 42 characters, 2 lines). */
export function toCaptionLines(segments: CaptionSegment[], maxChars = 84): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (const s of segments) {
    if (!s.text || s.text.length <= maxChars) {
      out.push(s);
      continue;
    }
    const words = s.text.split(/\s+/);
    const chunks: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars && cur) {
        chunks.push(cur.trim());
        cur = w;
      } else cur += ' ' + w;
    }
    if (cur.trim()) chunks.push(cur.trim());
    const total = chunks.reduce((a, c) => a + c.length, 0);
    let t = s.start;
    for (const c of chunks) {
      const d = ((s.end - s.start) * c.length) / total;
      out.push({ start: round(t), end: round(t + d), text: c });
      t += d;
    }
  }
  return out;
}
