import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ProjectState, SceneNode } from '@omnix/core';
import type { SpeechProvider } from '../src/captions/stt.js';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let auto: Client;

async function call(name: string, args: Record<string, unknown>) {
  const r = await auto.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return r as { structuredContent: Record<string, any>; content: { type: string; text?: string }[] };
}

beforeAll(async () => {
  ts = await startTestServer();
  const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude', scopes: ['omnix:read', 'omnix:edit', 'omnix:autonomous'] } }));
  auto = new Client({ name: 'Claude', version: '1.0.0' });
  await auto.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});

afterAll(async () => {
  await auto?.close().catch(() => {});
  await ts?.close();
});

describe('video awareness', () => {
  it('hears what is said, sees each moment with coordinates, and makes a sticker follow something that moves', async () => {
    // A white square sliding right across a black 640×360 frame (100 px a second), with sound.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-aware-'));
    const mp4 = path.join(dir, 'slide.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'color=c=white:s=40x40:r=25:d=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-filter_complex', "[0][1]overlay=x='40+t*100':y=150", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
    const p = (await call('create_project', { name: 'Hand', primaryTool: 'video' })).structuredContent;
    const seq = p.documentId as string;
    const up = async (name: string, data: Buffer, type: string) => (await json(await ts.api(`/api/assets?name=${name}&projectId=${p.projectId}`, { method: 'POST', body: new Uint8Array(data), headers: { 'content-type': type } }))).asset as { id: string };
    const video = await up('slide.mp4', fs.readFileSync(mp4), 'video/mp4');
    await call('video_add_clip', { projectId: p.projectId, sequenceId: seq, assetId: video.id });

    // Hearing: the transcript comes from the speech model (a stand-in here) in timeline time.
    const heard: SpeechProvider = { id: 'test', label: 'Test', transcribe: async () => ({ segments: [{ start: 0.5, end: 2, text: 'Look at my hand.' }], provider: 'test', hasText: true }) };
    ts.omnix.services.ext.speechProvider = heard;
    const tr = await call('video_transcript', { projectId: p.projectId, sequenceId: seq });
    expect(tr.structuredContent.lines).toEqual([{ start: 0.5, end: 2, text: 'Look at my hand.' }]);

    // Seeing: frames come back as pictures, with what is on screen and what is said.
    const look = await call('video_look', { projectId: p.projectId, sequenceId: seq, count: 3, maxSize: 256 });
    expect(look.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(look.structuredContent.frames[0].onScreen[0]).toMatchObject({ kind: 'video', box: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(look.content[0]!.text).toContain('Look at my hand.');

    // Following: the square's centre at 0.5 s is (180 + 300·0.5, 510) in the 1920×1080 sequence.
    const sticker = await up('star.png', await sharp({ create: { width: 100, height: 100, channels: 4, background: '#ffcc00' } }).png().toBuffer(), 'image/png');
    const st = (await call('video_add_clip', { projectId: p.projectId, sequenceId: seq, assetId: sticker.id, start: 0, out: 4 })).structuredContent;
    const followed = await call('video_track', { projectId: p.projectId, sequenceId: seq, x: 330, y: 510, from: 0.5, to: 3, followClipId: st.clipId });
    const pts = followed.structuredContent.points as { time: number; x: number; y: number }[];
    const last = pts[pts.length - 1]!;
    expect(Math.abs(last.x - (180 + 300 * 3))).toBeLessThan(30);
    expect(Math.abs(last.y - 510)).toBeLessThan(30);
    const state = (await json(await ts.api(`/api/projects/${p.projectId}`))).state as ProjectState;
    const clip = state.nodes[st.clipId] as SceneNode<'clip'>;
    expect(clip.props.keyframes.x!.length).toBe(pts.length);
    expect(Math.abs(clip.props.keyframes.x!.at(-1)!.value - (last.x - 960))).toBeLessThan(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
