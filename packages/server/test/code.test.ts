import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { makeNode, nodesOfType, type ProjectState } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';
import { codeService } from '../src/code/module.js';

let ts: TestServer;
let projectId = '';
let state: ProjectState;

beforeAll(async () => {
  ts = await startTestServer();
  projectId = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Analysis', primaryTool: 'code' } }))).project.id;
  state = (await json(await ts.api(`/api/projects/${projectId}`))).state;
});
afterAll(async () => {
  await ts.close();
});

const ws = () => nodesOfType(state, 'codeWorkspace')[0]!;

describe('Code Grounds', () => {
  it('runs a notebook cell and saves its outputs into the project', async () => {
    const cell = nodesOfType(state, 'cell')[0]!;
    const r = await json(await ts.api(`/api/projects/${projectId}/code/run`, { method: 'POST', json: { workspaceId: ws().id, cellId: cell.id } }));
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual([{ kind: 'result', text: '45' }]);
    const after = (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;
    expect((after.nodes[cell.id]!.props as { outputs: unknown[]; executionCount: number }).executionCount).toBe(1);
    expect((after.nodes[cell.id]!.props as { outputs: unknown[] }).outputs).toEqual([{ kind: 'result', text: '45' }]);
  }, 60_000);

  it('runs files with workspace files available and streams output over WebSocket', async () => {
    const data = makeNode('codeFile', { path: 'data.csv', language: 'text', content: 'x,y\n1,2\n3,4\n' });
    const script = makeNode('codeFile', { path: 'analyze.py', language: 'python', content: 'import csv\nrows = list(csv.DictReader(open("data.csv")))\nprint("rows:", len(rows))\nimport omnix\nomnix.chart(type="bar", labels=[r["x"] for r in rows], series=[{"name": "y", "values": [float(r["y"]) for r in rows]}])\n' });
    await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op: { kind: 'batch', ops: [{ kind: 'create', parentId: ws().id, nodes: [data] }, { kind: 'create', parentId: ws().id, nodes: [script] }] } } });
    const sock = new WebSocket(ts.url.replace('http', 'ws') + '/ws', { headers: { cookie: ts.cookie } });
    const msgs: any[] = [];
    sock.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    await new Promise((r) => sock.on('open', r));
    sock.send(JSON.stringify({ type: 'join', projectId }));
    await new Promise((r) => setTimeout(r, 100));
    const r = await json(await ts.api(`/api/projects/${projectId}/code/run`, { method: 'POST', json: { workspaceId: ws().id, fileId: script.id } }));
    expect(r.ok).toBe(true);
    expect(r.outputs[0]).toEqual({ kind: 'stdout', text: 'rows: 2\n' });
    expect(r.outputs[1]).toMatchObject({ kind: 'chart', spec: { type: 'bar', labels: ['1', '3'] } });
    expect(msgs.some((m) => m.type === 'code' && m.text.includes('rows: 2'))).toBe(true);
    sock.close();
  }, 60_000);

  it('turns image outputs into assets and runs TypeScript snippets', async () => {
    const r = await json(await ts.api(`/api/projects/${projectId}/code/run`, { method: 'POST', json: { workspaceId: ws().id, source: 'omnix.image("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png"); const n: number = 2; n * 21', language: 'typescript' } }));
    expect(r.outputs[0].kind).toBe('image');
    expect(r.outputs[1]).toEqual({ kind: 'result', text: '42' });
    const asset = await json(await ts.api(`/api/assets/${r.outputs[0].assetId}`));
    expect(asset.asset.source.kind).toBe('code');
  }, 60_000);

  it('keeps every code change as an attributed git commit with diffs', async () => {
    const file = nodesOfType((await json(await ts.api(`/api/projects/${projectId}`))).state, 'codeFile').find((f) => f.props.path === 'main.py')!;
    await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op: { kind: 'update', id: file.id, set: { content: 'print("changed")\n' } } } });
    const code = codeService(ts.omnix.services);
    await code.history.flushAll();
    const log = await json(await ts.api(`/api/projects/${projectId}/code/${ws().id}/history`));
    expect(log.commits.length).toBeGreaterThanOrEqual(2);
    const latest = log.commits[0];
    expect(latest.author.name).toBe('Seb');
    const show = await json(await ts.api(`/api/projects/${projectId}/code/${ws().id}/history/${latest.oid}`));
    const main = show.files.find((f: { path: string }) => f.path === 'main.py');
    expect(main.patch).toContain('+print("changed")');
    // AI-authored commits are marked as such
    await ts.api(`/api/projects/${projectId}`, { method: 'PATCH', json: { aiConsent: true } });
    await ts.omnix.services.projects.commit(projectId, { kind: 'update', id: file.id, set: { content: 'print("from claude")\n' } }, { type: 'ai', id: 'claude:x', name: 'Claude' });
    await code.history.flushAll();
    const log2 = await json(await ts.api(`/api/projects/${projectId}/code/${ws().id}/history`));
    expect(log2.commits[0].aiAuthored).toBe(true);
    expect(log2.commits[0].author.name).toBe('Claude');
  }, 60_000);

  it('reports sandbox status', async () => {
    const s = await json(await ts.api('/api/code/status'));
    expect(s.sandbox.python).toBe(true);
    expect(s.limits.timeoutMs).toBeGreaterThan(0);
  });
});
