import { describe, expect, it, beforeEach } from 'vitest';
import {
  createProjectState,
  nodesOfType,
  applyOp,
  addClipOp,
  splitClipOp,
  rippleDeleteOp,
  rippleTrimOp,
  rollEditOp,
  slipEditOp,
  slideEditOp,
  moveClipOp,
  setSpeedOp,
  clipsOf,
  clipDuration,
  clipEnd,
  sourceTimeAt,
  activeClipsAt,
  contentDuration,
  findOverlaps,
  clipPropsAt,
  setDeterministicIds,
  type ProjectState,
} from '../src/index.js';

beforeEach(() => setDeterministicIds(1));

function threeClips(): { state: ProjectState; trackId: string; ids: string[] } {
  let state = createProjectState({ primaryTool: 'video' });
  const track = nodesOfType(state, 'track').find((t) => t.props.trackType === 'video')!;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const op = addClipOp(state, track.id, { name: `C${i}`, assetId: `a${i}`, in: 1, out: 5, sourceDuration: 10 });
    state = applyOp(state, op).state;
    ids.push(clipsOf(state, track.id)[i]!.id);
  }
  return { state, trackId: track.id, ids };
}

const starts = (s: ProjectState, trackId: string) => clipsOf(s, trackId).map((c) => c.props.start);

describe('timeline maths', () => {
  it('appends clips end to end', () => {
    const { state, trackId } = threeClips();
    expect(starts(state, trackId)).toEqual([0, 4, 8]);
    expect(contentDuration(state, nodesOfType(state, 'sequence')[0]!.id)).toBe(12);
  });

  it('maps sequence time to source time with speed and reverse', () => {
    const c = { start: 10, in: 2, out: 6, speed: 2, reverse: false, speedRamp: null };
    expect(clipDuration(c)).toBe(2);
    expect(sourceTimeAt(c, 11)).toBe(4);
    expect(sourceTimeAt({ ...c, reverse: true }, 11)).toBe(4);
    expect(sourceTimeAt({ ...c, reverse: true }, 10)).toBe(6);
    expect(sourceTimeAt(c, 13)).toBeNull();
  });

  it('handles speed ramps by integrating speed', () => {
    const ramp = [
      { t: 0, speed: 1 },
      { t: 1, speed: 3 },
    ];
    const c = { start: 0, in: 0, out: 4, speed: 1, reverse: false, speedRamp: ramp };
    expect(clipDuration(c)).toBeCloseTo(2);
    expect(sourceTimeAt(c, 2)).toBeCloseTo(4);
    expect(sourceTimeAt(c, 1)!).toBeLessThan(2); // slower at the beginning
  });

  it('finds active clips', () => {
    const { state, ids } = threeClips();
    const seq = nodesOfType(state, 'sequence')[0]!;
    expect(activeClipsAt(state, seq.id, 5).map((a) => a.clip.id)).toEqual([ids[1]]);
  });

  it('evaluates clip keyframes relative to clip start', () => {
    const { state, ids } = threeClips();
    const clip = state.nodes[ids[1]!]!.props as never as Parameters<typeof clipPropsAt>[0];
    const p = clipPropsAt({ ...clip, keyframes: { opacity: [{ time: 0, value: 0, easing: 'linear' }, { time: 2, value: 1, easing: 'linear' }] } }, 5);
    expect(p.opacity).toBeCloseTo(0.5);
  });
});

describe('edit operations', () => {
  it('splits a clip into two continuous halves', () => {
    const { state, trackId, ids } = threeClips();
    const s = applyOp(state, splitClipOp(state, ids[0]!, 1.5)).state;
    const clips = clipsOf(s, trackId);
    expect(clips).toHaveLength(4);
    expect(clips[0]!.props).toMatchObject({ in: 1, out: 2.5 });
    expect(clips[1]!.props).toMatchObject({ start: 1.5, in: 2.5, out: 5 });
    expect(() => splitClipOp(state, ids[0]!, 0)).toThrow();
  });

  it('ripple deletes', () => {
    const { state, trackId, ids } = threeClips();
    const s = applyOp(state, rippleDeleteOp(state, ids[0]!)).state;
    expect(starts(s, trackId)).toEqual([0, 4]);
  });

  it('ripple trims the out point and shifts later clips', () => {
    const { state, trackId, ids } = threeClips();
    const s = applyOp(state, rippleTrimOp(state, ids[0]!, 'out', -1)).state;
    expect(starts(s, trackId)).toEqual([0, 3, 7]);
    expect(findOverlaps(s, trackId)).toEqual([]);
  });

  it('roll edits keep total duration', () => {
    const { state, trackId, ids } = threeClips();
    const s = applyOp(state, rollEditOp(state, ids[0]!, ids[1]!, 1)).state;
    const c = clipsOf(s, trackId);
    expect(clipEnd(c[0]!.props)).toBe(5);
    expect(c[1]!.props.start).toBe(5);
    expect(clipEnd(c[1]!.props)).toBe(8);
    expect(findOverlaps(s, trackId)).toEqual([]);
  });

  it('slip edits shift source range within limits', () => {
    const { state, ids } = threeClips();
    const s = applyOp(state, slipEditOp(state, ids[1]!, 2)).state;
    expect(s.nodes[ids[1]!]!.props).toMatchObject({ in: 3, out: 7, start: 4 });
    const s2 = applyOp(state, slipEditOp(state, ids[1]!, 100)).state;
    expect(s2.nodes[ids[1]!]!.props).toMatchObject({ in: 6, out: 10 });
  });

  it('slide edits move a clip between neighbours without changing total length', () => {
    const { state, trackId, ids } = threeClips();
    const s = applyOp(state, slideEditOp(state, ids[1]!, 1)).state;
    const c = clipsOf(s, trackId);
    expect(clipEnd(c[0]!.props)).toBe(5);
    expect(c[1]!.props.start).toBe(5);
    expect(c[2]!.props.start).toBe(9);
    expect(clipEnd(c[2]!.props)).toBe(12);
    expect(findOverlaps(s, trackId)).toEqual([]);
  });

  it('moves clips across tracks', () => {
    const { state, ids } = threeClips();
    const title = nodesOfType(state, 'track').find((t) => t.props.trackType === 'title')!;
    const s = applyOp(state, moveClipOp(state, ids[2]!, 20, title.id)).state;
    expect(s.nodes[ids[2]!]!.parentId).toBe(title.id);
    expect((s.nodes[ids[2]!]!.props as { start: number }).start).toBe(20);
  });

  it('changes speed with ripple', () => {
    const { state, trackId, ids } = threeClips();
    const s = applyOp(state, setSpeedOp(state, ids[0]!, 2, { ripple: true })).state;
    expect(starts(s, trackId)).toEqual([0, 2, 6]);
    expect(() => setSpeedOp(state, ids[0]!, 0)).toThrow();
  });
});
