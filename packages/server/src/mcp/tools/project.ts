import { z } from 'zod';
import { childrenOf, notesContainer, outlineProject, projectTreeText, type SceneNode } from '@omnix/core';
import { defineTool, zProjectId, ToolError } from '../registry.js';
import { renderNode } from '../../render/renderNode.js';

/** Trim very large prop values so node reads stay prompt-sized. */
export function compactProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'strokes' && Array.isArray(v)) out[k] = v.map((s: { id: string; tool: string; color: string; size: number; points: unknown[] }) => ({ id: s.id, tool: s.tool, color: s.color, size: s.size, points: s.points.length }));
    else if (k === 'frames' && Array.isArray(v)) out[k] = v.map((f: { id: string; hold: number; shapes: unknown[]; strokes: unknown[]; assetId: string | null }) => ({ id: f.id, hold: f.hold, shapes: f.shapes.length, strokes: f.strokes.length, assetId: f.assetId }));
    else if (typeof v === 'string' && v.length > 20000) out[k] = v.slice(0, 20000) + `\n... (${v.length - 20000} more characters)`;
    else out[k] = v;
  }
  return out;
}

export const projectReadTools = [
  defineTool({
    name: 'list_projects',
    title: 'List projects',
    description: 'List the Omnix projects this connection can see, most recently edited first. Use the ids with the other tools.',
    category: 'project',
    access: 'read',
    input: { includeArchived: z.boolean().optional().describe('Include archived projects.') },
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), primaryTool: z.string(), updatedAt: z.string(), aiConsent: z.boolean(), role: z.string() })) }),
    example: { input: {}, output: { projects: [{ id: 'prj_8Kq2...', name: 'Product teaser', primaryTool: 'video', updatedAt: '2026-10-14T18:00:00.000Z', aiConsent: true, role: 'owner' }] } },
    async handler(args, ctx) {
      const all = await ctx.services.projects.listForUser(ctx.principal.user.id, { includeArchived: args.includeArchived });
      const visible = ctx.principal.projectIds === 'all' ? all : all.filter((p) => (ctx.principal.projectIds as string[]).includes(p.id));
      const projects = visible.map((p) => ({ id: p.id, name: p.name, primaryTool: p.primaryTool, updatedAt: p.updatedAt, aiConsent: p.aiConsent, role: ctx.services.projects.roleOf(p, ctx.principal.user.id) ?? 'viewer' }));
      const lines = projects.map((p) => `- ${p.name} (${p.primaryTool}) id=${p.id}${p.aiConsent ? '' : ' [AI not allowed yet]'}`);
      return { text: projects.length ? `${projects.length} project(s):\n${lines.join('\n')}` : 'No projects yet. Use create_project to start one.', data: { projects } };
    },
  }),

  defineTool({
    name: 'get_project',
    title: 'Get project overview',
    description:
      'Read a whole project across all six tools at once: every canvas (layers), sequence (tracks and clips), code workspace (files, notebook cells), document (outline) and deck (slides), plus session-memory notes. Start here before editing.',
    category: 'project',
    access: 'read',
    input: { projectId: zProjectId, includeTree: z.boolean().optional().describe('Also return the full node tree as text (ids and labels).') },
    output: z.object({ outline: z.unknown(), tree: z.string().optional() }),
    example: { input: { projectId: 'prj_8Kq2...' }, output: { outline: { name: 'Product teaser', primaryTool: 'video', documents: ['...'], notes: [] } } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const state = await ctx.services.projects.state(args.projectId);
      const outline = outlineProject(state);
      const tree = args.includeTree ? projectTreeText(state) : undefined;
      return { text: `Project "${outline.name}" (${outline.primaryTool}). ${outline.documents.length} document(s). AI ${outline.aiConsent ? 'allowed' : 'NOT allowed - ask the user to enable it before editing'}.`, data: { outline, ...(tree ? { tree } : {}) } };
    },
  }),

  defineTool({
    name: 'get_node',
    title: 'Read a node',
    description: 'Read one node (layer, clip, block, slide element, file, cell...) with its properties and children ids. Large arrays such as brush points are summarized.',
    category: 'project',
    access: 'read',
    input: { projectId: zProjectId, nodeId: z.string().describe('Node id from get_project.') },
    output: z.object({ id: z.string(), type: z.string(), parentId: z.string().nullable(), children: z.array(z.string()), props: z.record(z.string(), z.unknown()) }),
    example: { input: { projectId: 'prj_8Kq2...', nodeId: 'lyr_x1' }, output: { id: 'lyr_x1', type: 'layer', parentId: 'cnv_a', children: [], props: { name: 'Sky', layerType: 'raster', opacity: 1 } } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const state = await ctx.services.projects.state(args.projectId);
      const n = state.nodes[args.nodeId];
      if (!n) throw new ToolError(`No node ${args.nodeId} in this project`);
      const data = { id: n.id, type: n.type, parentId: n.parentId, children: n.children, props: compactProps(n.props as unknown as Record<string, unknown>) };
      return { text: `${n.type} ${n.id}`, data };
    },
  }),

  defineTool({
    name: 'get_history',
    title: 'Read history',
    description: 'List recent changes on the current branch: who made them (human or AI), when, and what. Useful to see what the user did since your last turn.',
    category: 'project',
    access: 'read',
    input: { projectId: zProjectId, limit: z.number().int().min(1).max(200).optional() },
    output: z.object({ head: z.string().nullable(), commits: z.array(z.object({ id: z.string(), label: z.string(), author: z.string(), authorType: z.string(), timestamp: z.string() })) }),
    example: { input: { projectId: 'prj_8Kq2...', limit: 5 } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const session = await ctx.services.projects.session(args.projectId);
      const commits = session
        .log()
        .slice(-(args.limit ?? 30))
        .reverse()
        .map((c) => ({ id: c.id, label: c.label, author: c.author.name, authorType: c.author.type, timestamp: c.timestamp, ...(c.approvedBy ? { approvedBy: c.approvedBy.name } : {}) }));
      return { text: commits.map((c) => `${c.timestamp} ${c.author}: ${c.label}`).join('\n') || 'No changes yet.', data: { head: session.head, commits } };
    },
  }),

  defineTool({
    name: 'get_selection',
    title: 'Get the user\'s selection',
    description: 'What the user currently has selected in Omnix (layers, clips, blocks, slide elements) and where they are looking. Use it to resolve "this" and "here".',
    category: 'project',
    access: 'read',
    input: { projectId: zProjectId },
    output: z.object({ nodeIds: z.array(z.string()), location: z.unknown().nullable() }),
    example: { input: { projectId: 'prj_8Kq2...' }, output: { nodeIds: ['lyr_x1'], location: { tool: 'image', nodeId: 'cnv_a' } } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const sel = ctx.services.presence.selectionFor(args.projectId, ctx.principal.user.id);
      const data = sel ?? { nodeIds: [], location: null };
      return { text: data.nodeIds.length ? `Selected: ${data.nodeIds.join(', ')}` : 'Nothing is selected (or the user is not in this project right now).', data };
    },
  }),

  defineTool({
    name: 'list_notes',
    title: 'Read session memory',
    description: 'Read the project\'s session memory: decisions, prompts and rejected options recorded by people and AI. Read this when resuming work so you do not repeat rejected ideas.',
    category: 'project',
    access: 'read',
    input: { projectId: zProjectId },
    output: z.object({ notes: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), author: z.string(), createdAt: z.string() })) }),
    example: { input: { projectId: 'prj_8Kq2...' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const state = await ctx.services.projects.state(args.projectId);
      const notes = childrenOf(state, notesContainer(state).id)
        .filter((n): n is SceneNode<'note'> => n.type === 'note')
        .map((n) => ({ id: n.id, kind: n.props.kind, text: n.props.text, author: n.props.author.name, createdAt: n.props.createdAt }));
      return { text: notes.map((n) => `[${n.kind}] ${n.author}: ${n.text}`).join('\n') || 'No notes yet.', data: { notes } };
    },
  }),

  defineTool({
    name: 'render_preview',
    title: 'Render a preview image',
    description:
      'See the work: render a canvas, single layer, video/animation frame at a time, slide, or the whole project to an image. Use it to check your edits visually before handing back to the user.',
    category: 'project',
    access: 'read',
    input: {
      projectId: zProjectId,
      nodeId: z.string().optional().describe('Canvas, layer, sequence, clip, slide or deck id. Omit for a project thumbnail.'),
      time: z.number().min(0).optional().describe('Seconds, for sequences.'),
      maxSize: z.number().int().min(64).max(2048).optional().describe('Longest edge in pixels (default 1024).'),
    },
    output: z.object({ width: z.number(), height: z.number(), mimeType: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', nodeId: 'seq_main', time: 4.5, maxSize: 768 }, output: { width: 768, height: 432, mimeType: 'image/png' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'read');
      const state = await ctx.services.projects.state(args.projectId);
      const img = await renderNode(ctx.services, state, { nodeId: args.nodeId ?? null, ...(args.time !== undefined ? { time: args.time } : {}), maxSize: args.maxSize ?? 1024, format: 'png' });
      return { text: `Rendered ${args.nodeId ?? 'project'} at ${img.width}x${img.height}.`, data: { width: img.width, height: img.height, mimeType: img.mime }, images: [{ data: img.data, mimeType: img.mime }] };
    },
  }),
];
