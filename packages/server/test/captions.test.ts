import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeNode, nodesOfType, clipsOf, type ProjectState } from '@omnix/core';
import { detectSpeech, toCaptionLines, encodeWav } from '../src/captions/stt.js';
import { startTestServer, json, type TestServer } from './helpers.js';

describe('voice activity detection', () => {
  it('finds speech-like bursts and ignores silence', () => {
    const rate = 16000;
    const s = new Float32Array(rate * 5);
    const burst = (from: number, to: number) => {
      for (let i = Math.floor(from * rate); i < to * rate; i++) s[i] = 0.4 * Math.sin((i / rate) * 2 * Math.PI * 220) * (0.6 + 0.4 * Math.sin(i / 300));
    };
    for (let i = 0; i < s.length; i++) s[i] = (Math.random() - 0.5) * 0.002;
    burst(0.5, 1.6);
    burst(2.8, 4.1);
    const r = detectSpeech(s, rate);
    expect(r).toHaveLength(2);
    expect(r[0]!.start).toBeCloseTo(0.42, 1);
    expect(r[0]!.end).toBeCloseTo(1.68, 1);
    expect(r[1]!.start).toBeCloseTo(2.72, 1);
    expect(detectSpeech(new Float32Array(rate), rate)).toEqual([]);
  });

  it('splits long lines and encodes WAV', () => {
    const lines = toCaptionLines([{ start: 0, end: 10, text: 'word '.repeat(60).trim() }], 84);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)!.end).toBeCloseTo(10, 2);
    expect(encodeWav(new Float32Array(10), 16000).length).toBe(64);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.runIf(hasFfmpeg)('captions on the timeline', () => {
  let ts: TestServer;
  beforeAll(async () => {
    ts = await startTestServer();
  });
  afterAll(async () => {
    await ts.close();
  });

  it('places caption slots from detected speech and imports SRT', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-cap-'));
    const wav = path.join(dir, 'talk.wav');
    // Two tone bursts separated by silence stand in for speech.
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=1', '-f', 'lavfi', '-i', 'anullsrc=d=1:r=44100', '-f', 'lavfi', '-i', 'sine=f=400:d=1.2', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-y', wav]);
    const asset = (await json(await ts.api('/api/assets?name=talk.wav', { method: 'POST', body: new Uint8Array(await fs.readFile(wav)) }))).asset;
    const p = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Talk', primaryTool: 'video' } }))).project;
    let state = (await json(await ts.api(`/api/projects/${p.id}`))).state as ProjectState;
    const seq = nodesOfType(state, 'sequence')[0]!;
    const audio = nodesOfType(state, 'track').find((t) => t.props.trackType === 'audio')!;
    await ts.api(`/api/projects/${p.id}/commits`, { method: 'POST', json: { op: { kind: 'create', parentId: audio.id, nodes: [makeNode('clip', { assetId: asset.id, start: 2, in: 0, out: 3.2, sourceDuration: 3.2 })] } } });
    const provider = await json(await ts.api('/api/captions/provider'));
    expect(provider.id).toBe('vad');
    const r = await json(await ts.api(`/api/projects/${p.id}/captions/generate?wait=true`, { method: 'POST', json: { sequenceId: seq.id } }));
    expect(r.job.status, r.job.error).toBe('done');
    expect(r.job.result).toMatchObject({ count: 2, hasText: false });
    state = (await json(await ts.api(`/api/projects/${p.id}`))).state;
    const capTrack = nodesOfType(state, 'track').find((t) => t.props.name === 'Captions')!;
    const caps = clipsOf(state, capTrack.id);
    expect(caps).toHaveLength(2);
    expect(caps[0]!.props.start).toBeGreaterThan(1.8); // shifted to the clip's timeline position
    expect(caps[0]!.props.title!.caption).toBe(true);

    const srt = '1\n00:00:00,500 --> 00:00:01,500\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nWorld\n';
    const imp = await json(await ts.api(`/api/projects/${p.id}/captions/import`, { method: 'POST', json: { sequenceId: seq.id, text: srt } }));
    expect(imp.count).toBe(2);
    state = (await json(await ts.api(`/api/projects/${p.id}`))).state;
    const texts = clipsOf(state, capTrack.id).map((c) => c.props.title!.text);
    expect(texts).toContain('Hello');
    const exp = await json(await ts.api(`/api/projects/${p.id}/export?wait=true`, { method: 'POST', json: { nodeId: seq.id, format: 'srt' } }));
    const file = await (await ts.api(exp.job.result.downloadUrl)).text();
    expect(file).toContain('Hello');
    await fs.rm(dir, { recursive: true, force: true });
  }, 60_000);
});
