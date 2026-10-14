import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { childrenOf, notesContainer, type ProjectState } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';
import { isLocalHost } from '../src/claude/module.js';

let ts: TestServer;

const selfTest = async (mode?: string) => json(await ts.api('/api/claude/self-test', { method: 'POST', json: mode ? { mode } : {} }));
const check = (r: { checks: { id: string }[] }, id: string) => r.checks.find((c) => c.id === id) as unknown as { status: string; detail: string; fix?: string; help?: string };

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts?.close();
});

describe('setup guide progress', () => {
  it('starts after account creation and saves steps, the current step and the preset', async () => {
    const me = await json(await ts.api('/api/auth/me'));
    expect(me.user.setup.completed).toEqual(['account']);
    expect(me.user.setup.current).toBe('open-connectors');
    const r = await json(await ts.api('/api/auth/me', { method: 'PATCH', json: { setup: { completed: ['account', 'open-connectors', 'add-connector'], current: 'oauth', preset: 'approve' } } }));
    expect(r.user.setup).toMatchObject({ completed: ['account', 'open-connectors', 'add-connector'], current: 'oauth', preset: 'approve', dismissed: false });
    // Progress survives signing out and back in.
    await ts.api('/api/auth/logout', { method: 'POST' });
    await ts.api('/api/auth/login', { method: 'POST', json: { email: 'seb@example.com', password: 'correct horse battery' } });
    expect((await json(await ts.api('/api/auth/me'))).user.setup.current).toBe('oauth');
  });

  it('rejects unknown steps and presets', async () => {
    expect((await ts.api('/api/auth/me', { method: 'PATCH', json: { setup: { current: 'nope' } } })).status).toBe(400);
    expect((await ts.api('/api/auth/me', { method: 'PATCH', json: { setup: { preset: 'everything' } } })).status).toBe(400);
  });

  it('explains where data lives and which address to give Claude', async () => {
    const info = await json(await ts.api('/api/claude/setup-info'));
    expect(info.mcpUrl).toBe(`${ts.url}/mcp`);
    expect(info.local).toBe(true);
    expect(info.storage).toBe('file');
    expect(info.dataDir).toBe(ts.dataDir);
  });
});

describe('connection test', () => {
  it('reads projects and leaves the note for approval in Edit with approval', async () => {
    const tokensBefore = (await json(await ts.api('/api/auth/tokens'))).tokens.length;
    const r = await selfTest('approve');
    expect(check(r, 'address')).toMatchObject({ status: 'warn', help: 'local-address' });
    expect(check(r, 'mcp').status).toBe('pass');
    expect(check(r, 'read').status).toBe('pass');
    expect(check(r, 'write')).toMatchObject({ status: 'pass' });
    expect(check(r, 'write').detail).toMatch(/waiting for your approval/);
    expect(check(r, 'claude')).toMatchObject({ status: 'warn', help: 'no-connection' });
    expect(r.ok).toBe(true);
    // The proposal sits in the test project; nothing was committed yet.
    const proposals = await json(await ts.api(`/api/projects/${r.testProjectId}/proposals`));
    expect(proposals.proposals.filter((p: { status: string }) => p.status === 'open').length).toBe(1);
    // The temporary token is gone again.
    expect((await json(await ts.api('/api/auth/tokens'))).tokens.length).toBe(tokensBefore);
    const meta = (await json(await ts.api(`/api/projects/${r.testProjectId}`))).project;
    expect(meta.name).toBe('Omnix connection test');
    expect(meta.aiConsent).toBe(true);
  });

  it('commits the note directly in Autonomous, in the same test project', async () => {
    const first = await selfTest('approve');
    const r = await selfTest('autonomous');
    expect(r.testProjectId).toBe(first.testProjectId);
    expect(check(r, 'write').detail).toMatch(/added/);
    const state = (await json(await ts.api(`/api/projects/${r.testProjectId}`))).state as ProjectState;
    const notes = childrenOf(state, notesContainer(state).id);
    expect(notes.length).toBe(1);
    expect(notes[0]!.props).toMatchObject({ text: '', kind: 'note' });
  });

  it('skips the write in View only', async () => {
    const r = await selfTest('view');
    expect(check(r, 'read').status).toBe('pass');
    expect(check(r, 'write').status).toBe('skip');
  });

  it('uses the saved preset when none is given', async () => {
    await ts.api('/api/auth/me', { method: 'PATCH', json: { setup: { preset: 'view' } } });
    expect(check(await selfTest(), 'write').status).toBe('skip');
  });

  it('reports when Claude has actually called Omnix', async () => {
    const created = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude Desktop', scopes: ['omnix:read'] } }));
    let r = await selfTest('view');
    expect(check(r, 'claude')).toMatchObject({ status: 'warn', help: 'no-calls' });
    const client = new Client({ name: 'claude-desktop', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${created.token}` } } }));
    await client.callTool({ name: 'list_projects', arguments: {} });
    await client.close();
    r = await selfTest('view');
    expect(check(r, 'claude').status).toBe('pass');
    expect(check(r, 'claude').detail).toMatch(/Claude Desktop last reached Omnix just now \(View only\)/);
  });

  it('needs a signed-in person', async () => {
    expect((await fetch(`${ts.url}/api/claude/self-test`, { method: 'POST' })).status).toBe(401);
  });
});

describe('addresses', () => {
  it('knows which addresses only this machine or network can reach', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.4', '192.168.1.20', '172.20.0.3', 'omnix.local', '[::1]']) expect(isLocalHost(h), h).toBe(true);
    for (const h of ['omnix.example.com', '8.8.8.8', '172.32.0.1']) expect(isLocalHost(h), h).toBe(false);
  });
});

describe('sample project', () => {
  it('builds the launch kit with live links, and AI consent is the creator\'s choice', async () => {
    const on = await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Sample: Launch kit', primaryTool: 'slides', templateId: 'builtin-launch-kit', aiConsent: true } }));
    expect(on.project.aiConsent).toBe(true);
    const state = (await json(await ts.api(`/api/projects/${on.project.id}`))).state as ProjectState;
    const types = Object.values(state.nodes).map((n) => n.type);
    for (const t of ['deck', 'canvas', 'document', 'notebook', 'cell']) expect(types).toContain(t);
    // Every live link in the sample points at something that exists.
    const embeds = Object.values(state.nodes).flatMap((n) => {
      const e = (n.props as { embed?: { kind: string; ref: string } | null }).embed;
      return e ? [e] : [];
    });
    expect(embeds.length).toBe(3);
    for (const e of embeds) expect(state.nodes[e.ref], `${e.kind} → ${e.ref}`).toBeTruthy();
    // The slide renders with its linked chart.
    const slide = Object.values(state.nodes).filter((n) => n.type === 'slide')[1]!;
    const img = await ts.api(`/api/projects/${on.project.id}/render?node=${slide.id}&size=320`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    const off = await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Sample 2', primaryTool: 'slides', templateId: 'builtin-launch-kit' } }));
    expect(off.project.aiConsent).toBe(false);
  });
});
