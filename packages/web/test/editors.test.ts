import { describe, expect, it } from 'vitest';
import { createProjectState, makeNode, nodesOfType, type AnimLayerProps, type ProjectState, type SceneNode } from '@omnix/core';
import { dbToGain, timecode, toFrame } from '../src/editors/video/timelineState.js';
import { snap, snapPoints } from '../src/editors/video/timelineOps.js';
import { fromLayer, toLayer } from '../src/editors/animation/useAnimationStage.js';
import { languageForPath } from '../src/editors/code/CodeMirror.js';
import { describeChart } from '../src/components/ChartView.js';
import { formatBytes, formatTimecode, plural, t } from '../src/i18n/index.js';

describe('timeline maths', () => {
  it('formats timecode and snaps to frames', () => {
    expect(timecode(0, 30)).toBe('00:00:00:00');
    expect(timecode(61.5, 30)).toBe('00:01:01:15');
    expect(timecode(3600, 24)).toBe('01:00:00:00');
    expect(toFrame(1.017, 30)).toBeCloseTo(1.0333, 3);
  });

  it('converts decibels to gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(-80)).toBe(0);
  });

  it('snaps to clip edges and the playhead within a pixel threshold', () => {
    const state: ProjectState = createProjectState({ primaryTool: 'video' });
    const seq = nodesOfType(state, 'sequence')[0]!;
    const track = nodesOfType(state, 'track').find((tr) => tr.props.trackType === 'video')!;
    const clip = makeNode('clip', { start: 2, in: 0, out: 3 });
    clip.parentId = track.id;
    const s2: ProjectState = { ...state, nodes: { ...state.nodes, [clip.id]: clip, [track.id]: { ...track, children: [clip.id] } } };
    const pts = snapPoints(s2, seq.id, 7.5, new Set());
    expect(pts).toEqual(expect.arrayContaining([0, 7.5, 2, 5]));
    // 100 px/s: 4.95s is 5px from the clip end at 5s, so it snaps.
    expect(snap(4.95, pts, 100)).toEqual({ t: 5, to: 5 });
    // 4.8s is 20px away: no snap.
    expect(snap(4.8, pts, 100)).toEqual({ t: 4.8, to: null });
    // Excluded items do not attract.
    expect(snapPoints(s2, seq.id, 0, new Set([clip.id]))).not.toContain(5);
  });
});

describe('animation layer space', () => {
  it('maps points into a transformed layer and back', () => {
    const p = makeNode('animLayer', { x: 300, y: 200, scale: 2, rotation: 30, anchorX: 10, anchorY: -5 }).props as AnimLayerProps;
    const pt = { x: 412, y: 260 };
    const local = toLayer(p, 0, pt);
    const back = fromLayer(p, 0, local);
    expect(back.x).toBeCloseTo(pt.x, 6);
    expect(back.y).toBeCloseTo(pt.y, 6);
    // The layer origin maps to its anchor.
    const origin = toLayer(p, 0, { x: 300, y: 200 });
    expect(origin.x).toBeCloseTo(10, 6);
    expect(origin.y).toBeCloseTo(-5, 6);
  });

  it('follows keyframed position at the given time', () => {
    const layer = makeNode('animLayer', { start: 1, x: 0, keyframes: { x: [{ time: 0, value: 0, easing: 'linear' }, { time: 2, value: 200, easing: 'linear' }] } }) as SceneNode<'animLayer'>;
    // At sequence time 2 (local 1) the layer is at x=100, so sequence x=100 is the layer anchor.
    expect(toLayer(layer.props, 2, { x: 100, y: 0 }).x).toBeCloseTo(0, 6);
  });
});

describe('code editor helpers', () => {
  it('picks a language from the file name', () => {
    expect(languageForPath('analysis.py')).toBe('python');
    expect(languageForPath('src/app.tsx')).toBe('typescript');
    expect(languageForPath('README.md')).toBe('markdown');
    expect(languageForPath('data.csv')).toBe('text');
  });
});

describe('charts and messages', () => {
  it('describes a chart for screen readers', () => {
    const d = describeChart({ type: 'bar', title: 'Visits', labels: ['Mon', 'Tue'], series: [{ name: 'Web', values: [1200, 3400] }] });
    expect(d).toContain('Bar chart: Visits');
    expect(d).toContain('2 categories');
    expect(d).toContain('1.2K');
    expect(d).toContain('table view');
  });

  it('interpolates and pluralizes messages', () => {
    expect(t('dashboard.greeting', { name: 'Seb' })).toBe('Good to see you, Seb');
    expect(plural('dashboard.projectCount', 1)).toBe('1 project');
    expect(plural('dashboard.projectCount', 3)).toBe('3 projects');
    expect(formatBytes(1536)).toMatch(/1\.5\s?KB/);
    expect(formatTimecode(62, 30)).toContain('1:02');
  });
});

describe('animation layers on the timeline', () => {
  it('puts layers that overlap in time on separate rows and reuses rows when they do not', async () => {
    const { layerRows } = await import('../src/editors/video/Timeline.js');
    const layer = (id: string, start: number, duration: number) => ({ ...makeNode('animLayer', { name: id, start, duration } as Partial<AnimLayerProps>), id }) as SceneNode;
    const rows = layerRows([layer('a', 0, 2), layer('b', 1, 2), layer('c', 2, 1), layer('d', 0.5, 0.2)]);
    // a takes row 0; d overlaps it, so row 1; b starts after d has ended, so row 1 again.
    expect(rows.count).toBe(2);
    expect(rows.of.get('a')).toBe(0);
    expect(rows.of.get('d')).toBe(1);
    expect(rows.of.get('b')).toBe(1);
    // c starts where a ends, so it can share a's row.
    expect(rows.of.get('c')).toBe(0);
    expect(layerRows([layer('x', 0, 1), layer('y', 1, 1)]).count).toBe(1);
  });
});
