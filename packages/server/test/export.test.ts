import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { makeNode, nodesOfType, layerProps, type ProjectState } from '@omnix/core';
import { importPsd } from '@omnix/exporters';
import { startTestServer, json, type TestServer } from './helpers.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let ts: TestServer;
let dir = '';

beforeAll(async () => {
  ts = await startTestServer();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-export-test-'));
});
afterAll(async () => {
  await ts.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function project(tool: string) {
  const p = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: `Export ${tool}`, primaryTool: tool } }))).project;
  const state = (await json(await ts.api(`/api/projects/${p.id}`))).state as ProjectState;
  return { id: p.id as string, state };
}

async function commit(projectId: string, op: unknown) {
  const r = await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op } });
  expect(r.status, await r.clone().text()).toBe(201);
}

async function runExport(projectId: string, body: Record<string, unknown>) {
  const r = await ts.api(`/api/projects/${projectId}/export?wait=true`, { method: 'POST', json: body });
  const j = await json(r);
  expect(j.job.status, j.job.error).toBe('done');
  const file = await ts.api(j.job.result.downloadUrl);
  return { result: j.job.result, data: Buffer.from(await file.arrayBuffer()) };
}

describe('image export', () => {
  it('exports PNG, JPEG, WebP, AVIF, SVG and layered PSD', async () => {
    const { id, state } = await project('image');
    const canvas = nodesOfType(state, 'canvas')[0]!;
    await commit(id, { kind: 'update', id: canvas.id, set: { width: 320, height: 200 } });
    await commit(id, { kind: 'create', parentId: canvas.id, nodes: [makeNode('layer', layerProps('vector', { name: 'Box', shapes: [{ id: 's', kind: 'rect', x: 20, y: 20, width: 100, height: 60, fill: '#ff0000', stroke: null, strokeWidth: 0 }] }))] });
    for (const format of ['png', 'jpeg', 'webp', 'avif']) {
      const { data, result } = await runExport(id, { nodeId: canvas.id, format, scale: 0.5 });
      const meta = await sharp(data).metadata();
      expect(meta.width).toBe(160);
      expect(result.name).toMatch(new RegExp(`\\.(${format === 'jpeg' ? 'jpg' : format})$`));
    }
    const svg = await runExport(id, { nodeId: canvas.id, format: 'svg' });
    expect(svg.data.toString()).toContain('<rect x="20" y="20" width="100" height="60"');
    const psd = await runExport(id, { nodeId: canvas.id, format: 'psd' });
    expect(importPsd(psd.data).layers.map((l) => l.name)).toEqual(['Background', 'Box']);
  });
});

describe.runIf(hasFfmpeg)('video export', () => {
  it('renders a timeline with video, a title and audio to MP4 matching the preview', async () => {
    const src = path.join(dir, 'blue.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', src]);
    const asset = (await json(await ts.api('/api/assets?name=blue.mp4', { method: 'POST', body: new Uint8Array(await fs.readFile(src)) }))).asset;
    expect(asset.kind).toBe('video');
    const { id, state } = await project('video');
    const seq = nodesOfType(state, 'sequence')[0]!;
    await commit(id, { kind: 'update', id: seq.id, set: { width: 320, height: 180, fps: 25 } });
    const video = nodesOfType(state, 'track').find((t) => t.props.trackType === 'video')!;
    const titles = nodesOfType(state, 'track').find((t) => t.props.trackType === 'title')!;
    await commit(id, { kind: 'create', parentId: video.id, nodes: [makeNode('clip', { name: 'Blue', assetId: asset.id, start: 0, in: 0, out: 2, sourceDuration: 3 })] });
    await commit(id, {
      kind: 'create',
      parentId: titles.id,
      nodes: [makeNode('clip', { name: 'Caption', start: 1, in: 0, out: 1, title: { text: 'HELLO', fontFamily: 'Inter', fontSize: 40, fontWeight: 800, color: '#ffff00', background: null, align: 'center', caption: false } })],
    });
    const { data, result } = await runExport(id, { nodeId: seq.id, format: 'web-720p' });
    expect(result.mime).toBe('video/mp4');
    const out = path.join(dir, 'out.mp4');
    await fs.writeFile(out, data);
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', out], { encoding: 'utf8' }).stdout);
    expect(Number(probe.format.duration)).toBeCloseTo(2, 0);
    expect(probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video')).toMatchObject({ width: 1280, height: 720 });
    expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio')).toBe(true);
    // First frame: blue. Frame at 1.5s: blue with a yellow title in the middle.
    const frame = (t: number) => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']).stdout;
    const f0 = await sharp(frame(0.2)).raw().toBuffer({ resolveWithObject: true });
    const px = (img: typeof f0, x: number, y: number) => [...img.data.subarray((y * img.info.width + x) * img.info.channels, (y * img.info.width + x) * img.info.channels + 3)];
    const [r0, g0, b0] = px(f0, 100, 100);
    expect(b0!).toBeGreaterThan(180);
    expect(r0!).toBeLessThan(60);
    expect(g0!).toBeLessThan(60);
    const f1 = await sharp(frame(1.5)).raw().toBuffer({ resolveWithObject: true });
    let yellow = 0;
    for (let y = 300; y < 420; y += 2) for (let x = 500; x < 780; x += 2) {
      const [r, g, b] = px(f1, x, y);
      if (r! > 180 && g! > 180 && b! < 100) yellow++;
    }
    expect(yellow).toBeGreaterThan(20);
  }, 120_000);

  it('exports animations as GIF, APNG, WebM and Lottie', async () => {
    const { id, state } = await project('animation');
    const seq = nodesOfType(state, 'sequence')[0]!;
    const layer = nodesOfType(state, 'animLayer')[0]!;
    await commit(id, { kind: 'update', id: seq.id, set: { width: 64, height: 64, duration: 0.5, fps: 12 } });
    await commit(id, {
      kind: 'update',
      id: layer.id,
      set: {
        duration: 0.5,
        frames: [{ id: 'f', hold: 1, shapes: [{ id: 'c', kind: 'ellipse', x: 10, y: 10, width: 30, height: 30, fill: '#e8590c', stroke: null, strokeWidth: 0 }], strokes: [], assetId: null }],
        keyframes: { x: [{ time: 0, value: 0, easing: 'linear' }, { time: 0.5, value: 20, easing: 'linear' }] },
      },
    });
    const gif = await runExport(id, { nodeId: seq.id, format: 'gif', scale: 1 });
    expect(gif.data.subarray(0, 6).toString()).toBe('GIF89a');
    const apng = await runExport(id, { nodeId: seq.id, format: 'apng', transparent: true });
    expect(apng.data.includes(Buffer.from('acTL'))).toBe(true);
    const webm = await runExport(id, { nodeId: seq.id, format: 'webm', transparent: true });
    expect(webm.data.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    const lottie = await runExport(id, { nodeId: seq.id, format: 'lottie' });
    const lj = JSON.parse(lottie.data.toString());
    expect(lj.fr).toBe(12);
    expect(lj.layers.length).toBeGreaterThan(1);
  }, 120_000);

  it('lists presets', async () => {
    const p = await json(await ts.api('/api/export/presets'));
    expect(p.video.map((x: { id: string }) => x.id)).toContain('reels');
  });
});
