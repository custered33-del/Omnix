import { beforeEach, describe, expect, it } from 'vitest';
import { fadeGainAt, splitClipOp, makeNode, applyOp, autoEditOps, beatEffectOps, clipsOf, createProjectState, detectBeats, nodesOfType, setDeterministicIds, tracksOf, validateNodeProps, type ProjectState, type SceneNode } from '../src/index.js';

beforeEach(() => setDeterministicIds(1));

/** A drum-like click every 60/bpm seconds, with a little noise. */
function clickTrack(bpm: number, seconds: number, rate = 11025, startAt = 0.2): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out[i] = ((seed / 2147483648) * 2 - 1) * 0.01;
  }
  for (let t = startAt; t < seconds; t += 60 / bpm) {
    const s = Math.round(t * rate);
    for (let k = 0; k < 600 && s + k < out.length; k++) out[s + k]! += Math.sin(k * 0.9) * Math.exp(-k / 120) * 0.8;
  }
  return out;
}

const apply = (state: ProjectState, ops: Parameters<typeof applyOp>[1][]) => ops.reduce((s, op) => applyOp(s, op).state, state);

describe('Recense', () => {
  it('finds the tempo and beats of steady music', () => {
    const r = detectBeats(clickTrack(120, 12), 11025);
    expect(r.bpm).toBeGreaterThan(117);
    expect(r.bpm).toBeLessThan(123);
    expect(r.beats.length).toBeGreaterThan(20);
    const gaps = r.beats.slice(1).map((b, i) => b - r.beats[i]!);
    for (const g of gaps) expect(Math.abs(g - 0.5)).toBeLessThan(0.05);
    // Beats sit on the clicks.
    expect(Math.abs(((r.beats[0]! - 0.2) % 0.5 + 0.5) % 0.5)).toBeLessThan(0.05);
  });

  it('finds no beats in silence', () => {
    expect(detectBeats(new Float32Array(11025 * 3), 11025).beats).toEqual([]);
  });

  it('starts a vertical edit with effect, clip and music tracks', () => {
    const state = createProjectState({ primaryTool: 'recense' });
    const seq = nodesOfType(state, 'sequence')[0]!;
    expect(seq.props).toMatchObject({ purpose: 'recense', width: 1080, height: 1920 });
    expect(tracksOf(state, seq.id).map((t) => t.props.trackType)).toEqual(['title', 'effect', 'video', 'video', 'audio']);
  });

  it('cuts shots to the beats and adds a style’s effects, all valid', () => {
    let state = createProjectState({ primaryTool: 'recense' });
    const seq = nodesOfType(state, 'sequence')[0]! as SceneNode<'sequence'>;
    const beats = Array.from({ length: 17 }, (_, i) => 0.5 + i * 0.5);
    const r = autoEditOps(state, seq.id, 'hype', {
      sources: [
        { assetId: 'a1', name: 'Skate', duration: 6 },
        { assetId: 'a2', name: 'Photo', duration: 0 },
      ],
      beats,
      sizes: { a1: { width: 1920, height: 1080 }, a2: { width: 1080, height: 1080 } },
    });
    state = apply(state, r.ops);
    const main = tracksOf(state, seq.id).find((t) => t.props.name === 'Clips')!;
    const shots = clipsOf(state, main.id);
    expect(shots.length).toBe(17); // 0 → first beat, then one per beat
    expect(shots[0]!.props.start).toBe(0);
    expect(shots[1]!.props.start).toBe(0.5);
    // A landscape video zoomed to fill the tall frame.
    expect(shots[0]!.props.scale).toBeGreaterThan(3);
    const fxTracks = tracksOf(state, seq.id).filter((t) => t.props.trackType === 'effect' && t.props.name.endsWith('on beat'));
    expect(fxTracks.map((t) => t.props.name).sort()).toEqual(['Flash on beat', 'Shake on beat', 'Zoom punch on beat']);
    for (const n of Object.values(state.nodes)) expect(validateNodeProps(n.type, n.props), n.type).toEqual([]);
  });

  it('replaces an effect’s hits when run again', () => {
    let state = createProjectState({ primaryTool: 'recense' });
    const seq = nodesOfType(state, 'sequence')[0]!;
    const beats = [1, 2, 3, 4];
    state = apply(state, beatEffectOps(state, seq.id, { effect: 'shake', beats }).ops);
    state = apply(state, beatEffectOps(state, seq.id, { effect: 'shake', beats, every: 2 }).ops);
    const tr = tracksOf(state, seq.id).filter((t) => t.props.name === 'Shake on beat');
    expect(tr.length).toBe(1);
    expect(clipsOf(state, tr[0]!.id).map((c) => c.props.start)).toEqual([1, 3]);
  });

  it('fades a clip’s sound, and a split keeps each fade on its own end', () => {
    const c = { start: 2, in: 0, out: 4, speed: 1, speedRamp: null, reverse: false, fadeIn: 1, fadeOut: 2 };
    expect(fadeGainAt(c, 2)).toBe(0);
    expect(fadeGainAt(c, 2.5)).toBeCloseTo(0.5);
    expect(fadeGainAt(c, 3.5)).toBe(1);
    expect(fadeGainAt(c, 5)).toBeCloseTo(0.5);
    let state = createProjectState({ primaryTool: 'video' });
    const track = nodesOfType(state, 'track').find((t) => t.props.trackType === 'audio')!;
    const clip = makeNode('clip', { assetId: 'a', start: 0, in: 0, out: 4, fadeIn: 1, fadeOut: 1 });
    state = applyOp(state, { kind: 'create', parentId: track.id, nodes: [clip] }).state;
    state = applyOp(state, splitClipOp(state, clip.id, 2)).state;
    const [a, b] = clipsOf(state, track.id);
    expect([a!.props.fadeIn, a!.props.fadeOut]).toEqual([1, 0]);
    expect([b!.props.fadeIn, b!.props.fadeOut]).toEqual([0, 1]);
  });
});
