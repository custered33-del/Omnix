import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { makeNode, layerProps, nodesOfType, type ProjectState } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';
import { createOmnix } from '../src/app.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});
afterAll(async () => {
  await ts.close();
});

async function newProject(tool: string, name = 'Test') {
  const r = await ts.api('/api/projects', { method: 'POST', json: { name, primaryTool: tool } });
  expect(r.status).toBe(201);
  return (await json(r)).project as { id: string; name: string };
}

async function getState(id: string): Promise<{ state: ProjectState; head: string | null }> {
  return json(await ts.api(`/api/projects/${id}`));
}

describe('auth', () => {
  it('reports status, rejects bad logins, and keeps sessions', async () => {
    const status = await json(await ts.api('/api/auth/status'));
    expect(status.signedIn).toBe(true);
    const me = await json(await ts.api('/api/auth/me'));
    expect(me.user.email).toBe('seb@example.com');
    expect(me.user.role).toBe('owner');
    expect(me.user.passwordHash).toBeUndefined();
    const bad = await fetch(ts.url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'seb@example.com', password: 'nope' }) });
    expect(bad.status).toBe(401);
    const anon = await fetch(ts.url + '/api/projects');
    expect(anon.status).toBe(401);
  });

  it('updates preferences and setup progress', async () => {
    const r = await json(await ts.api('/api/auth/me', { method: 'PATCH', json: { preferences: { theme: 'high-contrast', reducedMotion: 'on' }, setup: { completed: ['account', 'open-connectors'], current: 'add-connector' } } }));
    expect(r.user.preferences.theme).toBe('high-contrast');
    expect(r.user.setup.current).toBe('add-connector');
  });

  it('issues and revokes personal access tokens', async () => {
    const created = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude Desktop', scopes: ['omnix:read'] } }));
    expect(created.token).toMatch(/^omx_/);
    const viaToken = await fetch(ts.url + '/api/projects', { headers: { authorization: `Bearer ${created.token}` } });
    expect(viaToken.status).toBe(200);
    // A read-only token cannot change anything through the REST API either.
    const write = (token: string) => fetch(ts.url + '/api/projects', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Via token', primaryTool: 'document' }) });
    expect((await write(created.token)).status).toBe(403);
    const proposeOnly = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Review', scopes: ['omnix:read', 'omnix:edit'] } }));
    expect((await write(proposeOnly.token)).status).toBe(403);
    const full = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Script', scopes: ['omnix:read', 'omnix:edit', 'omnix:autonomous'] } }));
    expect((await write(full.token)).status).toBe(201);
    await ts.api(`/api/auth/tokens/${created.record.id}`, { method: 'DELETE' });
    const revoked = await fetch(ts.url + '/api/projects', { headers: { authorization: `Bearer ${created.token}` } });
    expect(revoked.status).toBe(401);
  });
});

describe('projects and the operation log', () => {
  it('creates projects of every type with thumbnails', async () => {
    for (const tool of ['image', 'video', 'animation', 'code', 'document', 'slides']) {
      const p = await newProject(tool, `My ${tool}`);
      const t = await ts.api(`/api/projects/${p.id}/thumbnail`);
      expect(t.status).toBe(200);
      expect(t.headers.get('content-type')).toBe('image/webp');
    }
    const list = await json(await ts.api('/api/projects'));
    expect(list.projects.length).toBeGreaterThanOrEqual(6);
  });

  it('commits validated operations, undoes, redoes and reports history', async () => {
    const p = await newProject('image');
    const { state } = await getState(p.id);
    const canvas = nodesOfType(state, 'canvas')[0]!;
    const layer = makeNode('layer', layerProps('text', { text: 'Hello' }));
    const c = await ts.api(`/api/projects/${p.id}/commits`, { method: 'POST', json: { op: { kind: 'create', parentId: canvas.id, nodes: [layer] } } });
    expect(c.status).toBe(201);
    const bad = await ts.api(`/api/projects/${p.id}/commits`, { method: 'POST', json: { op: { kind: 'update', id: layer.id, set: { opacity: 7 } } } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toMatch(/opacity/);
    await ts.api(`/api/projects/${p.id}/undo`, { method: 'POST' });
    expect((await getState(p.id)).state.nodes[layer.id]).toBeUndefined();
    await ts.api(`/api/projects/${p.id}/redo`, { method: 'POST' });
    expect((await getState(p.id)).state.nodes[layer.id]).toBeDefined();
    const hist = await json(await ts.api(`/api/projects/${p.id}/history`));
    expect(hist.commits.map((x: { label: string }) => x.label)).toEqual(['Add layer "Text"', 'Undo: Add layer "Text"', 'Redo: Add layer "Text"']);
    const detail = await json(await ts.api(`/api/projects/${p.id}/commits/${hist.commits[0].id}`));
    expect(detail.diff.added[0].id).toBe(layer.id);
    const png = await ts.api(`/api/projects/${p.id}/render?node=${canvas.id}&size=200`);
    expect(png.headers.get('content-type')).toBe('image/png');
    const meta = await sharp(Buffer.from(await png.arrayBuffer())).metadata();
    expect(meta.width).toBe(200);
  });

  it('rejects stale writes with 409 when the base moved and the op no longer applies', async () => {
    const p = await newProject('image');
    const { state, head } = await getState(p.id);
    const canvas = nodesOfType(state, 'canvas')[0]!;
    const layer = makeNode('layer', layerProps('fill'));
    await ts.api(`/api/projects/${p.id}/commits`, { method: 'POST', json: { op: { kind: 'create', parentId: canvas.id, nodes: [layer] } } });
    await ts.api(`/api/projects/${p.id}/commits`, { method: 'POST', json: { op: { kind: 'delete', id: layer.id } } });
    const stale = await ts.api(`/api/projects/${p.id}/commits`, { method: 'POST', json: { op: { kind: 'update', id: layer.id, set: { name: 'x' } }, baseHead: head } });
    expect(stale.status).toBe(409);
  });

  it('enforces AI consent and lets the owner toggle it', async () => {
    const p = await newProject('document');
    const svc = ts.omnix.services.projects;
    const ai = { type: 'ai' as const, id: 'claude:test', name: 'Claude' };
    const state = await svc.state(p.id);
    const doc = nodesOfType(state, 'document')[0]!;
    await expect(svc.commit(p.id, { kind: 'update', id: doc.id, set: { name: 'AI edit' } }, ai)).rejects.toThrow(/not allowed/);
    await ts.api(`/api/projects/${p.id}`, { method: 'PATCH', json: { aiConsent: true } });
    await expect(svc.commit(p.id, { kind: 'update', id: doc.id, set: { name: 'AI edit' } }, ai)).resolves.toBeDefined();
    const hist = await json(await ts.api(`/api/projects/${p.id}/history`));
    expect(hist.commits.at(-1).author.type).toBe('ai');
  });

  it('runs the proposal workflow end to end', async () => {
    const p = await newProject('image');
    await ts.api(`/api/projects/${p.id}`, { method: 'PATCH', json: { aiConsent: true } });
    const state = await ts.omnix.services.projects.state(p.id);
    const canvas = nodesOfType(state, 'canvas')[0]!;
    const layer = makeNode('layer', layerProps('text', { text: 'Proposed' }));
    const prop = await ts.omnix.services.projects.propose(p.id, [{ kind: 'create', parentId: canvas.id, nodes: [layer] }], { author: { type: 'ai', id: 'claude:x', name: 'Claude' }, label: 'Add a headline' });
    const list = await json(await ts.api(`/api/projects/${p.id}/proposals?status=open`));
    expect(list.proposals.map((x: { id: string }) => x.id)).toContain(prop.id);
    const preview = await json(await ts.api(`/api/projects/${p.id}/proposals/${prop.id}/preview`));
    expect(preview.summary).toBe('1 added');
    const accepted = await json(await ts.api(`/api/projects/${p.id}/proposals/${prop.id}/accept`, { method: 'POST', json: {} }));
    expect(accepted.commit.approvedBy.name).toBe('Seb');
    expect(accepted.commit.author.name).toBe('Claude');
    const again = await ts.api(`/api/projects/${p.id}/proposals/${prop.id}/accept`, { method: 'POST', json: {} });
    expect(again.status).toBe(409);
  });

  it('branches via checkout and diffs snapshots', async () => {
    const p = await newProject('image');
    const state = (await getState(p.id)).state;
    const canvas = nodesOfType(state, 'canvas')[0]!;
    const snap1 = await json(await ts.api(`/api/projects/${p.id}/snapshots`, { method: 'POST', json: { name: 'Before' } }));
    const l1 = makeNode('layer', layerProps('fill', { name: 'One' }));
    await ts.api(`/api/projects/${p.id}/commits`, { method: 'POST', json: { op: { kind: 'create', parentId: canvas.id, nodes: [l1] } } });
    const d = await json(await ts.api(`/api/projects/${p.id}/diff?from=${snap1.snapshot.commitId ?? 'base'}`));
    expect(d.summary).toBe('1 added');
    await ts.api(`/api/projects/${p.id}/checkout`, { method: 'POST', json: { commitId: null } });
    expect((await getState(p.id)).state.nodes[l1.id]).toBeUndefined();
  });

  it('records attributable activity', async () => {
    const a = await json(await ts.api('/api/activity?limit=200'));
    expect(a.entries.length).toBeGreaterThan(5);
    expect(a.entries.some((e: { kind: string }) => e.kind === 'proposal.accepted')).toBe(true);
    const aiOnly = await json(await ts.api('/api/activity?actor=ai'));
    expect(aiOnly.entries.every((e: { actor: { type: string } }) => e.actor.type === 'ai')).toBe(true);
  });

  it('enforces membership', async () => {
    const p = await newProject('image', 'Private');
    const other = await startTestServer({ signup: false });
    await other.close();
    // A second account on the same server
    const r = await fetch(ts.url + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'guest@example.com', name: 'Guest', password: 'guest password 1' }) });
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const denied = await fetch(`${ts.url}/api/projects/${p.id}`, { headers: { cookie } });
    expect(denied.status).toBe(403);
    await ts.api(`/api/projects/${p.id}/members`, { method: 'POST', json: { email: 'guest@example.com', role: 'viewer' } });
    const allowed = await fetch(`${ts.url}/api/projects/${p.id}`, { headers: { cookie } });
    expect(allowed.status).toBe(200);
    const write = await fetch(`${ts.url}/api/projects/${p.id}/undo`, { method: 'POST', headers: { cookie } });
    expect(write.status).toBe(403);
  });
});

describe('files from the default data folder', () => {
  it('serves files when the data folder is .omnix-data (a name starting with a dot)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-dot-'));
    const dataDir = path.join(root, '.omnix-data');
    try {
      const a = await createOmnix({ dataDir, webDist: null, port: 0, host: '127.0.0.1' });
      const port = await a.listen();
      const base = `http://127.0.0.1:${port}`;
      const signup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', name: 'A', password: 'password123' }) });
      const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
      const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).png().toBuffer();
      const up = await (await fetch(`${base}/api/assets?name=red.png`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: new Uint8Array(png) })).json();
      const file = await fetch(`${base}/api/assets/${up.asset.id}/file`, { headers: { cookie } });
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer()).equals(png)).toBe(true);
      await a.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('persistence and crash recovery', () => {
  it('reloads projects after a restart, including commits logged after the last checkpoint', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-persist-'));
    try {
      const a = await createOmnix({ dataDir, webDist: null, port: 0, host: '127.0.0.1' });
      const seb = await a.services.users.signup({ email: 'a@b.co', name: 'A', password: 'password123' });
      const author = { type: 'human' as const, id: seb.id, name: 'A' };
      const meta = await a.services.projects.create({ name: 'Durable', primaryTool: 'image', ownerId: seb.id, author });
      const state = await a.services.projects.state(meta.id);
      const canvas = nodesOfType(state, 'canvas')[0]!;
      const l = makeNode('layer', layerProps('fill', { name: 'Kept' }));
      await a.services.projects.commit(meta.id, { kind: 'create', parentId: canvas.id, nodes: [l] }, author);
      await a.services.projects.flush(meta.id);
      // Simulate a crash: a commit reaches the log but no checkpoint is written afterwards.
      const l2 = makeNode('layer', layerProps('fill', { name: 'After checkpoint' }));
      await a.services.projects.commit(meta.id, { kind: 'create', parentId: canvas.id, nodes: [l2] }, author);
      await a.services.store.close();
      (a.services.projects as unknown as { dirty: Map<string, NodeJS.Timeout> }).dirty.forEach((t) => clearTimeout(t));
      a.server.close();

      const b = await createOmnix({ dataDir, webDist: null, port: 0, host: '127.0.0.1' });
      const s2 = await b.services.projects.state(meta.id);
      expect(s2.nodes[l.id]).toBeDefined();
      expect(s2.nodes[l2.id]).toBeDefined();
      const session = await b.services.projects.session(meta.id);
      expect(session.log()).toHaveLength(2);
      expect(session.undo(author)).not.toBeNull();
      await b.close();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps a proposal accepted just before a crash accepted, so it cannot be applied twice', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-persist-'));
    try {
      const a = await createOmnix({ dataDir, webDist: null, port: 0, host: '127.0.0.1' });
      const seb = await a.services.users.signup({ email: 'a@b.co', name: 'A', password: 'password123' });
      const author = { type: 'human' as const, id: seb.id, name: 'A' };
      const ai = { type: 'ai' as const, id: 'claude', name: 'Claude' };
      const meta = await a.services.projects.create({ name: 'Durable', primaryTool: 'image', ownerId: seb.id, author, aiConsent: true });
      const state = await a.services.projects.state(meta.id);
      const canvas = nodesOfType(state, 'canvas')[0]!;
      const l = makeNode('layer', layerProps('fill', { name: 'Proposed' }));
      const p = await a.services.projects.propose(meta.id, [{ kind: 'create', parentId: canvas.id, nodes: [l] }], { author: ai, label: 'Add a layer' });
      // Simulate a crash: the accepted commit reaches the log, but the checkpoint that marks the proposal accepted is never written.
      const projects = a.services.projects as unknown as { flush: (id: string) => Promise<void>; dirty: Map<string, NodeJS.Timeout> };
      projects.flush = async () => {};
      const commit = await a.services.projects.acceptProposal(meta.id, p.id, author);
      await a.services.store.close();
      projects.dirty.forEach((t) => clearTimeout(t));
      a.server.close();

      const b = await createOmnix({ dataDir, webDist: null, port: 0, host: '127.0.0.1' });
      const session = await b.services.projects.session(meta.id);
      expect(session.state.nodes[l.id]).toBeDefined();
      expect(session.getProposal(p.id)).toMatchObject({ status: 'accepted', commitId: commit.id });
      await expect(b.services.projects.acceptProposal(meta.id, p.id, author)).rejects.toThrow();
      expect(session.log()).toHaveLength(1);
      await b.close();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('asset pipeline', () => {
  it('ingests images with metadata, thumbnails and deduplication', async () => {
    const img = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#3366cc' } })
      .withMetadata({ exif: { IFD0: { Make: 'OmnixCam', Model: 'One' } } })
      .jpeg()
      .toBuffer();
    const r1 = await ts.api('/api/assets?name=photo.jpg&tags=sky,test', { method: 'POST', body: new Uint8Array(img), headers: { 'content-type': 'image/jpeg' } });
    expect(r1.status).toBe(201);
    const a = (await json(r1)).asset;
    expect(a).toMatchObject({ kind: 'image', width: 640, height: 400, mime: 'image/jpeg', tags: ['sky', 'test'] });
    expect(a.exif.Make).toBe('OmnixCam');
    const r2 = await ts.api('/api/assets?name=copy.jpg', { method: 'POST', body: new Uint8Array(img) });
    expect(r2.status).toBe(200);
    expect((await json(r2)).deduplicated).toBe(true);
    const thumb = await ts.api(`/api/assets/${a.id}/thumbnail`);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    const file = await ts.api(`/api/assets/${a.id}/file`, { headers: { range: 'bytes=0-9' } });
    expect(file.status).toBe(206);
    expect((await file.arrayBuffer()).byteLength).toBe(10);
    const search = await json(await ts.api('/api/assets?q=sky'));
    expect(search.assets.map((x: { id: string }) => x.id)).toContain(a.id);
  });

  it.runIf(hasFfmpeg)('probes video and audio, makes thumbnails, waveforms and proxies', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-media-'));
    try {
      const mov = path.join(dir, 'clip.mov');
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'mjpeg', '-c:a', 'pcm_s16le', '-y', mov]);
      const r = await ts.api('/api/assets?name=clip.mov', { method: 'POST', body: new Uint8Array(await fs.readFile(mov)) });
      const a = (await json(r)).asset;
      expect(a).toMatchObject({ kind: 'video', width: 1280, height: 720, fps: 25, hasAudio: true });
      expect(a.duration).toBeCloseTo(2, 0);
      expect(a.waveform.length).toBe(600);
      expect(a.proxyStatus).toBe('pending'); // mjpeg is not browser-playable
      const jobs = await ts.omnix.services.jobs.list({});
      const proxyJob = jobs.find((j) => j.kind === 'asset.proxy' && (j.input as { assetId: string }).assetId === a.id)!;
      const done = await ts.omnix.services.jobs.wait(proxyJob.id);
      expect(done.status).toBe('done');
      const proxy = await ts.api(`/api/assets/${a.id}/proxy`);
      expect(proxy.headers.get('content-type')).toBe('video/mp4');

      const wav = path.join(dir, 'tone.wav');
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '1', '-y', wav]);
      const ra = await json(await ts.api('/api/assets?name=tone.wav', { method: 'POST', body: new Uint8Array(await fs.readFile(wav)) }));
      expect(ra.asset).toMatchObject({ kind: 'audio', mime: 'audio/wav' });
      expect(Math.max(...ra.asset.waveform)).toBeCloseTo(0.125, 2); // ffmpeg's sine source has amplitude 1/8
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('parses LUT assets', async () => {
    const lines = ['LUT_3D_SIZE 2'];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${r} ${g} ${b}`);
    const res = await json(await ts.api('/api/assets?name=identity.cube', { method: 'POST', body: lines.join('\n') }));
    expect(res.asset.kind).toBe('lut');
  });
});

describe('realtime', () => {
  it('fans out commits and presence to joined clients', async () => {
    const p = await newProject('image', 'Live');
    const ws = new WebSocket(ts.url.replace('http', 'ws') + '/ws', { headers: { cookie: ts.cookie } });
    const messages: any[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', projectId: p.id }));
    await waitFor(() => messages.some((m) => m.type === 'joined'));
    const state = (await getState(p.id)).state;
    const canvas = nodesOfType(state, 'canvas')[0]!;
    const layer = makeNode('layer', layerProps('fill'));
    ws.send(JSON.stringify({ type: 'commit', projectId: p.id, clientOpId: 'op1', op: { kind: 'create', parentId: canvas.id, nodes: [layer] } }));
    await waitFor(() => messages.some((m) => m.type === 'ack' && m.clientOpId === 'op1'));
    await waitFor(() => messages.some((m) => m.type === 'commit' && m.commit.op.nodes?.[0]?.id === layer.id));
    ws.send(JSON.stringify({ type: 'presence', projectId: p.id, selection: [layer.id], location: { tool: 'image', nodeId: canvas.id, x: 10, y: 20 } }));
    await waitFor(() => messages.some((m) => m.type === 'presence' && m.state.selection[0] === layer.id));
    const user = await ts.omnix.services.users.byEmail('seb@example.com');
    expect(ts.omnix.services.presence.selectionFor(p.id, user!.id)?.nodeIds).toEqual([layer.id]);
    ws.send(JSON.stringify({ type: 'commit', projectId: p.id, clientOpId: 'op2', op: { kind: 'delete', id: 'missing' } }));
    await waitFor(() => messages.some((m) => m.type === 'nack' && m.clientOpId === 'op2'));
    ws.close();
  });

  it('applies one client\'s edits in order, and a resent edit once, even from a second connection', async () => {
    const p = await newProject('image', 'Ordered');
    const canvas = nodesOfType((await getState(p.id)).state, 'canvas')[0]!;
    const open = async () => {
      const ws = new WebSocket(ts.url.replace('http', 'ws') + '/ws', { headers: { cookie: ts.cookie } });
      const messages: any[] = [];
      ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'join', projectId: p.id }));
      await waitFor(() => messages.some((m) => m.type === 'joined'));
      return { ws, messages };
    };
    const a = await open();
    const layer = makeNode('layer', layerProps('fill'));
    a.ws.send(JSON.stringify({ type: 'commit', projectId: p.id, clientOpId: 'mk', op: { kind: 'create', parentId: canvas.id, nodes: [layer] } }));
    for (let i = 1; i <= 8; i++) a.ws.send(JSON.stringify({ type: 'commit', projectId: p.id, clientOpId: `x${i}`, op: { kind: 'update', id: layer.id, set: { x: i } } }));
    // After a reconnect the client resends, in order, every edit it has not seen acknowledged.
    const b = await open();
    for (let i = 1; i <= 8; i++) b.ws.send(JSON.stringify({ type: 'commit', projectId: p.id, clientOpId: `x${i}`, op: { kind: 'update', id: layer.id, set: { x: i } } }));
    await waitFor(() => a.messages.some((m) => m.type === 'ack' && m.clientOpId === 'x8') && b.messages.some((m) => m.type === 'ack' && m.clientOpId === 'x8'));
    const s = (await getState(p.id)).state;
    expect((s.nodes[layer.id]!.props as { x: number }).x).toBe(8);
    // Each edit was committed once.
    const session = await ts.omnix.services.projects.session(p.id);
    for (let i = 1; i <= 8; i++) expect(session.log().filter((c) => c.clientOpId === `x${i}`)).toHaveLength(1);
    a.ws.close();
    b.ws.close();
  });
});

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
