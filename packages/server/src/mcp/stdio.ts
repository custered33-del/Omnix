#!/usr/bin/env -S npx tsx
/**
 * Omnix MCP over stdio, for MCP clients that launch servers as local processes
 * (Claude Desktop, Claude Code, other MCP hosts).
 *
 * Bridge mode (recommended): forwards to a running Omnix server so the web app sees every
 * change live.  Needs OMNIX_URL (default http://localhost:4317) and OMNIX_TOKEN (a personal
 * access token from Settings -> Claude -> Access tokens).
 *
 * Standalone mode (`--standalone`): runs the studio in-process against OMNIX_DATA_DIR.
 * Use it only when the Omnix server is not running on the same data directory.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { OMNIX_INSTRUCTIONS, OMNIX_VERSION, createMcpServer } from './server.js';

const log = (...a: unknown[]) => console.error('[omnix-mcp]', ...a);

async function bridge(url: string, token: string): Promise<void> {
  const client = new Client({ name: 'omnix-stdio-bridge', version: OMNIX_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const server = new Server({ name: 'omnix', title: 'Omnix', version: OMNIX_VERSION }, { capabilities: { tools: {}, resources: {} }, instructions: client.getInstructions() ?? OMNIX_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params) as never);
  server.setRequestHandler(ListResourcesRequestSchema, (req) => client.listResources(req.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => client.listResourceTemplates(req.params));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params));
  await server.connect(new StdioServerTransport());
  log(`bridging stdio to ${url}/mcp`);
}

async function standalone(token: string | undefined): Promise<void> {
  const { createOmnix } = await import('../app.js');
  await import('../modules.js');
  const { resolvePrincipal } = await import('./http.js');
  const omnix = await createOmnix();
  let principal = token ? await resolvePrincipal(omnix.services, token) : null;
  if (!principal) {
    const users = await omnix.services.users.list();
    const owner = users.find((u) => u.role === 'owner');
    if (!owner) throw new Error('No Omnix account exists yet. Open the Omnix web app once to create one, or pass OMNIX_TOKEN.');
    const user = (await omnix.services.users.byId(owner.id))!;
    principal = { user, author: { type: 'ai', id: 'claude:stdio', name: 'Claude' }, mode: 'approve', projectIds: 'all', connectionId: 'stdio', clientName: 'Claude (stdio)' };
    log('No OMNIX_TOKEN given: acting for the owner account in "edit with approval" mode.');
  }
  const server = createMcpServer(omnix.services, principal);
  await server.connect(new StdioServerTransport());
  const stop = async () => {
    await omnix.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  log(`standalone server using ${omnix.config.dataDir}`);
}

const args = process.argv.slice(2);
const url = (process.env.OMNIX_URL ?? 'http://localhost:4317').replace(/\/$/, '');
const token = process.env.OMNIX_TOKEN;
try {
  if (args.includes('--standalone')) await standalone(token);
  else {
    if (!token) {
      log('OMNIX_TOKEN is not set. Create a personal access token in Omnix (Settings -> Claude -> Access tokens), or run with --standalone.');
      process.exit(2);
    }
    await bridge(url, token);
  }
} catch (e) {
  log(e instanceof Error ? e.message : e);
  process.exit(1);
}
