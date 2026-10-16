import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Services } from '../services.js';
import { makeToolContext, ToolError, type Principal, type ToolContext, type ToolDef } from './registry.js';
import { registerResources } from './resources.js';
import { allTools } from './tools/index.js';
import { ProjectError } from '../projects/service.js';

export const OMNIX_VERSION = '0.1.0';

export const OMNIX_INSTRUCTIONS = `Omnix is a creative studio with six tools in one project: an image editor (layers), a video editor and an animation maker (a shared timeline), Code Grounds (files, notebooks, sandboxed runs), documents, and slideshows.

How to work in Omnix:
1. Call list_projects, then get_project to see every tool's content at once. Read list_notes (session memory) when resuming so you respect earlier decisions and rejected options.
2. Edit with the tool-specific tools (image_*, video_*, anim_*, code_*, doc_*, slides_*). Every change is recorded in the project history, attributed to you, and can be undone.
3. Check your work visually with render_preview before handing back.
4. Record important decisions with add_note so collaborators (human or AI) can pick up later.

Plugins: tools named <plugin>__<tool> come from plugins installed in this Omnix; they follow the same permission modes as built-in tools.

Shortcuts: run_command turns plain-language edits into operations ("make the sky warmer and move the title to the lower third"); find_in_project searches every tool at once; slides_from_document and code_place_output carry work across tools; image_generative_fill, image_generative_extend and video_generative_fill fill or extend areas from a prompt; style_match applies the look of a reference. For video, video_transcript tells you what is said when, video_look shows frames with a pixel grid and lists what is on screen, and video_track makes a clip follow something that moves (a hand, a face). For a long goal in an autonomous connection, call agent_start_run with a plan, agent_checkpoint after each stage and agent_finish at the end; when the run pauses for the user's approval, call agent_wait and follow their answer.

Permission modes: in "view only" you can read but not change anything. In "edit with approval" each change becomes a proposal the user previews and accepts, modifies or rejects in Omnix; the tool result says "Proposed". In "autonomous" changes apply directly inside the projects the user allowed, and long jobs pause at the user's approval gates. AI also needs per-project consent ("Allow AI"); if a tool says consent is missing, ask the user to turn it on.

Coordinates: canvases, slides and sequences use pixels with the origin at the top-left (sequence clip x/y are offsets from the frame center). Times are in seconds. Layers stack bottom-to-top in child order; timeline tracks are listed top-first.`;

/** Convert a tool result into MCP content. */
function toContent(result: Awaited<ReturnType<ToolDef['handler']>>): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: result.text }];
  if (result.data !== undefined) content.push({ type: 'text', text: JSON.stringify(result.data, null, 2) });
  for (const img of result.images ?? []) content.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.mimeType });
  return { content, ...(result.data !== undefined && typeof result.data === 'object' && !Array.isArray(result.data) ? { structuredContent: result.data as Record<string, unknown> } : {}) };
}

/** Run a tool with error mapping and activity logging. Shared by MCP and the agent runner. */
export async function runTool(tool: ToolDef, rawArgs: unknown, ctx: ToolContext): Promise<{ ok: boolean; result: Awaited<ReturnType<ToolDef['handler']>> | null; error?: string }> {
  const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
  const projectId = typeof (rawArgs as { projectId?: unknown })?.projectId === 'string' ? ((rawArgs as { projectId: string }).projectId as string) : null;
  let projectName: string | null = null;
  if (projectId) projectName = (await ctx.services.projects.getMeta(projectId).catch(() => null))?.name ?? null;
  if (!parsed.success) {
    const error = `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
    await ctx.services.activity.record({ projectId, projectName, actor: ctx.principal.author, kind: 'tool', summary: `${tool.title} failed: invalid arguments`, via: ctx.via, tool: tool.name, ok: false, ...(ctx.jobId ? { jobId: ctx.jobId } : {}) });
    return { ok: false, result: null, error };
  }
  try {
    // Every tool that changes something (or adds files) is closed to view-only connections.
    if (tool.access === 'write' && ctx.principal.mode === 'view') throw new ToolError('This connection is view-only. Ask the user to switch Claude to "edit with approval" or "autonomous" in Omnix to make changes.');
    const result = await tool.handler(parsed.data as never, ctx);
    await ctx.services.activity.record({
      projectId,
      projectName,
      actor: ctx.principal.author,
      kind: 'tool',
      summary: `${tool.title}: ${result.text.split('\n')[0]!.slice(0, 160)}`,
      via: ctx.via,
      tool: tool.name,
      ok: true,
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
    });
    return { ok: true, result };
  } catch (e) {
    const expected = e instanceof ToolError || e instanceof ProjectError;
    const message = e instanceof Error ? e.message : String(e);
    if (!expected && ctx.services.config.dev) console.error(`[mcp] ${tool.name} failed`, e);
    await ctx.services.activity.record({ projectId, projectName, actor: ctx.principal.author, kind: 'tool', summary: `${tool.title} failed: ${message.slice(0, 160)}`, via: ctx.via, tool: tool.name, ok: false, ...(ctx.jobId ? { jobId: ctx.jobId } : {}) });
    return { ok: false, result: null, error: expected ? message : `Internal error in ${tool.name}: ${message}` };
  }
}

const contexts = new WeakMap<McpServer, ToolContext>();

/** The tool context behind an MCP server, so transports can refresh its principal per request. */
export function mcpContextOf(server: McpServer): ToolContext | undefined {
  return contexts.get(server);
}

interface LiveServer {
  server: WeakRef<McpServer>;
  ctx: ToolContext;
  tools: Map<string, RegisteredTool>;
}
/** Open MCP sessions, so tools that come and go (plugins) reach them without reconnecting. */
const liveServers = new Set<LiveServer>();

/**
 * Bring every open MCP session's tool list up to date (plugins connected or went away). The SDK
 * tells each client that the list changed.
 */
export function syncMcpTools(services: Services): void {
  const current = allTools(services);
  const names = new Set(current.map((t) => t.name));
  for (const live of liveServers) {
    const server = live.server.deref();
    if (!server) {
      liveServers.delete(live);
      continue;
    }
    for (const [name, reg] of live.tools) {
      if (!names.has(name)) {
        reg.remove();
        live.tools.delete(name);
      }
    }
    for (const tool of current) if (!live.tools.has(tool.name)) live.tools.set(tool.name, registerOne(services, server, live.ctx, tool));
  }
}

/** The projects a call works on: its projectId, or the projects of its batch targets. None for library tools. */
function projectsNamed(args: unknown): string[] | null {
  const a = (args ?? {}) as { projectId?: unknown; targets?: unknown };
  if (typeof a.projectId === 'string') return [a.projectId];
  if (Array.isArray(a.targets)) {
    const ids = [...new Set(a.targets.map((t) => (t as { projectId?: unknown } | null)?.projectId).filter((id): id is string => typeof id === 'string'))];
    if (ids.length) return ids;
  }
  return null;
}

function registerOne(services: Services, server: McpServer, ctx: ToolContext, tool: ToolDef): RegisteredTool {
  return server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.access === 'write' ? `${tool.description}\n\n(Changes project content; follows the connection's permission mode.)` : tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: tool.access === 'read', destructiveHint: tool.access === 'write' && !!tool.destructive, openWorldHint: tool.category === 'plugin' },
      },
      async (args: unknown) => {
        // A connection driving an autonomous run: hold writes while it waits for approval, gate exports and deletions.
        const gate = services.ext.agentGate as ((p: Principal, projectIds: string[] | null, t: ToolDef, a: unknown) => Promise<string | null>) | undefined;
        if (gate) {
          const refusal = await gate(ctx.principal, projectsNamed(args), tool, args);
          if (refusal) return { isError: true, content: [{ type: 'text', text: refusal }] };
        }
        const r = await runTool(tool, args, ctx);
        if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.error ?? 'Tool failed' }] };
        return toContent(r.result!);
      },
    );
}

/** Build an MCP server bound to one principal (one connection). */
export function createMcpServer(services: Services, principal: Principal): McpServer {
  const server = new McpServer(
    { name: 'omnix', title: 'Omnix', version: OMNIX_VERSION },
    { instructions: OMNIX_INSTRUCTIONS, capabilities: { tools: { listChanged: true }, resources: {}, logging: {} } },
  );
  const ctx = makeToolContext(services, principal, 'mcp');
  contexts.set(server, ctx);
  const tools = new Map<string, RegisteredTool>();
  for (const tool of allTools(services)) tools.set(tool.name, registerOne(services, server, ctx, tool));
  liveServers.add({ server: new WeakRef(server), ctx, tools });
  registerResources(server, ctx);
  return server;
}
