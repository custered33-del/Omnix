import type { ClipEffect, ClipProps, EditFxKind, SceneNode, Transition, TransitionKind } from './nodes.js';
import type { Operation } from './ops.js';
import { requireNodeOfType, type ProjectState } from './state.js';
import { makeNode } from './defaults.js';
import { clipsOf, tracksOf } from './timeline.js';

/**
 * Recense: making edits (the fast, beat-synced videos on TikTok and Reels). Beat finding is pure maths
 * on audio samples; the builders return Operations like every other edit, so they can be undone.
 */

/* ------------------------------------------------------------------ */
/* Beats                                                               */
/* ------------------------------------------------------------------ */

export interface BeatAnalysis {
  /** Tempo in beats per minute. */
  bpm: number;
  /** A steady beat grid, in seconds. */
  beats: number[];
  /** Hits in the music (drums, accents), in seconds; not necessarily on the grid. */
  onsets: number[];
  duration: number;
}

const ENV_RATE = 100; // onset envelope frames per second

/** Find the tempo, a beat grid and the hits in mono audio samples. */
export function detectBeats(samples: Float32Array, sampleRate: number, opts: { minBpm?: number; maxBpm?: number } = {}): BeatAnalysis {
  const duration = samples.length / sampleRate;
  const hop = Math.max(1, Math.round(sampleRate / ENV_RATE));
  const frames = Math.floor(samples.length / hop);
  if (frames < ENV_RATE) return { bpm: 0, beats: [], onsets: [], duration };
  // Energy of the differenced signal: sudden, bright sounds (drums) stand out.
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const s0 = f * hop;
    for (let i = s0 + 1; i < s0 + hop; i++) {
      const d = samples[i]! - samples[i - 1]!;
      e += d * d;
    }
    energy[f] = Math.log1p(1000 * Math.sqrt(e / hop));
  }
  // Onset strength: how much louder than the moment just before.
  const env = new Float32Array(frames);
  for (let f = 3; f < frames; f++) env[f] = Math.max(0, energy[f]! - (energy[f - 1]! + energy[f - 2]! + energy[f - 3]!) / 3);
  let mean = 0;
  for (const v of env) mean += v;
  mean /= frames;
  if (mean <= 0) return { bpm: 0, beats: [], onsets: [], duration };

  // Hits: local peaks above a moving threshold, at least 0.1 s apart.
  const onsets: number[] = [];
  const win = 50;
  let last = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    const v = env[f]!;
    if (v <= env[f - 1]! || v < env[f + 1]!) continue;
    let m = 0;
    let n = 0;
    for (let k = Math.max(0, f - win); k < Math.min(frames, f + win); k++) (m += env[k]!), n++;
    if (v > 1.5 * (m / n) + 0.1 * mean && f - last >= 10) {
      onsets.push(round2(f / ENV_RATE));
      last = f;
    }
  }

  // Tempo: the strongest repeat in the onset envelope, gently preferring ~120 BPM.
  const minBpm = opts.minBpm ?? 70;
  const maxBpm = opts.maxBpm ?? 180;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = Math.floor((60 * ENV_RATE) / maxBpm); lag <= Math.ceil((60 * ENV_RATE) / minBpm); lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += env[f]! * env[f - lag]!;
    s /= frames - lag;
    const bpm = (60 * ENV_RATE) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s * w > bestScore) (bestScore = s * w), (bestLag = lag);
  }
  if (!bestLag) return { bpm: 0, beats: [], onsets, duration };
  const period = bestLag;
  // Phase: where on the grid the hits line up best.
  let bestPhase = 0;
  let phaseScore = -Infinity;
  for (let ph = 0; ph < period; ph++) {
    let s = 0;
    for (let f = ph; f < frames; f += period) s += env[f]! + 0.5 * ((env[f - 1] ?? 0) + (env[f + 1] ?? 0));
    if (s > phaseScore) (phaseScore = s), (bestPhase = ph);
  }
  // The grid, each beat nudged to a nearby hit so it stays on the music when the tempo drifts.
  const beats: number[] = [];
  const reach = Math.max(1, Math.round(period * 0.08));
  let f = bestPhase;
  while (f < frames) {
    let at = f;
    let peak = env[f] ?? 0;
    for (let k = f - reach; k <= f + reach; k++) if (k >= 0 && k < frames && env[k]! > peak) (peak = env[k]!), (at = k);
    beats.push(round2(at / ENV_RATE));
    f = at + period;
  }
  return { bpm: Math.round(((60 * ENV_RATE) / period) * 10) / 10, beats, onsets, duration };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Beats between from and to, keeping every nth one (1 = every beat, 2 = every other, ...). */
export function pickBeats(beats: readonly number[], every = 1, from = 0, to = Infinity, offset = 0): number[] {
  const inRange = beats.filter((b) => b >= from - 1e-6 && b <= to + 1e-6);
  return inRange.filter((_, i) => (i - offset) % Math.max(1, every) === 0 && i >= offset);
}

/* ------------------------------------------------------------------ */
/* Effects and transitions                                             */
/* ------------------------------------------------------------------ */

/** Default settings for each moving effect. `amount` is 0..1 strength. */
export const EDIT_FX_DEFAULTS: Record<EditFxKind, Record<string, number>> = {
  shake: { amount: 0.5, speed: 18 },
  zoomPunch: { amount: 0.5 },
  flash: { amount: 0.8 },
  rgbSplit: { amount: 0.5 },
  glitch: { amount: 0.5, seed: 1 },
  strobe: { amount: 0.7, rate: 8 },
  letterbox: { amount: 0.12 },
  vhs: { amount: 0.5 },
};

/** How long each effect usually lasts when it hits on a beat, in seconds. */
export const EDIT_FX_LENGTH: Record<EditFxKind, number> = {
  shake: 0.3,
  zoomPunch: 0.35,
  flash: 0.2,
  rgbSplit: 0.25,
  glitch: 0.2,
  strobe: 0.4,
  letterbox: 2,
  vhs: 2,
};

export function isEditFx(effect: ClipEffect['effect']): effect is EditFxKind {
  return effect in EDIT_FX_DEFAULTS;
}

export const EDIT_TRANSITION_LENGTH: Partial<Record<TransitionKind, number>> = {
  'whip-left': 0.25,
  'whip-right': 0.25,
  'zoom-punch': 0.3,
  spin: 0.35,
  flash: 0.2,
  glitch: 0.25,
};

function transition(kind: TransitionKind, duration?: number): Transition {
  return { kind, duration: duration ?? EDIT_TRANSITION_LENGTH[kind] ?? 0.4, easing: 'ease-in-out' };
}

/** Speed ramps for velocity edits (fast, then slow-motion on the hit, then fast). Normalized clip time. */
export const VELOCITY_RAMPS = {
  velocity: [
    { t: 0, speed: 2.5 },
    { t: 0.35, speed: 2.5 },
    { t: 0.45, speed: 0.35 },
    { t: 0.75, speed: 0.35 },
    { t: 0.85, speed: 2.5 },
    { t: 1, speed: 2.5 },
  ],
  slowHit: [
    { t: 0, speed: 1.5 },
    { t: 0.4, speed: 1.5 },
    { t: 0.5, speed: 0.3 },
    { t: 1, speed: 0.3 },
  ],
  speedUp: [
    { t: 0, speed: 0.5 },
    { t: 1, speed: 3 },
  ],
} as const;
export type VelocityStyle = keyof typeof VELOCITY_RAMPS;

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

const FX_LABEL: Record<EditFxKind, string> = {
  shake: 'Shake',
  zoomPunch: 'Zoom punch',
  flash: 'Flash',
  rgbSplit: 'RGB split',
  glitch: 'Glitch',
  strobe: 'Strobe',
  letterbox: 'Letterbox',
  vhs: 'VHS',
};

let fxSeq = 0;
function fxId(): string {
  fxSeq = (fxSeq + 1) % 1e6;
  return `fx_${Date.now().toString(36)}${fxSeq.toString(36)}`;
}

export function editFx(effect: EditFxKind, params: Record<string, number> = {}): ClipEffect {
  return { id: fxId(), effect, params: { ...EDIT_FX_DEFAULTS[effect], ...params }, enabled: true };
}

/** An effect clip (on an Effects track) that hits everything below it from start for length seconds. */
export function fxClipProps(effect: EditFxKind, start: number, length: number, params: Record<string, number> = {}): Partial<ClipProps> {
  return { name: FX_LABEL[effect], start, in: 0, out: length, effects: [editFx(effect, params)] };
}

export interface BeatEffectOptions {
  effect: EditFxKind;
  beats: readonly number[];
  every?: number;
  offset?: number;
  from?: number;
  to?: number;
  /** Seconds per hit; default depends on the effect, and never runs into the next hit. */
  length?: number;
  amount?: number;
}

/**
 * Put an effect on the beats. Each effect gets its own track ("Shake on beat"), placed at the top
 * under the text, so it hits everything below. Running it again replaces that track's hits.
 */
export function beatEffectOps(state: ProjectState, sequenceId: string, o: BeatEffectOptions): { ops: Operation[]; hits: number; trackId: string } {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  const hits = pickBeats(o.beats, o.every ?? 1, o.from ?? 0, o.to ?? Infinity, o.offset ?? 0);
  const name = `${FX_LABEL[o.effect]} on beat`;
  const ops: Operation[] = [];
  const tracks = tracksOf(state, sequenceId);
  let track = tracks.find((t) => t.props.trackType === 'effect' && t.props.name === name);
  if (track) {
    for (const c of clipsOf(state, track.id)) ops.push({ kind: 'delete', id: c.id });
  } else {
    track = makeNode('track', { name, trackType: 'effect' });
    const firstNonTitle = tracks.findIndex((t) => t.props.trackType !== 'title');
    const index = firstNonTitle < 0 ? seq.children.length : seq.children.indexOf(tracks[firstNonTitle]!.id);
    ops.push({ kind: 'create', parentId: seq.id, index, nodes: [track] });
  }
  const params: Record<string, number> = o.amount !== undefined ? { amount: o.amount } : {};
  const base = o.length ?? EDIT_FX_LENGTH[o.effect];
  hits.forEach((b, i) => {
    const next = hits[i + 1];
    const len = Math.max(0.05, next !== undefined ? Math.min(base, next - b - 0.01) : base);
    ops.push({ kind: 'create', parentId: track!.id, nodes: [makeNode('clip', fxClipProps(o.effect, b, round3(len), params))] });
  });
  return { ops, hits: hits.length, trackId: track.id };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface EditSource {
  assetId: string;
  name: string;
  /** Media length in seconds (0 for pictures). */
  duration: number;
}

export interface CutToBeatsOptions {
  sources: readonly EditSource[];
  beats: readonly number[];
  /** Cut on every nth beat. */
  every?: number;
  /** Transition between cuts (none = hard cuts). */
  transition?: TransitionKind | null;
  /** Track to fill; default: the first video track. Its clips are replaced. */
  trackId?: string;
  /** Make each shot's picture fill the frame (zoomed to cover), as edits usually do. */
  fill?: boolean;
  /** Pictures/video sizes, for fill. */
  sizes?: Record<string, { width: number; height: number }>;
  velocity?: VelocityStyle | null;
}

/** Lay the sources out back to back, one shot per beat (or every nth beat), cycling through them. */
export function cutToBeatsOps(state: ProjectState, sequenceId: string, o: CutToBeatsOptions): { ops: Operation[]; cuts: number; trackId: string } {
  const seq = requireNodeOfType(state, sequenceId, 'sequence');
  if (!o.sources.length) throw new Error('Add at least one video or picture first.');
  const grid = pickBeats(o.beats, o.every ?? 1);
  if (grid.length < 2) throw new Error('Not enough beats. Find the beats of the music first.');
  const tracks = tracksOf(state, sequenceId);
  const track = o.trackId ? requireNodeOfType(state, o.trackId, 'track') : tracks.find((t) => t.props.trackType === 'video' && t.props.name !== 'Overlays') ?? tracks.find((t) => t.props.trackType === 'video');
  if (!track) throw new Error('This edit has no video track.');
  const ops: Operation[] = clipsOf(state, track.id).map((c) => ({ kind: 'delete', id: c.id }) as Operation);
  // Start at 0 so there is no black before the first beat.
  const points = grid[0]! > 0.05 ? [0, ...grid] : [...grid];
  const used = new Map<string, number>();
  for (let i = 0; i < points.length - 1; i++) {
    const src = o.sources[i % o.sources.length]!;
    const start = points[i]!;
    const len = points[i + 1]! - start;
    const ramp = o.velocity ? VELOCITY_RAMPS[o.velocity] : null;
    const avg = ramp ? rampAverage(ramp) : 1;
    const span = len * avg; // source seconds this shot needs
    let inPt = 0;
    if (src.duration > 0) {
      // Each time a source comes back, carry on from where its last shot ended.
      inPt = used.get(src.assetId) ?? 0;
      if (inPt + span > src.duration) inPt = 0;
      used.set(src.assetId, inPt + span);
    }
    const size = o.sizes?.[src.assetId];
    const scale = o.fill && size ? Math.max(seq.props.width / size.width, seq.props.height / size.height) / Math.min(seq.props.width / size.width, seq.props.height / size.height) : 1;
    const props: Partial<ClipProps> = {
      name: src.name,
      assetId: src.assetId,
      start: round3(start),
      in: round3(inPt),
      out: round3(inPt + (src.duration > 0 ? Math.min(span, src.duration) : span)),
      sourceDuration: src.duration,
      scale: round3(scale),
      speed: src.duration > 0 && span > src.duration ? round3(src.duration / len) : 1,
      speedRamp: ramp && src.duration > 0 && span <= src.duration ? ramp.map((p) => ({ ...p })) : null,
      transitionIn: i > 0 && o.transition ? transition(o.transition, Math.min(EDIT_TRANSITION_LENGTH[o.transition] ?? 0.3, len / 2)) : null,
    };
    // A picture (no duration) holds for the whole shot.
    if (src.duration <= 0) Object.assign(props, { in: 0, out: round3(len), speed: 1, speedRamp: null });
    ops.push({ kind: 'create', parentId: track.id, nodes: [makeNode('clip', props)] });
  }
  return { ops, cuts: points.length - 1, trackId: track.id };
}

function rampAverage(ramp: readonly { t: number; speed: number }[]): number {
  let acc = 0;
  for (let i = 0; i < ramp.length - 1; i++) acc += ((ramp[i]!.speed + ramp[i + 1]!.speed) / 2) * (ramp[i + 1]!.t - ramp[i]!.t);
  return acc || 1;
}

/** Ready-made edit styles: how shots are cut and which effects hit the beats. */
export const EDIT_STYLES = {
  hype: { label: 'Hype', every: 1, transition: null, velocity: null, fx: [{ effect: 'zoomPunch', every: 1 }, { effect: 'flash', every: 4 }, { effect: 'shake', every: 2, offset: 1 }] },
  smooth: { label: 'Smooth', every: 2, transition: 'zoom-punch', velocity: 'velocity', fx: [{ effect: 'letterbox', every: 0 }] },
  glitch: { label: 'Glitch', every: 1, transition: 'glitch', velocity: null, fx: [{ effect: 'rgbSplit', every: 1 }, { effect: 'glitch', every: 4 }, { effect: 'vhs', every: 0 }] },
  whip: { label: 'Whip', every: 2, transition: 'whip-left', velocity: null, fx: [{ effect: 'shake', every: 2 }] },
  flashy: { label: 'Flashy', every: 1, transition: 'flash', velocity: null, fx: [{ effect: 'strobe', every: 8 }, { effect: 'zoomPunch', every: 2 }] },
} as const satisfies Record<string, { label: string; every: number; transition: TransitionKind | null; velocity: VelocityStyle | null; fx: readonly { effect: EditFxKind; every: number; offset?: number }[] }>;
export type EditStyle = keyof typeof EDIT_STYLES;
export const EDIT_STYLE_NAMES = Object.keys(EDIT_STYLES) as EditStyle[];

/**
 * A whole edit in one go: cut the sources to the beats and add the style's effects.
 * Effects with every = 0 run for the whole edit (letterbox, VHS).
 */
export function autoEditOps(state: ProjectState, sequenceId: string, style: EditStyle, o: Omit<CutToBeatsOptions, 'every' | 'transition' | 'velocity'>): { ops: Operation[]; cuts: number; effects: number } {
  const s = EDIT_STYLES[style];
  const cut = cutToBeatsOps(state, sequenceId, { ...o, every: s.every, transition: s.transition, velocity: s.velocity, fill: o.fill ?? true });
  const ops = [...cut.ops];
  let effects = 0;
  const end = o.beats[o.beats.length - 1] ?? 0;
  for (const f of s.fx) {
    const whole = f.every === 0;
    const r = beatEffectOps(state, sequenceId, {
      effect: f.effect,
      beats: whole ? [0] : o.beats,
      every: whole ? 1 : f.every,
      offset: 'offset' in f ? f.offset : 0,
      ...(whole ? { length: Math.max(1, end) } : {}),
    });
    ops.push(...r.ops);
    effects += r.hits;
  }
  return { ops, cuts: cut.cuts, effects };
}

/** Save the beats on the sequence (they show on the timeline). */
export function setBeatsOp(seq: SceneNode<'sequence'>, a: Pick<BeatAnalysis, 'beats' | 'bpm'>): Operation {
  return { kind: 'update', id: seq.id, set: { beats: a.beats.slice(0, 20000), bpm: a.bpm || null } };
}
