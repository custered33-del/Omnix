import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { documentBlocks, insertBlocksOps, type ProjectState, type SceneNode } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';

const examples = path.resolve(__dirname, '../../../examples/plugins');
let ts: TestServer;
let auto: Client;
let approve: Client;
let viewer: Client;
let pluginsDir: string;

async function connect(scopes: string[], name: string) {
  const { token } = await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name, scopes } }));
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${ts.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return r;
}
const state = async (projectId: string) => (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;

async function plugins(): Promise<{ id: string; name: string; status: string; error: string | null; tools: { name: string; omnixName: string }[] }[]> {
  for (let i = 0; i < 100; i++) {
    const list = (await json(await ts.api('/api/plugins'))).plugins;
    if (list.every((p: { status: string }) => p.status !== 'connecting')) return list;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('plugins did not connect');
}

beforeAll(async () => {
  pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnix-plugins-'));
  for (const name of ['palette', 'word-tools']) fs.cpSync(path.join(examples, name), path.join(pluginsDir, name), { recursive: true });
  // A broken plugin must not stop the others.
  fs.mkdirSync(path.join(pluginsDir, 'broken'));
  fs.writeFileSync(path.join(pluginsDir, 'broken', 'omnix-plugin.json'), JSON.stringify({ name: 'Broken', type: 'mcp-stdio', command: 'node', args: ['missing.mjs'] }));
  ts = await startTestServer({ pluginsDir });
  auto = await connect(['omnix:read', 'omnix:edit', 'omnix:autonomous'], 'Claude');
  approve = await connect(['omnix:read', 'omnix:edit'], 'Claude reviewer');
  viewer = await connect(['omnix:read'], 'Claude viewer');
});

afterAll(async () => {
  for (const c of [auto, approve, viewer]) await c?.close().catch(() => {});
  await ts?.close();
  fs.rmSync(pluginsDir, { recursive: true, force: true });
});

describe('plugins (56)', () => {
  it('loads plugins from the plugins folder and reports broken ones', async () => {
    const list = await plugins();
    const by = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(by.Palette!.status).toBe('connected');
    expect(by.Palette!.tools.map((t) => t.omnixName)).toEqual(['palette__suggest_palette', 'palette__add_swatches', 'palette__swatch_image']);
    expect(by['Word tools']!.status).toBe('connected');
    expect(by.Broken!.status).toBe('error');
    expect(by.Broken!.error).toBeTruthy();
  });

  it('offers plugin tools to Claude next to Omnix tools, with the same permission modes', async () => {
    const names = (await auto.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_projects', 'palette__suggest_palette', 'palette__add_swatches', 'word_tools__title_case_headings']));
    const suggest = await call(viewer, 'palette__suggest_palette', { baseColor: '#3366cc', mood: 'bold', count: 4 });
    expect((suggest.structuredContent as { colors: string[] }).colors).toHaveLength(4);
    // Arguments are checked against the plugin's own schema before it is called.
    const bad = await viewer.callTool({ name: 'palette__suggest_palette', arguments: { baseColor: 'blue' } });
    expect(bad.isError).toBe(true);
    // Tools that change things are refused for view-only connections.
    const p = await call(auto, 'create_project', { name: 'Swatches', primaryTool: 'image' });
    const projectId = (p.structuredContent as { projectId: string }).projectId;
    const canvasId = Object.values((await state(projectId)).nodes).find((n) => n.type === 'canvas')!.id;
    const refused = await viewer.callTool({ name: 'palette__add_swatches', arguments: { projectId, canvasId, colors: ['#ff0000'] } });
    expect(refused.isError).toBe(true);

    // In approval mode the plugin's changes become a proposal...
    const proposed = await call(approve, 'palette__add_swatches', { projectId, canvasId, colors: ['#ff0000', '#00aa00'] });
    expect((proposed.structuredContent as { outcome: { status: string } }).outcome.status).toBe('proposed');
    expect(Object.values((await state(projectId)).nodes).some((n) => n.type === 'layer' && (n.props as { name: string }).name === 'Palette')).toBe(false);
    // ...and in autonomous mode they apply, attributed to Claude, with every layer property filled in.
    const done = await call(auto, 'palette__add_swatches', { projectId, canvasId, colors: ['#ff0000', '#00aa00', '#0000ff'], size: 50 });
    expect((done.structuredContent as { outcome: { status: string } }).outcome.status).toBe('committed');
    const s = await state(projectId);
    const layer = Object.values(s.nodes).find((n) => n.type === 'layer' && (n.props as { name: string }).name === 'Palette') as SceneNode<'layer'>;
    expect(layer.props.shapes).toHaveLength(3);
    expect(layer.props.opacity).toBe(1);
    const history = (await json(await ts.api(`/api/projects/${projectId}/history`))).commits as { label: string; author: { type: string } }[];
    expect(history.at(-1)).toMatchObject({ label: 'Add 3 palette swatches', author: { type: 'ai' } });
  });

  it('stores files a plugin returns and shows its pictures', async () => {
    const r = await call(auto, 'palette__swatch_image', { colors: ['#112233', '#445566'], name: 'two.png' });
    expect((r.content as { type: string }[]).some((c) => c.type === 'image')).toBe(true);
    const assetId = (r.structuredContent as { assets: string[] }).assets[0]!;
    const a = (await json(await ts.api(`/api/assets/${assetId}`))).asset;
    expect(a).toMatchObject({ name: 'two.png', width: 160, height: 80 });
    expect(a.tags).toEqual(expect.arrayContaining(['plugin', 'palette']));
  });

  it('gives local plugins the project outline, runs them from the app, and as batches', async () => {
    const p = await call(auto, 'create_project', { name: 'Headings', primaryTool: 'document' });
    const projectId = (p.structuredContent as { projectId: string }).projectId;
    let s = await state(projectId);
    const doc = Object.values(s.nodes).find((n) => n.type === 'document')!;
    const ins = insertBlocksOps(s, doc.id, null, [
      { blockType: 'heading', level: 1, text: 'the plan for the year' },
      { blockType: 'paragraph', text: 'Body text stays as it is.' },
      { blockType: 'heading', level: 2, text: 'what we learned' },
    ]);
    await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op: { kind: 'batch', ops: ins.ops }, label: 'Write' } });
    // A person runs it from the Plugins panel.
    const run = await json(await ts.api('/api/plugins/run', { method: 'POST', json: { tool: 'word_tools__title_case_headings', args: { projectId, documentId: doc.id } } }));
    expect(run.text).toMatch(/Title-casing 2 heading/);
    s = await state(projectId);
    const texts = documentBlocks(s, doc.id).map((b) => b.props.text);
    expect(texts).toEqual(expect.arrayContaining(['The Plan for the Year', 'What We Learned', 'Body text stays as it is.']));
    const history = (await json(await ts.api(`/api/projects/${projectId}/history`))).commits as { label: string; author: { type: string; name: string } }[];
    expect(history.at(-1)).toMatchObject({ label: 'Title-case headings', author: { type: 'human', name: 'Seb' } });

    // Tools that take one document are offered as batch operations.
    const ops = (await json(await ts.api('/api/batch/operations'))).operations as { id: string }[];
    expect(ops.map((o) => o.id)).toContain('plugin.word_tools__title_case_headings');
  });

  it('lets the owner add an HTTP plugin, which joins the tool list', async () => {
    // A tiny MCP server over HTTP, the way a hosted plugin would run.
    const server: Server = createServer(async (req, res) => {
      const mcp = new McpServer({ name: 'echo', version: '1.0.0' });
      mcp.registerTool('shout', { title: 'Shout', description: 'Upper-case a phrase.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const added = await json(await ts.api('/api/plugins', { method: 'POST', json: { name: 'Echo', url: `http://127.0.0.1:${port}/mcp` } }));
      expect(added.plugin).toMatchObject({ status: 'connected', slug: 'echo' });
      expect(added.plugin.tools.map((t: { omnixName: string }) => t.omnixName)).toEqual(['echo__shout']);
      // Sessions that were already open get it too.
      expect((await auto.listTools()).tools.map((t) => t.name)).toContain('echo__shout');
      // New MCP connections see the new tool.
      const fresh = await connect(['omnix:read'], 'Claude 2');
      const r = await call(fresh, 'echo__shout', { text: 'hello' });
      expect((r.content as { type: string; text: string }[])[0]!.text).toBe('HELLO');
      await fresh.close();
      await json(await ts.api(`/api/plugins/${added.plugin.id}`, { method: 'PATCH', json: { enabled: false } }));
      expect((await plugins()).find((p) => p.name === 'Echo')!.status).toBe('disabled');
      expect((await auto.listTools()).tools.map((t) => t.name)).not.toContain('echo__shout');
      expect((await ts.api(`/api/plugins/${added.plugin.id}`, { method: 'DELETE' })).status).toBe(200);
      const folder = (await plugins()).find((p) => p.name === 'Palette')!;
      expect((await ts.api(`/api/plugins/${folder.id}`, { method: 'DELETE' })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
