import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { newId } from '@omnix/core';
import type { Services } from '../services.js';

/**
 * Plugins (feature 56): third-party tools that speak the same schema as Omnix's own MCP tools.
 *
 * A plugin is either an MCP server (reached over Streamable HTTP, or started as a local command
 * speaking MCP over stdio) or a local JavaScript module that exports tools in the MCP shape
 * (name, description, JSON Schema input, annotations) with a handler returning an MCP result.
 * Omnix lists their tools next to its own, for Claude over MCP, the built-in agent runner and
 * the Plugins panel in every project.
 *
 * Plugins change projects through Omnix, never directly: a tool result can carry
 * `structuredContent.omnix.operations` (with projectId and label), which Omnix validates and
 * applies under the caller's permission mode (committed, or a proposal to review), and
 * `structuredContent.omnix.assets` (base64 files), which land in the caller's library.
 */

export type PluginKind = 'mcp-http' | 'mcp-stdio' | 'local';

export interface PluginManifest {
  name: string;
  description?: string;
  type: PluginKind;
  /** mcp-http */
  url?: string;
  headers?: Record<string, string>;
  /** mcp-stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** local: module path relative to the plugin folder */
  entry?: string;
}

export interface PluginRecord extends PluginManifest {
  id: string;
  /** Short prefix for its tools ("palette" gives palette__suggest_colors). */
  slug: string;
  /** Where it came from: the plugins folder on the server, or added in Settings. */
  source: 'folder' | 'settings';
  folder?: string;
  enabled: boolean;
  createdAt: string;
  addedBy: string | null;
}

export interface PluginState {
  status: 'connected' | 'error' | 'disabled' | 'connecting';
  error: string | null;
  tools: Tool[];
  serverInfo: { name: string; version: string } | null;
  checkedAt: string | null;
}

/** The shape a local plugin module exports (default export). */
export interface LocalPlugin {
  name?: string;
  description?: string;
  tools: (Tool & { handler(args: Record<string, unknown>, context: PluginCallContext): Promise<CallToolResult> | CallToolResult })[];
}

/** What a plugin learns about each call (also sent to MCP plugins as _meta["omnix/context"]). */
export interface PluginCallContext {
  user: { id: string; name: string };
  projectId: string | null;
  /** A compact outline of the project, when the call names one the caller can read. */
  project: unknown;
  omnixUrl: string;
  via: 'mcp' | 'agent' | 'ui';
}

const COLLECTION = 'plugins';
const CALL_TIMEOUT_MS = 120_000;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'plugin'
  );
}

interface Live {
  client?: Client;
  local?: LocalPlugin;
  state: PluginState;
  connecting?: Promise<void>;
}

export class PluginService {
  private live = new Map<string, Live>();
  private folderPlugins: PluginRecord[] = [];
  /** Every known plugin, refreshed by list(); tool listing reads it synchronously. */
  private cache: PluginRecord[] = [];

  /** Called whenever the set of available plugin tools may have changed. */
  onChange: () => void = () => {};

  constructor(private readonly services: Services) {}

  get folder(): string {
    return this.services.config.pluginsDir ?? path.join(this.services.config.dataDir, 'plugins');
  }

  /** Read omnix-plugin.json from each subfolder of the plugins folder. */
  async scanFolder(): Promise<PluginRecord[]> {
    const out: PluginRecord[] = [];
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this.folder, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      entries = [];
    }
    for (const dir of entries.sort()) {
      const folder = path.join(this.folder, dir);
      try {
        const m = JSON.parse(await fs.readFile(path.join(folder, 'omnix-plugin.json'), 'utf8')) as PluginManifest;
        if (!m.name || !['mcp-http', 'mcp-stdio', 'local'].includes(m.type)) throw new Error('needs a name and a type of mcp-http, mcp-stdio or local');
        const saved = await this.services.store.get<{ enabled: boolean }>(COLLECTION, `folder:${dir}`);
        out.push({ ...m, id: `folder:${dir}`, slug: slugify(m.name), source: 'folder', folder, enabled: saved?.enabled ?? true, createdAt: '', addedBy: null });
      } catch (e) {
        console.warn(`[plugins] skipped ${folder}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.folderPlugins = out;
    return out;
  }

  async list(): Promise<(PluginRecord & PluginState)[]> {
    const saved = (await this.services.store.list<PluginRecord>(COLLECTION)).filter((p) => p.source === 'settings');
    const all = [...this.folderPlugins, ...saved];
    // Two plugins never share a tool prefix.
    const seen = new Map<string, number>();
    for (const p of all) {
      const n = seen.get(p.slug) ?? 0;
      seen.set(p.slug, n + 1);
      if (n) p.slug = `${p.slug}${n + 1}`;
    }
    this.cache = all;
    return all.map((p) => ({ ...p, ...this.stateOf(p) }));
  }

  private stateOf(p: PluginRecord): PluginState {
    if (!p.enabled) return { status: 'disabled', error: null, tools: [], serverInfo: null, checkedAt: null };
    return this.live.get(p.id)?.state ?? { status: 'connecting', error: null, tools: [], serverInfo: null, checkedAt: null };
  }

  async get(id: string): Promise<PluginRecord | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Add an MCP server reachable over HTTP (from Settings). */
  async addHttp(input: { name: string; url: string; description?: string; token?: string }, userId: string): Promise<PluginRecord> {
    const url = new URL(input.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error('Plugin URLs start with http:// or https://');
    const p: PluginRecord = {
      id: newId('plg'),
      name: input.name.trim().slice(0, 60) || url.hostname,
      ...(input.description ? { description: input.description.slice(0, 300) } : {}),
      type: 'mcp-http',
      url: url.toString(),
      ...(input.token ? { headers: { Authorization: `Bearer ${input.token}` } } : {}),
      slug: slugify(input.name || url.hostname),
      source: 'settings',
      enabled: true,
      createdAt: new Date().toISOString(),
      addedBy: userId,
    };
    await this.services.store.put(COLLECTION, p.id, p);
    await this.list();
    await this.connect(p);
    return p;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const p = await this.get(id);
    if (!p) throw new Error('Plugin not found');
    if (p.source === 'folder') {
      await this.services.store.put(COLLECTION, id, { id, source: 'folder', enabled });
      this.folderPlugins = this.folderPlugins.map((x) => (x.id === id ? { ...x, enabled } : x));
    } else await this.services.store.put(COLLECTION, id, { ...(await this.services.store.get<PluginRecord>(COLLECTION, id))!, enabled });
    await this.disconnect(id);
    await this.list();
    if (enabled) await this.connect({ ...p, enabled });
  }

  async remove(id: string): Promise<void> {
    const p = await this.get(id);
    if (!p) throw new Error('Plugin not found');
    if (p.source === 'folder') throw new Error('This plugin is installed in the plugins folder on the server; remove its folder there.');
    await this.disconnect(id);
    await this.services.store.delete(COLLECTION, id);
    await this.list();
  }

  /** Start every enabled plugin (called at startup; failures are recorded, not thrown). */
  async startAll(): Promise<void> {
    await this.scanFolder();
    await Promise.all((await this.list()).filter((p) => p.enabled).map((p) => this.connect(p)));
  }

  /** Connect (or reconnect) one plugin and read its tools. */
  async connect(p: PluginRecord): Promise<PluginState> {
    const existing = this.live.get(p.id);
    if (existing?.connecting) {
      await existing.connecting;
      return this.live.get(p.id)!.state;
    }
    const entry: Live = { state: { status: 'connecting', error: null, tools: [], serverInfo: null, checkedAt: null } };
    this.live.set(p.id, entry);
    entry.connecting = (async () => {
      try {
        if (p.type === 'local') {
          if (!p.folder || !p.entry) throw new Error('A local plugin needs an "entry" module in its folder.');
          const file = path.resolve(p.folder, p.entry);
          if (!file.startsWith(p.folder + path.sep)) throw new Error('The entry module must be inside the plugin folder.');
          const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)) as { default?: LocalPlugin };
          if (!mod.default || !Array.isArray(mod.default.tools)) throw new Error('The entry module must export default { tools: [...] }.');
          entry.local = mod.default;
          entry.state = { status: 'connected', error: null, tools: mod.default.tools.map(({ handler: _h, ...tool }) => tool), serverInfo: { name: mod.default.name ?? p.name, version: 'local' }, checkedAt: new Date().toISOString() };
          return;
        }
        const client = new Client({ name: 'omnix', version: '0.1.0' });
        const transport =
          p.type === 'mcp-http'
            ? new StreamableHTTPClientTransport(new URL(p.url!), { requestInit: { headers: p.headers ?? {} } })
            : new StdioClientTransport({ command: p.command!, args: p.args ?? [], ...(p.folder ? { cwd: p.folder } : {}), env: { PATH: process.env.PATH ?? '', ...(p.env ?? {}) }, stderr: 'pipe' });
        await client.connect(transport, { timeout: 20_000 });
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor && tools.length < 500);
        entry.client = client;
        const info = client.getServerVersion();
        entry.state = { status: 'connected', error: null, tools, serverInfo: info ? { name: info.name, version: info.version } : null, checkedAt: new Date().toISOString() };
      } catch (e) {
        entry.state = { status: 'error', error: e instanceof Error ? e.message : String(e), tools: [], serverInfo: null, checkedAt: new Date().toISOString() };
      }
    })();
    await entry.connecting;
    entry.connecting = undefined;
    this.onChange();
    return entry.state;
  }

  async disconnect(id: string): Promise<void> {
    const l = this.live.get(id);
    this.live.delete(id);
    await l?.client?.close().catch(() => {});
    if (l) this.onChange();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)));
  }

  /** Every tool from every connected plugin, with the plugin it belongs to. */
  connectedTools(): { plugin: PluginRecord; tool: Tool }[] {
    const out: { plugin: PluginRecord; tool: Tool }[] = [];
    for (const p of this.cache) {
      const l = this.live.get(p.id);
      if (!p.enabled || l?.state.status !== 'connected') continue;
      for (const tool of l.state.tools) out.push({ plugin: p, tool });
    }
    return out;
  }

  /** Call one plugin tool. MCP plugins get the call context as _meta["omnix/context"]. */
  async call(pluginId: string, toolName: string, args: Record<string, unknown>, context: PluginCallContext): Promise<CallToolResult> {
    let l = this.live.get(pluginId);
    const p = await this.get(pluginId);
    if (!p || !p.enabled) throw new Error('That plugin is not available.');
    if (!l || l.state.status !== 'connected') {
      // One reconnect attempt (a plugin server may have restarted).
      await this.connect(p);
      l = this.live.get(pluginId);
      if (!l || l.state.status !== 'connected') throw new Error(`The plugin "${p.name}" is not reachable: ${l?.state.error ?? 'not connected'}`);
    }
    if (l.local) {
      const tool = l.local.tools.find((x) => x.name === toolName);
      if (!tool) throw new Error(`The plugin "${p.name}" has no tool ${toolName}.`);
      return await withTimeout(Promise.resolve(tool.handler(args, context)), CALL_TIMEOUT_MS, `${p.name} took too long`);
    }
    const r = await l.client!.callTool({ name: toolName, arguments: args, _meta: { 'omnix/context': context } }, undefined, { timeout: CALL_TIMEOUT_MS });
    return r as CallToolResult;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
