import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let token = '';
let projectId = '';

async function connect(tok = token): Promise<Client> {
  const client = new Client({ name: 'omnix-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', ts.url), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  return client;
}

beforeAll(async () => {
  ts = await startTestServer();
  token = (await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Claude', scopes: ['omnix:read', 'omnix:edit'] } }))).token;
  projectId = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Teaser', primaryTool: 'slides', aiConsent: true } }))).project.id;
});
afterAll(async () => {
  await ts.close();
});

describe('MCP over Streamable HTTP', () => {
  it('rejects unauthenticated requests with an OAuth discovery hint', async () => {
    const r = await fetch(ts.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('lists tools with schemas and instructions', async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_projects', 'get_project', 'get_node', 'render_preview', 'list_assets', 'get_selection', 'list_notes', 'get_history']));
    const rp = tools.tools.find((t) => t.name === 'render_preview')!;
    expect(rp.inputSchema.properties).toHaveProperty('projectId');
    expect(rp.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain('Omnix is a creative studio');
    await client.close();
  });

  it('calls read tools and returns images', async () => {
    const client = await connect();
    const list = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.stringify(list.content)).toContain(projectId);
    const proj = (await client.callTool({ name: 'get_project', arguments: { projectId, includeTree: true } })) as { content: { type: string; text: string }[]; structuredContent?: { outline: { documents: { tool: string; id: string }[] } } };
    expect(proj.structuredContent!.outline.documents[0]!.tool).toBe('slides');
    const deckId = proj.structuredContent!.outline.documents[0]!.id;
    const img = (await client.callTool({ name: 'render_preview', arguments: { projectId, nodeId: deckId, maxSize: 320 } })) as { content: { type: string; data?: string; mimeType?: string }[] };
    const image = img.content.find((c) => c.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const bad = (await client.callTool({ name: 'get_node', arguments: { projectId, nodeId: 'nope' } })) as { isError?: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/No node/);
    const invalid = (await client.callTool({ name: 'get_node', arguments: { projectId } })) as { isError?: boolean; content: { text: string }[] };
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it('serves read-only resources', async () => {
    const client = await connect();
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['omnix://projects', `omnix://projects/${projectId}`]));
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual(expect.arrayContaining(['omnix://projects/{projectId}/slides/{deckId}', 'omnix://projects/{projectId}/timeline/{sequenceId}']));
    const outline = await client.readResource({ uri: `omnix://projects/${projectId}` });
    const data = JSON.parse((outline.contents[0] as { text: string }).text);
    expect(data.primaryTool).toBe('slides');
    const deckId = data.documents[0].id;
    const slides = await client.readResource({ uri: `omnix://projects/${projectId}/slides/${deckId}` });
    expect((slides.contents[0] as { text: string }).text).toContain('"role": "title"');
    await client.close();
  });

  it('logs tool calls to the activity feed as the AI', async () => {
    const a = await json(await ts.api('/api/activity?actor=ai&limit=100'));
    expect(a.entries.some((e: { tool?: string }) => e.tool === 'render_preview')).toBe(true);
  });

  it('keeps sessions bound to their credential', async () => {
    const other = (await json(await ts.api('/api/auth/tokens', { method: 'POST', json: { name: 'Other', scopes: ['omnix:read'] } }))).token;
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', ts.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(transport);
    const sid = transport.sessionId!;
    const hijack = await fetch(ts.url + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${other}`, 'mcp-session-id': sid, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
    expect(hijack.status).toBe(403);
    await client.close();
  });
});

describe('MCP over legacy SSE', () => {
  it('works for older clients', async () => {
    const client = new Client({ name: 'sse', version: '1' });
    await client.connect(
      new SSEClientTransport(new URL('/sse', ts.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${token}` } }) },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(5);
    await client.close();
  });
});

describe('MCP over stdio (bridge)', () => {
  it('bridges a stdio client to the running server', async () => {
    const serverDir = path.resolve(__dirname, '..');
    const transport = new StdioClientTransport({
      command: path.resolve(serverDir, '../../node_modules/.bin/tsx'),
      args: [path.join(serverDir, 'src/mcp/stdio.ts')],
      env: { ...(process.env as Record<string, string>), OMNIX_URL: ts.url, OMNIX_TOKEN: token },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('get_project');
    const r = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.stringify(r.content)).toContain('Teaser');
    await client.close();
  });
});
