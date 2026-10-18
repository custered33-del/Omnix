import { describe, expect, it, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { applyOp, createProjectState, layerProps, makeNode, nodesOfType, setDeterministicIds, childrenOf, type Operation, type ProjectState } from '@omnix/core';
import type { CanvasLike, RenderHost } from '@omnix/render';
import { createRaster, setPixel } from '@omnix/imaging';
import {
  exportPsd,
  importPsd,
  exportSvg,
  encodeGif,
  encodeApng,
  decodeApng,
  exportLottie,
  toSrt,
  toVtt,
  parseSubtitles,
  spriteAtlas,
  sliceGrid,
  buildAudioGraph,
  buildExportArgs,
  presetById,
  outputSize,
  atempoChain,
  volumeExpression,
  toPsdAdjustment,
  VIDEO_PRESETS,
} from '../src/index.js';

const host: RenderHost = { createCanvas: (w, h) => createCanvas(w, h) as unknown as CanvasLike, image: () => null };
const commit = (s: ProjectState, op: Operation) => applyOp(s, op).state;

beforeEach(() => setDeterministicIds(1));

function layeredCanvas() {
  let state = createProjectState({ primaryTool: 'image', name: 'Poster' });
  const canvas = nodesOfType(state, 'canvas')[0]!;
  state = commit(state, { kind: 'update', id: canvas.id, set: { width: 64, height: 48 } });
  const red = makeNode('layer', layerProps('vector', { name: 'Red box', blendMode: 'multiply', opacity: 0.8, shapes: [{ id: 's', kind: 'rect', x: 8, y: 8, width: 20, height: 20, fill: '#ff0000', stroke: null, strokeWidth: 0 }] }));
  const text = makeNode('layer', layerProps('text', { name: 'Title', text: 'Hi', x: 30, y: 10, fontSize: 16, color: '#0000ff' }));
  const group = makeNode('layer', layerProps('group', { name: 'Group' }));
  const inner = makeNode('layer', layerProps('fill', { name: 'Inner fill', fillColor: '#00ff00', mask: { source: { kind: 'rect', x: 40, y: 30, width: 10, height: 10 }, inverted: false, enabled: true } }));
  inner.parentId = group.id;
  group.children = [inner.id];
  const adj = makeNode('layer', layerProps('adjustment', { name: 'Invert', adjustment: { kind: 'invert' }, visible: false }));
  state = commit(state, { kind: 'create', parentId: canvas.id, nodes: [red] });
  state = commit(state, { kind: 'create', parentId: canvas.id, nodes: [text] });
  state = commit(state, { kind: 'create', parentId: canvas.id, nodes: [group, inner] });
  state = commit(state, { kind: 'create', parentId: canvas.id, nodes: [adj] });
  return { state, canvasId: canvas.id };
}

describe('PSD', () => {
  it('exports layers, groups, blend modes, text, masks and adjustments, and reads them back', () => {
    const { state, canvasId } = layeredCanvas();
    const { data, notes } = exportPsd(host, state, canvasId);
    expect(data.subarray(0, 4).toString()).toBe('8BPS');
    expect(notes).toEqual([]);
    const psd = importPsd(data);
    expect(psd.width).toBe(64);
    expect(psd.layers.map((l) => l.name)).toEqual(['Background', 'Red box', 'Title', 'Group', 'Invert']);
    const red = psd.layers[1]!;
    expect(red.blendMode).toBe('multiply');
    expect(red.opacity).toBeCloseTo(0.8, 1);
    expect(red.left).toBe(8);
    expect(red.pixels!.width).toBe(20);
    expect(psd.layers[2]!.text).toBe('Hi');
    expect(psd.layers[3]!.children![0]!.name).toBe('Inner fill');
    expect(psd.layers[3]!.children![0]!.mask).not.toBeNull();
    expect(psd.layers[4]!.hidden).toBe(true);
    expect(psd.composite!.width).toBe(64);
  });

  it('maps adjustments to native PSD adjustment layers where possible', () => {
    expect(toPsdAdjustment({ kind: 'invert' })).toEqual({ type: 'invert' });
    expect(toPsdAdjustment({ kind: 'curves', channel: 'rgb', points: [[0, 0], [255, 255]] })).toMatchObject({ type: 'curves' });
    expect(toPsdAdjustment({ kind: 'lut', assetId: 'x', intensity: 1 })).toBeNull();
  });
});

describe('SVG', () => {
  it('keeps vector and text native, embeds rasters and masks', () => {
    const { state, canvasId } = layeredCanvas();
    const svg = exportSvg(host, state, canvasId, { encodePng: (c) => (c as unknown as { toBuffer(m: string): Buffer }).toBuffer('image/png').toString('base64') });
    expect(svg).toContain('<svg');
    expect(svg).toContain('<rect x="8" y="8" width="20" height="20"');
    expect(svg).toContain('mix-blend-mode:multiply');
    expect(svg).toContain('<tspan');
    expect(svg).toContain('>Hi</tspan>');
    expect(svg).toContain('<mask id="m1"');
    expect(svg).not.toContain('Invert'); // hidden adjustment layer is skipped
  });
});

describe('animated images', () => {
  const frames = [0, 1, 2].map((i) => {
    const r = createRaster(8, 8, [0, 0, 0, 0]);
    setPixel(r, i, i, [255, 0, 0, 255]);
    return r;
  });

  it('encodes GIF', () => {
    const gif = encodeGif(frames, { fps: 12, loops: 0 });
    expect(gif.subarray(0, 6).toString()).toBe('GIF89a');
    expect(gif.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
  });

  it('encodes and decodes APNG losslessly', () => {
    const apng = encodeApng(frames, { fps: 10, loops: 2 });
    const back = decodeApng(apng);
    expect(back.frames).toHaveLength(3);
    expect([...back.frames[1]!.data.subarray((1 * 8 + 1) * 4, (1 * 8 + 1) * 4 + 4)]).toEqual([255, 0, 0, 255]);
    expect(back.delays[0]).toBe(100);
  });
});

describe('Lottie', () => {
  it('exports frames, keyframes with easing, motion paths and rigs', () => {
    let state = createProjectState({ primaryTool: 'animation', name: 'Bounce' });
    const seq = nodesOfType(state, 'sequence')[0]!;
    const layer = nodesOfType(state, 'animLayer')[0]!;
    state = commit(state, {
      kind: 'update',
      id: layer.id,
      set: {
        frames: [
          { id: 'f1', hold: 2, shapes: [{ id: 'a', kind: 'ellipse', x: 0, y: 0, width: 40, height: 40, fill: '#ff8800', stroke: null, strokeWidth: 0 }], strokes: [], assetId: null },
          { id: 'f2', hold: 1, shapes: [], strokes: [{ id: 'st', tool: 'brush', color: '#000000', size: 6, hardness: 1, opacity: 1, tip: 'round', spacing: 0.1, points: [{ x: 0, y: 0, pressure: 1 }, { x: 10, y: 10, pressure: 1 }] }], assetId: null },
        ],
        keyframes: { y: [{ time: 0, value: 0, easing: 'ease-out' }, { time: 1, value: 100, easing: 'linear' }], opacity: [{ time: 0, value: 0, easing: 'linear' }, { time: 0.5, value: 1, easing: 'linear' }] },
        rig: {
          bones: [
            { id: 'b1', name: 'Arm', parentId: null, length: 50, angle: 0, x: 0, y: 0, attachment: { assetId: null, shape: { id: 'r', kind: 'rect', x: 0, y: -5, width: 50, height: 10, fill: '#333333', stroke: null, strokeWidth: 0 }, offsetX: 0, offsetY: 0 } },
          ],
          poses: [{ time: 0, angles: { b1: 0 }, easing: 'linear' }, { time: 1, angles: { b1: 1 }, easing: 'linear' }],
        },
      },
    });
    const { json, notes } = exportLottie(state, seq.id, () => null);
    expect(json.fr).toBe(24);
    expect(json.op).toBe(96);
    const layers = json.layers as { ty: number; nm: string; ip: number; op: number; ks: { p: { a: number; k: { t: number; s: number[]; o?: { x: number[] } }[] }; o: { a: number } }; parent?: number; shapes?: unknown[] }[];
    const nul = layers.find((l) => l.ty === 3)!;
    expect(nul.ks.p.a).toBe(1);
    expect(nul.ks.p.k[0]!.o!.x).toEqual([0]); // ease-out bezier x1 = 0
    expect(nul.ks.p.k.at(-1)!.s[1]).toBe(100);
    expect(nul.ks.o.a).toBe(1);
    const frameLayers = layers.filter((l) => l.nm.includes('frame'));
    expect(frameLayers[0]!.ip).toBe(0);
    expect(frameLayers[0]!.op).toBe(2);
    expect(frameLayers[1]!.ip).toBe(2);
    expect(frameLayers.every((l) => l.parent === 1)).toBe(true);
    const bone = layers.find((l) => l.nm.includes('Arm'))!;
    expect((bone.ks as unknown as { r: { a: number } }).r.a).toBe(1);
    expect(notes).toEqual([]);
  });
});

describe('captions', () => {
  it('round-trips SRT and VTT', () => {
    const cues = [
      { start: 0.5, end: 2.25, text: 'Hello there' },
      { start: 3661.001, end: 3662, text: 'Two\nlines' },
    ];
    expect(toSrt(cues)).toContain('00:00:00,500 --> 00:00:02,250');
    expect(toVtt(cues)).toMatch(/^WEBVTT/);
    expect(parseSubtitles(toSrt(cues))).toEqual(cues);
    expect(parseSubtitles(toVtt(cues))).toEqual(cues);
    expect(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000 align:start\n<b>Bold</b>\n')).toEqual([{ start: 1, end: 2, text: 'Bold' }]);
  });
});

describe('sprite sheets', () => {
  it('builds atlases and slices grids', () => {
    const atlas = spriteAtlas('walk', 'walk.png', 6, 3, 32, 32, 12);
    expect(Object.keys(atlas.frames)).toHaveLength(6);
    expect(atlas.frames.walk_0004!.frame).toEqual({ x: 32, y: 32, w: 32, h: 32 });
    expect(atlas.meta.size).toEqual({ w: 96, h: 64 });
    expect(sliceGrid(128, 64, { frameWidth: 32, frameHeight: 32 })).toEqual({ columns: 4, rows: 2, frameWidth: 32, frameHeight: 32, frameCount: 8 });
  });
});

describe('ffmpeg builders', () => {
  it('chains atempo for extreme speeds and builds volume automation', () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(4)).toEqual(['atempo=2.0', 'atempo=2.0']);
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    const expr = volumeExpression([{ time: 0, value: -60, easing: 'linear' }, { time: 1, value: 0, easing: 'linear' }], 0, 2);
    expect(expr).toContain('lt(t,2.0000)');
    expect(volumeExpression(undefined, -6, 0)).toBe('0.501187');
  });

  it('sizes outputs per preset', () => {
    expect(outputSize(presetById('reels'), 1920, 1080)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(presetById('prores-hq'), 1279, 721)).toEqual({ width: 1280, height: 722 });
    expect(VIDEO_PRESETS.length).toBeGreaterThanOrEqual(10);
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  it.runIf(hasFfmpeg)('mixes a real timeline with trims, speed, pan and ducking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-mix-'));
    try {
      const music = path.join(dir, 'music.wav');
      const voice = path.join(dir, 'voice.wav');
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-y', music]);
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-y', voice]);
      let state = createProjectState({ primaryTool: 'video' });
      const seq = nodesOfType(state, 'sequence')[0]!;
      const audio = nodesOfType(state, 'track').find((t) => t.props.trackType === 'audio')!;
      const voiceTrack = makeNode('track', { name: 'Voice', trackType: 'audio' });
      state = commit(state, { kind: 'create', parentId: seq.id, nodes: [voiceTrack] });
      state = commit(state, { kind: 'update', id: audio.id, set: { pan: -0.5, ducking: { enabled: true, sourceTrackId: voiceTrack.id, amountDb: -12 } } });
      state = commit(state, { kind: 'create', parentId: audio.id, nodes: [makeNode('clip', { assetId: 'music', start: 0, in: 0, out: 6, speed: 1.5, keyframes: { volume: [{ time: 0, value: -20, easing: 'linear' }, { time: 1, value: 0, easing: 'linear' }] } })] });
      state = commit(state, { kind: 'create', parentId: voiceTrack.id, nodes: [makeNode('clip', { assetId: 'voice', start: 1, in: 0, out: 2, reverse: true })] });
      const graph = buildAudioGraph(state, seq.id, (id) => ({ path: id === 'music' ? music : voice, hasAudio: true }), { inputOffset: 0, duration: 4 });
      expect(graph.inputs).toHaveLength(2);
      expect(graph.filter).toContain('sidechaincompress');
      expect(graph.filter).toContain('areverse');
      expect(graph.filter).toContain('atempo=1.500000');
      const out = path.join(dir, 'mix.wav');
      const args = buildExportArgs(presetById('audio-wav'), { frameWidth: 16, frameHeight: 16, fps: 30, duration: 4, audio: graph, outputPath: out });
      const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=channels', '-of', 'json', out], { encoding: 'utf8' });
      const info = JSON.parse(probe.stdout);
      expect(Number(info.format.duration)).toBeCloseTo(4, 1);
      expect(info.streams[0].channels).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(hasFfmpeg)('fades sound in and out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-fade-'));
    try {
      const tone = path.join(dir, 'tone.wav');
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-y', tone]);
      let state = createProjectState({ primaryTool: 'video' });
      const seq = nodesOfType(state, 'sequence')[0]!;
      const audio = nodesOfType(state, 'track').find((t) => t.props.trackType === 'audio')!;
      state = commit(state, { kind: 'create', parentId: audio.id, nodes: [makeNode('clip', { assetId: 'tone', start: 0, in: 0, out: 4, fadeIn: 1, fadeOut: 1 })] });
      const graph = buildAudioGraph(state, seq.id, () => ({ path: tone, hasAudio: true }), { inputOffset: 0, duration: 4 });
      expect(graph.filter).toContain('afade=t=in');
      expect(graph.filter).toContain('afade=t=out:st=3.0000');
      const out = path.join(dir, 'mix.wav');
      const r = spawnSync('ffmpeg', buildExportArgs(presetById('audio-wav'), { frameWidth: 16, frameHeight: 16, fps: 30, duration: 4, audio: graph, outputPath: out }), { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 24 }).stdout as Buffer;
      const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      const rms = (from: number, to: number) => Math.sqrt(samples.slice(from * 8000, to * 8000).reduce((a, v) => a + v * v, 0) / ((to - from) * 8000));
      expect(rms(0, 0.1)).toBeLessThan(rms(1.5, 2.5) * 0.2);
      expect(rms(3.9, 4)).toBeLessThan(rms(1.5, 2.5) * 0.2);
      expect(rms(1.5, 2.5)).toBeGreaterThan(0.05);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a video command with letterboxing or cropping', () => {
    const args = buildExportArgs(presetById('reels'), { frameWidth: 1920, frameHeight: 1080, fps: 30, duration: 2, audio: { inputs: [], filter: '', output: null }, outputPath: '/tmp/x.mp4' });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    expect(fc).toContain('crop=1080:1920');
    expect(args).toContain('libx264');
  });
});

void childrenOf;
