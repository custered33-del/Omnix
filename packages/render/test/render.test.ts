import { describe, expect, it, beforeEach } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  applyOp,
  createProjectState,
  makeNode,
  nodesOfType,
  layerProps,
  setDeterministicIds,
  childrenOf,
  type ProjectState,
  type SceneNode,
  type Operation,
} from '@omnix/core';
import {
  renderCanvasDocument,
  renderSequenceFrame,
  renderSlide,
  renderProjectThumbnail,
  strokeDabs,
  frameIndexAt,
  animLayerTransform,
  elementStateAt,
  slideStepCount,
  animationGroups,
  fitShape,
  slideTextLook,
  collectAssetNeeds,
  niceTicks,
  compactNumber,
  drawChart,
  readRaster,
  type RenderHost,
  type CanvasLike,
  type Drawable,
} from '../src/index.js';

function host(images: Record<string, Drawable> = {}): RenderHost {
  return {
    createCanvas: (w, h) => createCanvas(w, h) as unknown as CanvasLike,
    image: (id) => images[id] ?? null,
  };
}

function solid(w: number, h: number, color: string): Drawable {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c as unknown as Drawable;
}

function px(c: CanvasLike, x: number, y: number): number[] {
  const r = readRaster(c);
  const i = (Math.round(y) * r.width + Math.round(x)) * 4;
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!, r.data[i + 3]!];
}

function commit(state: ProjectState, op: Operation): ProjectState {
  return applyOp(state, op).state;
}

beforeEach(() => setDeterministicIds(1));

describe('image compositor', () => {
  function canvasProject(w = 100, h = 100) {
    let state = createProjectState({ primaryTool: 'image' });
    const canvas = nodesOfType(state, 'canvas')[0]!;
    state = commit(state, { kind: 'update', id: canvas.id, set: { width: w, height: h } });
    // remove default background fill layer for clarity
    const bg = childrenOf(state, canvas.id)[0]!;
    state = commit(state, { kind: 'update', id: bg.id, set: { fillColor: '#808080' } });
    return { state, canvasId: canvas.id };
  }

  it('composites fill layers with blend modes and opacity', () => {
    let { state, canvasId } = canvasProject();
    const red = makeNode('layer', layerProps('fill', { fillColor: '#ff0000', blendMode: 'multiply' }));
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [red] });
    const out = renderCanvasDocument(host(), state, canvasId);
    const p = px(out, 50, 50);
    expect(p[0]).toBeGreaterThan(120);
    expect(p[1]).toBeLessThan(10); // multiply by red removes green
    state = commit(state, { kind: 'update', id: red.id, set: { blendMode: 'normal', opacity: 0.5 } });
    const half = px(renderCanvasDocument(host(), state, canvasId), 50, 50);
    expect(half[0]).toBeGreaterThan(180);
    expect(half[1]).toBeGreaterThan(55);
  });

  it('applies layer masks and inverted masks', () => {
    let { state, canvasId } = canvasProject();
    const blue = makeNode('layer', layerProps('fill', { fillColor: '#0000ff', mask: { source: { kind: 'rect', x: 0, y: 0, width: 50, height: 100 }, inverted: false, enabled: true } }));
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [blue] });
    let out = renderCanvasDocument(host(), state, canvasId);
    expect(px(out, 25, 50)[2]).toBe(255);
    expect(px(out, 75, 50)[2]).toBe(128);
    state = commit(state, { kind: 'update', id: blue.id, set: { mask: { source: { kind: 'rect', x: 0, y: 0, width: 50, height: 100 }, inverted: true, enabled: true } } });
    out = renderCanvasDocument(host(), state, canvasId);
    expect(px(out, 25, 50)[2]).toBe(128);
    expect(px(out, 75, 50)[2]).toBe(255);
  });

  it('applies adjustment layers to everything beneath', () => {
    let { state, canvasId } = canvasProject();
    const adj = makeNode('layer', layerProps('adjustment', { adjustment: { kind: 'invert' } }));
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [adj] });
    expect(px(renderCanvasDocument(host(), state, canvasId), 10, 10)[0]).toBe(127);
  });

  it('draws raster assets, vector shapes, text and brush strokes', () => {
    let { state, canvasId } = canvasProject(200, 100);
    const raster = makeNode('layer', layerProps('raster', { assetId: 'img1', x: 10, y: 10 }));
    const vector = makeNode(
      'layer',
      layerProps('vector', { shapes: [{ id: 's', kind: 'rect', x: 150, y: 10, width: 20, height: 20, fill: '#00ff00', stroke: null, strokeWidth: 0 }] }),
    );
    const text = makeNode('layer', layerProps('text', { text: 'Hi', x: 100, y: 60, fontSize: 30, color: '#000000' }));
    const paint = makeNode(
      'layer',
      layerProps('raster', {
        strokes: [
          {
            id: 'st',
            tool: 'brush',
            color: '#ffff00',
            size: 10,
            hardness: 1,
            opacity: 1,
            tip: 'round',
            spacing: 0.1,
            points: [
              { x: 120, y: 90, pressure: 1 },
              { x: 190, y: 90, pressure: 1 },
            ],
          },
        ],
      }),
    );
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [raster] });
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [vector] });
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [text] });
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [paint] });
    const out = renderCanvasDocument(host({ img1: solid(20, 20, '#ff00ff') }), state, canvasId);
    expect(px(out, 15, 15)).toEqual([255, 0, 255, 255]);
    expect(px(out, 160, 20)).toEqual([0, 255, 0, 255]);
    expect(px(out, 150, 90)).toEqual([255, 255, 0, 255]);
    // text produced dark pixels near its origin
    const r = readRaster(out);
    let dark = 0;
    for (let y = 60; y < 95; y++) for (let x = 100; x < 140; x++) if (r.data[(y * 200 + x) * 4]! < 60) dark++;
    expect(dark).toBeGreaterThan(20);
  });

  it('erases with the eraser tool and applies smart filters', () => {
    let { state, canvasId } = canvasProject();
    const fill = makeNode('layer', layerProps('raster', { width: 100, height: 100, strokes: [] }));
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [fill] });
    state = commit(state, {
      kind: 'listInsert',
      id: fill.id,
      prop: 'strokes',
      items: [
        { id: 'a', tool: 'brush', color: '#ffffff', size: 60, hardness: 1, opacity: 1, tip: 'square', spacing: 0.2, points: [{ x: 50, y: 50, pressure: 1 }] },
        { id: 'b', tool: 'eraser', color: '#000000', size: 10, hardness: 1, opacity: 1, tip: 'round', spacing: 0.2, points: [{ x: 50, y: 50, pressure: 1 }] },
      ],
    });
    let out = renderCanvasDocument(host(), state, canvasId);
    expect(px(out, 40, 40)[0]).toBe(255);
    expect(px(out, 50, 50)[0]).toBe(128); // erased back to background
    state = commit(state, { kind: 'update', id: fill.id, set: { filters: [{ id: 'f', filter: 'grayscale', params: {}, enabled: true, opacity: 1 }] } });
    out = renderCanvasDocument(host(), state, canvasId, { scale: 0.5 });
    expect(out.width).toBe(50);
  });

  it('renders groups and respects hidden layers', () => {
    let { state, canvasId } = canvasProject();
    const group = makeNode('layer', layerProps('group', { opacity: 0.5 }));
    const inner = makeNode('layer', layerProps('fill', { fillColor: '#000000' }));
    inner.parentId = group.id;
    group.children = [inner.id];
    state = commit(state, { kind: 'create', parentId: canvasId, nodes: [group, inner] });
    expect(px(renderCanvasDocument(host(), state, canvasId), 5, 5)[0]).toBe(64);
    expect(px(renderCanvasDocument(host(), state, canvasId, { hiddenLayers: new Set([group.id]) }), 5, 5)[0]).toBe(128);
  });
});

describe('brush dabs', () => {
  it('spaces dabs evenly and scales size with pressure', () => {
    const dabs = strokeDabs({
      size: 10,
      spacing: 0.5,
      points: [
        { x: 0, y: 0, pressure: 1 },
        { x: 50, y: 0, pressure: 1 },
      ],
    });
    expect(dabs.length).toBe(11);
    const soft = strokeDabs({ size: 10, spacing: 0.5, points: [{ x: 0, y: 0, pressure: 0 }] });
    expect(soft[0]!.radius).toBeCloseTo(1.25);
  });
});

describe('sequence frames', () => {
  function videoProject() {
    let state = createProjectState({ primaryTool: 'video' });
    const seq = nodesOfType(state, 'sequence')[0]!;
    state = commit(state, { kind: 'update', id: seq.id, set: { width: 160, height: 90 } });
    const video = nodesOfType(state, 'track').find((t) => t.props.trackType === 'video')!;
    const titles = nodesOfType(state, 'track').find((t) => t.props.trackType === 'title')!;
    return { state, seqId: seq.id, videoId: video.id, titlesId: titles.id };
  }

  it('draws the active clip and crossfades between adjacent clips', () => {
    let { state, seqId, videoId } = videoProject();
    const a = makeNode('clip', { assetId: 'red', start: 0, in: 0, out: 2 });
    const b = makeNode('clip', { assetId: 'blue', start: 2, in: 0, out: 2, transitionIn: { kind: 'crossfade', duration: 1, easing: 'linear' } });
    state = commit(state, { kind: 'create', parentId: videoId, nodes: [a] });
    state = commit(state, { kind: 'create', parentId: videoId, nodes: [b] });
    const h = host({ red: solid(16, 9, '#ff0000'), blue: solid(16, 9, '#0000ff') });
    expect(px(renderSequenceFrame(h, state, seqId, 1), 80, 45)).toEqual([255, 0, 0, 255]);
    const mid = px(renderSequenceFrame(h, state, seqId, 2.5), 80, 45);
    expect(mid[0]).toBeGreaterThan(100);
    expect(mid[2]).toBeGreaterThan(100);
    expect(px(renderSequenceFrame(h, state, seqId, 3.5), 80, 45)).toEqual([0, 0, 255, 255]);
    expect(px(renderSequenceFrame(h, state, seqId, 10), 80, 45)).toEqual([0, 0, 0, 255]);
  });

  it('applies keyframed opacity and draws titles on top', () => {
    let { state, seqId, videoId, titlesId } = videoProject();
    const a = makeNode('clip', {
      assetId: 'white',
      start: 0,
      in: 0,
      out: 4,
      keyframes: { opacity: [{ time: 0, value: 0, easing: 'linear' }, { time: 2, value: 1, easing: 'linear' }] },
    });
    state = commit(state, { kind: 'create', parentId: videoId, nodes: [a] });
    const h = host({ white: solid(16, 9, '#ffffff') });
    const at1 = px(renderSequenceFrame(h, state, seqId, 1), 80, 45);
    expect(at1[0]).toBeGreaterThan(110);
    expect(at1[0]).toBeLessThan(145);
    const title = makeNode('clip', {
      start: 0,
      in: 0,
      out: 4,
      title: { text: 'HELLO', fontFamily: 'Inter', fontSize: 30, fontWeight: 800, color: '#ff0000', background: null, align: 'center', caption: false },
    });
    state = commit(state, { kind: 'create', parentId: titlesId, nodes: [title] });
    const r = readRaster(renderSequenceFrame(h, state, seqId, 3));
    let red = 0;
    for (let i = 0; i < r.data.length; i += 4) if (r.data[i]! > 200 && r.data[i + 1]! < 80) red++;
    expect(red).toBeGreaterThan(30);
  });

  it('plays frame-by-frame animation with holds, loops and motion paths', () => {
    const frames = [
      { id: 'a', hold: 2, shapes: [], strokes: [], assetId: null },
      { id: 'b', hold: 1, shapes: [], strokes: [], assetId: null },
    ];
    expect(frameIndexAt({ frames, playback: 'loop', duration: 1 }, 0, 12)).toBe(0);
    expect(frameIndexAt({ frames, playback: 'loop', duration: 1 }, 2 / 12, 12)).toBe(1);
    expect(frameIndexAt({ frames, playback: 'loop', duration: 1 }, 3 / 12, 12)).toBe(0);
    const p = makeNode('animLayer', {
      duration: 2,
      motionPath: { path: { closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, orientToPath: false, easing: 'linear' },
    }).props;
    expect(animLayerTransform(p, 1).x).toBeCloseTo(50, 0);
  });

  it('renders animation layers inside animation sequences', () => {
    let state = createProjectState({ primaryTool: 'animation' });
    const layer = nodesOfType(state, 'animLayer')[0]!;
    const seq = nodesOfType(state, 'sequence')[0]!;
    state = commit(state, {
      kind: 'update',
      id: layer.id,
      set: { frames: [{ id: 'f', hold: 1, shapes: [{ id: 's', kind: 'rect', x: 10, y: 10, width: 50, height: 50, fill: '#00aa00', stroke: null, strokeWidth: 0 }], strokes: [], assetId: null }] },
    });
    const out = renderSequenceFrame(host(), state, seq.id, 0.5);
    expect(px(out, 30, 30)).toEqual([0, 170, 0, 255]);
  });
});

describe('slides', () => {
  it('renders title text and handles build animations by step', () => {
    let state = createProjectState({ name: 'Deck', primaryTool: 'slides' });
    const slide = nodesOfType(state, 'slide')[0]!;
    const el = makeNode('slideElement', {
      elementType: 'shape',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      shape: { id: 'r', kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '#ff0000', stroke: null, strokeWidth: 0 },
      animations: [{ id: 'a1', kind: 'fade-in', delay: 0, duration: 1, easing: 'linear', trigger: 'on-click' }],
    });
    state = commit(state, { kind: 'create', parentId: slide.id, nodes: [el] });
    expect(slideStepCount(state, slide.id)).toBe(1);
    const before = renderSlide(host(), state, slide.id, { playhead: { step: 0, t: 5 }, scale: 0.25 });
    expect(px(before, 10, 10)[0]).toBeLessThan(255);
    const after = renderSlide(host(), state, slide.id, { scale: 0.25 });
    expect(px(after, 10, 10)).toEqual([255, 0, 0, 255]);
    const vs = elementStateAt((state.nodes[el.id] as SceneNode<'slideElement'>).props, { step: 1, t: 0.5 }, 1920);
    expect(vs.opacity).toBeCloseTo(0.5);
  });

  it('runs on-click animations on their own click across elements', () => {
    const a = (trigger: 'on-enter' | 'on-click' | 'with-previous', click?: number) => ({ id: Math.random().toString(36), kind: 'fade-in' as const, delay: 0, duration: 0.5, easing: 'linear' as const, trigger, ...(click ? { click } : {}) });
    // Without a click number an on-click animation takes the next click for this element.
    expect(animationGroups([a('on-enter'), a('on-click'), a('with-previous'), a('on-click')])).toEqual([0, 1, 1, 2]);
    // With one, element B can wait for the third click even though it has a single animation.
    expect(animationGroups([a('on-click', 3), a('with-previous')])).toEqual([3, 3]);
    let state = createProjectState({ name: 'Deck', primaryTool: 'slides' });
    const slide = nodesOfType(state, 'slide')[0]!;
    state = commit(state, { kind: 'create', parentId: slide.id, nodes: [makeNode('slideElement', { elementType: 'text', text: 'B', animations: [a('on-click', 3)] })] });
    expect(slideStepCount(state, slide.id)).toBe(3);
  });

  it('stretches polygons and lines with their element', () => {
    const line = fitShape({ id: 'l', kind: 'line', x: 0, y: 0, width: 400, height: 4, points: [{ x: 0, y: 2 }, { x: 400, y: 2 }], fill: null, stroke: '#000', strokeWidth: 4 }, 800, 8);
    expect(line.points).toEqual([{ x: 0, y: 4 }, { x: 800, y: 4 }]);
    const tri = fitShape({ id: 't', kind: 'polygon', x: 0, y: 0, width: 10, height: 10, points: [{ x: 5, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], fill: '#f00', stroke: null, strokeWidth: 0 }, 100, 50);
    expect(tri.points).toEqual([{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }]);
  });

  it('makes titles bold unless an element says otherwise', () => {
    const state = createProjectState({ name: 'Deck', primaryTool: 'slides' });
    const deck = nodesOfType(state, 'deck')[0]!.props;
    const base = { elementType: 'text' as const, x: 0, y: 0, w: 100, h: 100, rotation: 0, opacity: 1, animations: [] };
    expect(slideTextLook({ ...base, role: 'title' }, deck, false).bold).toBe(true);
    expect(slideTextLook({ ...base, role: 'title', bold: false }, deck, false).bold).toBe(false);
    expect(slideTextLook({ ...base, role: 'title', valign: 'middle' }, deck, false).valign).toBe('middle');
    expect(slideTextLook({ ...base, role: 'body' }, deck, true).color).toBe('#ffffff');
  });
});

describe('charts and thumbnails', () => {
  it('computes nice ticks and compact numbers', () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(compactNumber(1500)).toBe('1.5K');
    expect(compactNumber(2_000_000)).toBe('2M');
  });

  it('draws every chart type without throwing', () => {
    for (const type of ['bar', 'line', 'area', 'scatter', 'pie'] as const) {
      const c = createCanvas(300, 200);
      drawChart(c.getContext('2d') as unknown as CanvasRenderingContext2D, { type, title: 'T', labels: ['a', 'b', 'c'], series: [{ name: 'x', values: [1, -2, 3] }, { name: 'y', values: [2, 2, 1] }] }, 0, 0, 300, 200);
    }
  });

  it('renders a thumbnail for every tool', () => {
    for (const tool of ['image', 'video', 'animation', 'code', 'document', 'slides'] as const) {
      const state = createProjectState({ name: tool, primaryTool: tool });
      const t = renderProjectThumbnail(host(), state, 240, 150);
      expect(t.width).toBe(240);
    }
  });

  it('collects asset needs including video frame times', () => {
    let state = createProjectState({ primaryTool: 'video' });
    const track = nodesOfType(state, 'track').find((t) => t.props.trackType === 'video')!;
    state = commit(state, { kind: 'create', parentId: track.id, nodes: [makeNode('clip', { assetId: 'v1', start: 1, in: 3, out: 8 })] });
    const needs = collectAssetNeeds(state, state.rootId, 2);
    expect([...needs.images]).toContain('v1');
    expect(needs.frames).toEqual([{ assetId: 'v1', time: 4 }]);
  });
});
