import { z } from 'zod';
import { childrenOf, makeNode, notesContainer, outlineProject, primaryDocumentNodes, projectTreeText, subtreeIds, TOOL_KINDS, zOperation, type SceneNode } from '@omnix/core';
import { edit, writeResult, zWriteResult } from './helpers.js';
import { C } from '../../storage/store.js';
import { defineTool, outcomeText, zNodeId, zProjectId, ToolError } from '../registry.js';
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
      const state = await ctx.state(args.projectId);
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
      const state = await ctx.state(args.projectId);
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
      const state = await ctx.state(args.projectId);
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
      const state = await ctx.state(args.projectId);
      const img = await renderNode(ctx.services, state, { nodeId: args.nodeId ?? null, ...(args.time !== undefined ? { time: args.time } : {}), maxSize: args.maxSize ?? 1024, format: 'png' });
      return { text: `Rendered ${args.nodeId ?? 'project'} at ${img.width}x${img.height}.`, data: { width: img.width, height: img.height, mimeType: img.mime }, images: [{ data: img.data, mimeType: img.mime }] };
    },
  }),
];

const DOC_TYPE = { image: 'canvas', video: 'sequence', animation: 'sequence', code: 'codeWorkspace', document: 'document', slides: 'deck' } as const;

export const projectWriteTools = [
  defineTool({
    name: 'create_project',
    title: 'Create a project',
    description:
      'Start a new project for the user in one of the six tools (image, video, animation, code, document, slides). Other documents can be added to it later with add_document. The new project allows AI from the start because the user asked for it through you; it is added to this connection automatically.',
    category: 'project',
    access: 'write',
    input: {
      name: z.string().min(1).max(200).describe('Project name'),
      primaryTool: z.enum(TOOL_KINDS).describe('The tool the project opens in'),
      description: z.string().max(2000).optional(),
    },
    output: z.object({ projectId: z.string(), documentId: z.string() }),
    example: { input: { name: 'Spring launch teaser', primaryTool: 'video' }, output: { projectId: 'prj_4Hc1...', documentId: 'seq_9qa...' } },
    async handler(args, ctx) {
      const p = ctx.principal;
      if (p.mode === 'view') throw new ToolError('This connection is view-only. Ask the user to allow editing to create projects.');
      const meta = await ctx.services.projects.create({ name: args.name, primaryTool: args.primaryTool, ownerId: p.user.id, author: p.author, aiConsent: true, description: args.description ?? `Created by ${p.author.name}.` });
      // A connection limited to some projects gets the new one too.
      if (p.projectIds !== 'all') {
        p.projectIds = [...p.projectIds, meta.id];
        if (p.connectionId.startsWith('oauth:')) {
          const grantId = p.connectionId.slice(6);
          const g = await ctx.services.store.get<{ projectIds: 'all' | string[] }>(C.connections, grantId);
          if (g && g.projectIds !== 'all') await ctx.services.store.put(C.connections, grantId, { ...g, projectIds: [...g.projectIds, meta.id] });
        }
      }
      const state = await ctx.services.projects.state(meta.id);
      const doc = childrenOf(state, state.rootId).find((n) => n.type === DOC_TYPE[args.primaryTool]);
      return { text: `Created project "${meta.name}" (${meta.id}) with ${doc?.type ?? 'no'} ${doc?.id ?? ''}.`, data: { projectId: meta.id, documentId: doc?.id ?? '' } };
    },
  }),

  defineTool({
    name: 'add_document',
    title: 'Add a document to a project',
    description: 'Add another canvas, video or animation sequence, code workspace, document or slideshow to an existing project, so work can flow between tools in one place.',
    category: 'project',
    access: 'write',
    input: { projectId: zProjectId, tool: z.enum(TOOL_KINDS), name: z.string().min(1).max(200) },
    output: zWriteResult.extend({ documentId: z.string() }),
    example: { input: { projectId: 'prj_8Kq2...', tool: 'slides', name: 'Launch deck' }, output: { status: 'committed', commitId: 'c_12...', documentId: 'dck_3x...' } },
    async handler(args, ctx) {
      const nodes = primaryDocumentNodes(args.tool, args.name);
      const out = await edit(ctx, args.projectId, `Add ${args.tool} "${args.name}"`, (state) => [{ kind: 'create', parentId: state.rootId, nodes }]);
      return writeResult(out, { documentId: nodes[0]!.id });
    },
  }),

  defineTool({
    name: 'update_node',
    title: 'Change properties of anything',
    description:
      'Set (or unset) properties on any node: a layer, clip, track, sequence, canvas, block, slide, slide element, code file or cell. Use get_node to see current properties. Values are validated against the node type; for example a layer accepts opacity 0..1, blendMode, x, y, rotation; a clip accepts start, in, out, x, y, scale, opacity, volume. Prefer the tool-specific tools when one fits.',
    category: 'project',
    access: 'write',
    input: {
      projectId: zProjectId,
      nodeId: zNodeId.describe('Node id'),
      set: z.record(z.string(), z.unknown()).optional().describe('Properties to set'),
      unset: z.array(z.string()).optional().describe('Optional properties to remove'),
      label: z.string().max(200).optional().describe('Short description of the change for the history'),
    },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', nodeId: 'lyr_sky', set: { opacity: 0.8, blendMode: 'screen' }, label: 'Soften the sky' }, output: { status: 'proposed', proposalId: 'prop_1x...' } },
    async handler(args, ctx) {
      if (!args.set && !args.unset?.length) throw new ToolError('Pass set and/or unset.');
      const out = await edit(ctx, args.projectId, args.label ?? `Edit ${args.nodeId}`, (state) => {
        if (!state.nodes[args.nodeId]) throw new ToolError(`No node "${args.nodeId}" in this project. Call get_project to find ids.`);
        return [{ kind: 'update', id: args.nodeId, set: args.set ?? {}, ...(args.unset?.length ? { unset: args.unset } : {}) }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'move_node',
    title: 'Move or reorder a node',
    description: 'Move a node to another parent or position: reorder layers (bottom to top), move a layer into a group, a clip to another track, a block or slide to another position. Index counts children of the new parent after removing the node.',
    category: 'project',
    access: 'write',
    input: { projectId: zProjectId, nodeId: zNodeId, parentId: zNodeId.optional().describe('New parent (default: the current one)'), index: z.number().int().min(0).describe('Position among the parent\'s children') },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', nodeId: 'sld_4', index: 0 }, output: { status: 'committed', commitId: 'c_3a...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, `Move ${args.nodeId}`, (state) => {
        const n = state.nodes[args.nodeId];
        if (!n?.parentId) throw new ToolError(`No movable node "${args.nodeId}".`);
        return [{ kind: 'move', id: n.id, parentId: args.parentId ?? n.parentId, index: args.index }];
      });
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'delete_node',
    title: 'Delete something',
    description: 'Delete a node and everything inside it (a layer, clip, track, block, slide, slide element, code file, cell or a whole document). Deleting is recorded in history and can be undone.',
    category: 'project',
    access: 'write',
    input: { projectId: zProjectId, nodeId: zNodeId },
    output: zWriteResult.extend({ deleted: z.number() }),
    example: { input: { projectId: 'prj_8Kq2...', nodeId: 'lyr_old' }, output: { status: 'proposed', proposalId: 'prop_7c...', deleted: 1 } },
    async handler(args, ctx) {
      let count = 0;
      const out = await edit(ctx, args.projectId, `Delete ${args.nodeId}`, (state) => {
        const n = state.nodes[args.nodeId];
        if (!n || !n.parentId) throw new ToolError(`No deletable node "${args.nodeId}".`);
        if (n.type === 'notes' || n.type === 'comments') throw new ToolError('Session memory and comment containers cannot be deleted.');
        count = subtreeIds(state, n.id).length;
        return [{ kind: 'delete', id: n.id }];
      });
      return writeResult(out, { deleted: count });
    },
  }),

  defineTool({
    name: 'apply_operations',
    title: 'Apply raw operations',
    description:
      'Advanced: apply a list of scene-graph operations as one change (create, delete, update, move, listInsert, listRemove, listUpdate, batch). Use it for edits no specific tool covers. Created nodes need full props or defaults; ids you choose must be unique (letters, digits, _ and -). Everything is validated before it applies.',
    category: 'project',
    access: 'write',
    input: { projectId: zProjectId, label: z.string().min(1).max(200).describe('What the change does, for the history'), operations: z.array(zOperation).min(1).max(500) },
    output: zWriteResult,
    example: { input: { projectId: 'prj_8Kq2...', label: 'Hide draft layers', operations: [{ kind: 'update', id: 'lyr_a', set: { visible: false } }, { kind: 'update', id: 'lyr_b', set: { visible: false } }] }, output: { status: 'committed', commitId: 'c_9f...' } },
    async handler(args, ctx) {
      const out = await edit(ctx, args.projectId, args.label, () => args.operations);
      return writeResult(out);
    },
  }),

  defineTool({
    name: 'undo',
    title: 'Undo your last change',
    description: 'Undo the most recent change you (this connection) made in a project. People\'s changes are never undone by this tool.',
    category: 'project',
    access: 'write',
    input: { projectId: zProjectId },
    output: z.object({ undone: z.string().nullable() }),
    example: { input: { projectId: 'prj_8Kq2...' }, output: { undone: 'Move the title to the lower third' } },
    async handler(args, ctx) {
      if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
      await ctx.requireProject(args.projectId, 'write');
      const c = await ctx.services.projects.undo(args.projectId, ctx.principal.author, ctx.via);
      return { text: c ? `Undid: ${c.label}` : 'Nothing of yours to undo in this project.', data: { undone: c?.label ?? null } };
    },
  }),

  defineTool({
    name: 'start_new_proposal',
    title: 'Start a new proposal',
    description: 'In edit-with-approval mode your changes stack into one open proposal so the user reviews related edits together. Call this before starting an unrelated change (or an alternative option) so it becomes a separate proposal.',
    category: 'project',
    access: 'write',
    input: { projectId: zProjectId },
    output: z.object({ sealed: z.string().nullable() }),
    example: { input: { projectId: 'prj_8Kq2...' }, output: { sealed: 'prop_1x...' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'write');
      const session = await ctx.services.projects.session(args.projectId);
      const open = session.listProposals('open').filter((p) => p.author.id === ctx.principal.author.id && !p.sealed);
      for (const p of open) await ctx.services.projects.sealProposal(args.projectId, p.id);
      return { text: open.length ? `Closed ${open.length} proposal(s) to further changes; your next change starts a new proposal.` : 'No open proposal; your next change starts a new one.', data: { sealed: open[0]?.id ?? null } };
    },
  }),

  defineTool({
    name: 'add_note',
    title: 'Add to session memory',
    description:
      "Record a decision, a prompt that worked, a rejected option or a reminder in the project's session memory, so the next session (yours, another AI's or a person's) can pick up where this one left off. Follows the connection's permission mode: in edit-with-approval mode the note waits for the user to approve it.",
    category: 'project',
    access: 'write',
    input: {
      projectId: zProjectId,
      kind: z.enum(['decision', 'prompt', 'rejected', 'note']).default('note').describe('decision: something agreed; prompt: an instruction worth reusing; rejected: an option the user turned down; note: anything else.'),
      text: z.string().max(5000).default('').describe('The note. Keep it to one or two sentences.'),
    },
    output: z.object({ status: z.enum(['committed', 'proposed']), noteId: z.string(), commitId: z.string().optional(), proposalId: z.string().optional() }),
    example: { input: { projectId: 'prj_8Kq2...', kind: 'rejected', text: 'Seb preferred the warm palette over the neon one.' }, output: { status: 'proposed', noteId: 'note_3Fz...', proposalId: 'prop_9a...' } },
    async handler(args, ctx) {
      await ctx.requireProject(args.projectId, 'write');
      const state = await ctx.state(args.projectId);
      const note = makeNode('note', { kind: args.kind, text: args.text, author: ctx.principal.author, createdAt: new Date().toISOString() });
      const out = await ctx.apply(args.projectId, [{ kind: 'create', parentId: notesContainer(state).id, nodes: [note] }], args.text ? `Add note: ${args.text.slice(0, 60)}` : 'Add a blank note');
      return { text: outcomeText(out), data: { status: out.status, noteId: note.id, ...(out.commitId ? { commitId: out.commitId } : {}), ...(out.proposalId ? { proposalId: out.proposalId } : {}) } };
    },
  }),
];
