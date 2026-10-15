import { z } from 'zod';
import express from 'express';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { makeNode, NODE_TYPES, outlineProject, zOperation, type NodeType, type Operation } from '@omnix/core';
import type { Services } from '../services.js';
import type { User } from '../auth/users.js';
import { onShutdown, useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { defineTool, makeToolContext, outcomeText, ToolError, type ApplyOutcome, type Principal, type ToolContext, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { runTool, syncMcpTools } from '../mcp/server.js';
import { defineBatchOperation, registerBatchProvider, type BatchOperation } from '../batch/operations.js';
import type { AssetKind } from '../assets/pipeline.js';
import { PluginService, type PluginCallContext, type PluginRecord } from './service.js';

export { PluginService } from './service.js';

export function pluginsOf(services: Services): PluginService {
  return services.ext.plugins as PluginService;
}

/**
 * Plugins describe new nodes loosely ({ type, props } is enough): fill in ids, links and every
 * property's default, the way Omnix's own tools build nodes, before validating the operations.
 */
function completeOps(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(completeOps);
  if (!raw || typeof raw !== 'object') return raw;
  const op = raw as Record<string, unknown>;
  if (op.kind === 'batch') return { ...op, ops: completeOps(op.ops) };
  if (op.kind !== 'create' || !Array.isArray(op.nodes)) return op;
  const nodes = (op.nodes as Record<string, unknown>[]).map((n) => {
    const type = n.type as NodeType;
    if (!(NODE_TYPES as readonly string[]).includes(type)) return n;
    const base = makeNode(type, (n.props ?? {}) as never, typeof n.id === 'string' ? n.id : undefined);
    return { ...base, parentId: (n.parentId as string | null | undefined) ?? null, children: (n.children as string[] | undefined) ?? [] };
  });
  // The first node hangs under the create's parent; the rest must name parents inside the subtree.
  if (nodes[0]) nodes[0] = { ...nodes[0], parentId: op.parentId as string };
  const byId = new Map(nodes.map((n) => [n.id as string, n]));
  for (const n of nodes.slice(1)) {
    const parent = byId.get(n.parentId as string) as { children: string[] } | undefined;
    if (parent && !parent.children.includes(n.id as string)) parent.children.push(n.id as string);
  }
  return { ...op, nodes };
}

/** The Omnix part of a plugin result: changes to apply and files to keep. */
const zOmnixResult = z.object({
  projectId: z.string().optional(),
  label: z.string().max(200).optional(),
  operations: z.array(zOperation).max(500).optional(),
  assets: z.array(z.object({ name: z.string().max(200), mimeType: z.string().max(100), data: z.string().max(70_000_000) })).max(10).optional(),
});

function toolName(plugin: PluginRecord, tool: Tool): string {
  return `${plugin.slug}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** A plugin tool's JSON Schema input as a zod shape (Omnix validates arguments the same way for every tool). */
function shapeOf(tool: Tool): z.ZodRawShape | null {
  try {
    const t = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    return t instanceof z.ZodObject ? (t.shape as z.ZodRawShape) : null;
  } catch {
    return null;
  }
}

/** Replace "{{asset:N}}" in operations with the id of the N-th file the plugin returned. */
function linkAssets(value: unknown, ids: string[]): unknown {
  if (typeof value === 'string') return value.replace(/\{\{asset:(\d+)\}\}/g, (m, i: string) => ids[Number(i)] ?? m);
  if (Array.isArray(value)) return value.map((v) => linkAssets(v, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, linkAssets(v, ids)]));
  return value;
}

interface ResultSink {
  user: User;
  /** Check write access to a project and apply operations under the caller's permission mode. */
  apply(projectId: string, ops: Operation[], label: string): Promise<ApplyOutcome>;
}

/**
 * Turn a plugin's MCP result into an Omnix tool result: keep its text, images and data, store any
 * files it returned, and apply any operations through the caller's permission mode.
 */
async function handleResult(services: Services, plugin: PluginRecord, tool: Tool, result: CallToolResult, args: Record<string, unknown>, sink: ResultSink) {
  const texts = result.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text);
  if (result.isError) throw new ToolError(`${plugin.name}: ${texts.join(' ') || 'the tool failed'}`);
  const images = result.content.filter((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image').map((c) => ({ data: Buffer.from(c.data, 'base64'), mimeType: c.mimeType }));
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const { omnix: rawOmnix, ...data } = structured;
  const lines = [...texts];
  const out: Record<string, unknown> = { ...data };
  if (rawOmnix !== undefined) {
    const loose = rawOmnix as { operations?: unknown };
    const parsed = zOmnixResult.safeParse(loose && typeof loose === 'object' && 'operations' in loose ? { ...loose, operations: completeOps(loose.operations) } : rawOmnix);
    if (!parsed.success) throw new ToolError(`${plugin.name} returned changes Omnix cannot use: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const omnix = parsed.data;
    const projectId = omnix.projectId ?? (typeof args.projectId === 'string' ? args.projectId : undefined);
    const assetIds: string[] = [];
    for (const a of omnix.assets ?? []) {
      const rec = await services.assets.ingestBuffer(Buffer.from(a.data, 'base64'), { name: a.name, ownerId: sink.user.id, mimeHint: a.mimeType, tags: ['plugin', plugin.slug], source: { kind: 'generated', tool: `plugin:${plugin.slug}` }, ...(projectId ? { projectId } : {}) });
      assetIds.push(rec.id);
    }
    if (assetIds.length) {
      out.assets = assetIds;
      lines.push(`Saved ${assetIds.length} file${assetIds.length === 1 ? '' : 's'} to the library: ${assetIds.join(', ')}.`);
    }
    if (omnix.operations?.length) {
      if (!projectId) throw new ToolError(`${plugin.name} returned changes without saying which project they are for.`);
      const ops = linkAssets(omnix.operations, assetIds) as Operation[];
      const outcome = await sink.apply(projectId, ops, omnix.label ?? `${plugin.name}: ${tool.title ?? tool.name}`);
      out.outcome = outcome;
      lines.push(outcomeText(outcome));
    }
  }
  return { text: lines.join('\n') || `${plugin.name} finished.`, data: out, ...(images.length ? { images } : {}) };
}

async function callContext(services: Services, ctx: ToolContext, args: Record<string, unknown>): Promise<PluginCallContext> {
  const projectId = typeof args.projectId === 'string' ? args.projectId : null;
  let project: unknown = null;
  if (projectId) {
    await ctx.requireProject(projectId, 'read');
    project = outlineProject(await ctx.state(projectId));
  }
  return { user: { id: ctx.principal.user.id, name: ctx.principal.user.name }, projectId, project, omnixUrl: services.config.publicUrl, via: ctx.via };
}

/** Plugin tools as Omnix tools: same validation, permissions, activity log and attribution as built-in ones. */
function pluginToolDefs(services: Services): ToolDef[] {
  const plugins = pluginsOf(services);
  const defs: ToolDef[] = [];
  for (const { plugin, tool } of plugins.connectedTools()) {
    const shape = shapeOf(tool);
    if (!shape) continue;
    const readOnly = tool.annotations?.readOnlyHint === true;
    defs.push(
      defineTool({
        name: toolName(plugin, tool),
        title: `${plugin.name}: ${tool.title ?? tool.annotations?.title ?? tool.name}`,
        description: `${tool.description ?? ''}\n\n(From the "${plugin.name}" plugin.)`.trim(),
        category: 'plugin',
        access: readOnly ? 'read' : 'write',
        input: shape,
        output: z.unknown(),
        example: { input: {} as never },
        async handler(args, ctx) {
          if (!readOnly && ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
          const a = args as Record<string, unknown>;
          let result: CallToolResult;
          try {
            result = await plugins.call(plugin.id, tool.name, a, await callContext(services, ctx, a));
          } catch (e) {
            if (e instanceof ToolError || e instanceof ProjectError) throw e;
            throw new ToolError(`${plugin.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
          return handleResult(services, plugin, tool, result, a, {
            user: ctx.principal.user,
            apply: async (projectId, ops, label) => {
              await ctx.requireProject(projectId, 'write');
              return ctx.apply(projectId, ops, label);
            },
          });
        },
      }) as unknown as ToolDef,
    );
  }
  return defs;
}

/** Plugin tools that take one library file ({assetId}) or one document ({projectId, documentId}) also run as batches. */
function pluginBatchOperations(services: Services): BatchOperation[] {
  const plugins = pluginsOf(services);
  const ops: BatchOperation[] = [];
  for (const { plugin, tool } of plugins.connectedTools()) {
    const shape = shapeOf(tool);
    if (!shape) continue;
    const required = new Set((tool.inputSchema.required as string[] | undefined) ?? []);
    const forFiles = required.has('assetId');
    const forDocs = required.has('projectId') && required.has('documentId');
    if (!forFiles && !forDocs) continue;
    const params = Object.fromEntries(Object.entries(shape).filter(([k]) => !['assetId', 'projectId', 'documentId'].includes(k)));
    const kinds = (tool._meta?.['omnix/kinds'] as AssetKind[] | undefined) ?? ['image', 'video', 'audio', 'lut', 'font', 'text', 'data', 'other'];
    ops.push(
      defineBatchOperation({
        id: `plugin.${toolName(plugin, tool)}`,
        label: tool.title ?? tool.name,
        description: `${tool.description ?? ''} (${plugin.name} plugin)`.trim(),
        group: forFiles ? 'image' : 'document',
        ...(forFiles ? { kinds } : { documentTypes: ['canvas', 'sequence', 'codeWorkspace', 'document', 'deck'] }),
        params,
        async run(ctx, target, p) {
          const args = { ...(p as Record<string, unknown>), ...target };
          const projectId = 'projectId' in target ? target.projectId : null;
          const context: PluginCallContext = { user: { id: ctx.user.id, name: ctx.user.name }, projectId, project: projectId ? outlineProject(await services.projects.state(projectId)) : null, omnixUrl: services.config.publicUrl, via: 'ui' };
          const r = await handleResult(services, plugin, tool, await plugins.call(plugin.id, tool.name, args, context), args, {
            user: ctx.user,
            apply: async (pid, list, label) => {
              await services.projects.requireAccess(pid, ctx.user.id, 'write');
              const o = await ctx.apply(pid, list, label);
              return o.status === 'committed' ? { status: 'committed', commitId: o.id, label } : { status: 'proposed', proposalId: o.id, label };
            },
          });
          const data = r.data as { assets?: string[]; outcome?: ApplyOutcome };
          return { status: 'done', message: r.text.split('\n')[0], ...(data.assets?.[0] ? { outputAssetId: data.assets[0] } : {}), ...(data.outcome?.commitId ? { commitId: data.outcome.commitId } : {}), ...(data.outcome?.proposalId ? { proposalId: data.outcome.proposalId } : {}) };
        },
      }),
    );
  }
  return ops;
}

function publicView(p: Awaited<ReturnType<PluginService['list']>>[number], owner: boolean) {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    type: p.type,
    source: p.source,
    slug: p.slug,
    enabled: p.enabled,
    status: p.status,
    error: p.error,
    serverInfo: p.serverInfo,
    checkedAt: p.checkedAt,
    tools: p.tools.map((t) => ({ name: t.name, omnixName: toolName(p, t), title: t.title ?? t.annotations?.title ?? t.name, description: t.description ?? '', inputSchema: t.inputSchema, readOnly: t.annotations?.readOnlyHint === true })),
    // Where it lives is for the owner; tokens are never sent back.
    ...(owner ? { url: p.url ?? null, command: p.command ? [p.command, ...(p.args ?? [])].join(' ') : null, folder: p.folder ?? null } : {}),
  };
}

useModule(({ services, router }) => {
  const plugins = new PluginService(services);
  services.ext.plugins = plugins;
  // Open Claude sessions get plugin tools as they connect, and lose them when one is turned off.
  plugins.onChange = () => syncMcpTools(services);
  registerToolProvider(services, () => pluginToolDefs(services));
  registerBatchProvider(services, () => pluginBatchOperations(services));
  // Start plugins in the background so a slow or broken one never delays startup.
  void plugins.startAll().catch((e) => console.warn('[plugins] start failed:', e));
  // Stop plugin processes when Omnix stops.
  onShutdown(services, () => plugins.stopAll());

  const r = express.Router();
  const requireOwner = (req: express.Request) => {
    const user = requireUser(req);
    if (user.role !== 'owner') throw new ProjectError('Only the owner of this Omnix can manage plugins.', 403);
    return user;
  };

  r.get(
    '/plugins',
    h(async (req, res) => {
      const user = requireUser(req);
      res.json({ plugins: (await plugins.list()).map((p) => publicView(p, user.role === 'owner')), folder: user.role === 'owner' ? plugins.folder : undefined });
    }),
  );
  r.post(
    '/plugins',
    h(async (req, res) => {
      const user = requireOwner(req);
      const body = z.object({ name: z.string().min(1).max(60), url: z.string().url(), token: z.string().max(4000).optional(), description: z.string().max(300).optional() }).parse(req.body);
      try {
        const p = await plugins.addHttp({ name: body.name, url: body.url, ...(body.token ? { token: body.token } : {}), ...(body.description ? { description: body.description } : {}) }, user.id);
        res.status(201).json({ plugin: publicView((await plugins.list()).find((x) => x.id === p.id)!, true) });
      } catch (e) {
        throw new ProjectError(e instanceof Error ? e.message : String(e), 400);
      }
    }),
  );
  r.patch(
    '/plugins/:id',
    h(async (req, res) => {
      requireOwner(req);
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      await plugins.setEnabled(String(req.params.id), body.enabled);
      res.json({ plugin: publicView((await plugins.list()).find((x) => x.id === String(req.params.id))!, true) });
    }),
  );
  r.post(
    '/plugins/:id/refresh',
    h(async (req, res) => {
      requireOwner(req);
      await plugins.scanFolder();
      const p = await plugins.get(String(req.params.id));
      if (!p) throw new ProjectError('Plugin not found', 404);
      await plugins.disconnect(p.id);
      if (p.enabled) await plugins.connect(p);
      res.json({ plugin: publicView((await plugins.list()).find((x) => x.id === p.id)!, true) });
    }),
  );
  r.delete(
    '/plugins/:id',
    h(async (req, res) => {
      requireOwner(req);
      try {
        await plugins.remove(String(req.params.id));
      } catch (e) {
        throw new ProjectError(e instanceof Error ? e.message : String(e), 400);
      }
      res.json({ ok: true });
    }),
  );

  /** A person runs a plugin tool from the Plugins panel: their own changes, committed as theirs. */
  r.post(
    '/plugins/run',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
      const tool = pluginToolDefs(services).find((t) => t.name === body.tool);
      if (!tool) throw new ProjectError('That plugin tool is not available.', 404);
      const principal: Principal = { user, author: { type: 'human', id: user.id, name: user.name }, mode: 'autonomous', projectIds: 'all', connectionId: 'ui', clientName: 'Omnix' };
      const r2 = await runTool(tool, body.args, makeToolContext(services, principal, 'ui'));
      if (!r2.ok) throw new ProjectError(r2.error ?? 'The plugin tool failed', 400);
      res.json({ text: r2.result!.text, data: r2.result!.data ?? null, images: (r2.result!.images ?? []).map((i) => `data:${i.mimeType};base64,${i.data.toString('base64')}`) });
    }),
  );
  router.use(r);
});
