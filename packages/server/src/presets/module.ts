import { z } from 'zod';
import express from 'express';
import { applyPresetOps, BUILTIN_PRESETS, newId, parsePresetData, PRESET_KINDS, PRESET_TARGETS, presetFromNode, type Author, type Preset, type PresetKind, type ProjectState } from '@omnix/core';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { defineTool, ToolError, zProjectId, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { writeResult, zWriteResult } from '../mcp/tools/helpers.js';
import { defineBatchOperation, registerBatchOperation } from '../batch/operations.js';
import type { TemplateService } from '../templates/module.js';

/**
 * Presets and templates (feature 55). Project templates live in the templates module; this module
 * keeps the smaller reusable pieces (looks for layers and clips, animation rigs, document text
 * styles, slideshow themes): built in, saved by a person, or shared with everyone on the server.
 */

export interface StoredPreset extends Preset {
  ownerId: string;
  ownerName: string;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

const COLLECTION = 'presets';

export class PresetService {
  constructor(private readonly services: Services) {}

  async list(userId: string, kind?: PresetKind): Promise<(Preset & { ownerName?: string; shared?: boolean; mine?: boolean })[]> {
    const saved = (await this.services.store.list<StoredPreset>(COLLECTION)).filter((p) => p.ownerId === userId || p.shared);
    const all = [...BUILTIN_PRESETS, ...saved.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((p) => ({ ...p, mine: p.ownerId === userId }))];
    return kind ? all.filter((p) => p.kind === kind) : all;
  }

  async get(id: string, userId: string): Promise<Preset> {
    const b = BUILTIN_PRESETS.find((p) => p.id === id);
    if (b) return b;
    const p = await this.services.store.get<StoredPreset>(COLLECTION, id);
    if (!p || (p.ownerId !== userId && !p.shared)) throw new ProjectError('Preset not found', 404);
    return p;
  }

  /** Find a preset by id or by name (Claude often knows the name). */
  async find(ref: string, userId: string, kind?: PresetKind): Promise<Preset> {
    const byId = await this.get(ref, userId).catch(() => null);
    if (byId) return byId;
    const needle = ref.trim().toLowerCase();
    const hit = (await this.list(userId, kind)).find((p) => p.name.toLowerCase() === needle);
    if (!hit) throw new ProjectError(`No preset called "${ref}". See list_presets.`, 404);
    return hit;
  }

  async save(user: { id: string; name: string }, input: { kind: PresetKind; name: string; description?: string; data: unknown; shared?: boolean }): Promise<StoredPreset> {
    const data = parsePresetData(input.kind, input.data);
    const now = new Date().toISOString();
    const p: StoredPreset = { id: newId('pre'), kind: input.kind, name: input.name.trim().slice(0, 80) || 'Preset', description: (input.description ?? '').slice(0, 300), data, ownerId: user.id, ownerName: user.name, shared: !!input.shared, createdAt: now, updatedAt: now };
    await this.services.store.put(COLLECTION, p.id, p);
    return p;
  }

  /** Save a node's look as a preset. `state` is the project as the caller sees it (with its own proposed changes). */
  async saveFromNode(user: { id: string; name: string }, projectId: string, nodeId: string, input: { name: string; description?: string; shared?: boolean }, inState?: ProjectState): Promise<StoredPreset> {
    await this.services.projects.requireAccess(projectId, user.id, 'read');
    const state = inState ?? (await this.services.projects.state(projectId));
    let captured;
    try {
      captured = presetFromNode(state, nodeId);
    } catch (e) {
      throw new ProjectError(e instanceof Error ? e.message : String(e), 400);
    }
    return this.save(user, { ...input, kind: captured.kind, data: captured.data });
  }

  async update(id: string, userId: string, patch: { name?: string; description?: string; shared?: boolean }): Promise<StoredPreset> {
    const p = await this.services.store.get<StoredPreset>(COLLECTION, id);
    if (!p || p.ownerId !== userId) throw new ProjectError('Only the person who saved a preset can change it.', 404);
    const next: StoredPreset = { ...p, ...(patch.name ? { name: patch.name.trim().slice(0, 80) } : {}), ...(patch.description !== undefined ? { description: patch.description.slice(0, 300) } : {}), ...(patch.shared !== undefined ? { shared: patch.shared } : {}), updatedAt: new Date().toISOString() };
    await this.services.store.put(COLLECTION, id, next);
    return next;
  }

  async delete(id: string, userId: string): Promise<void> {
    const p = await this.services.store.get<StoredPreset>(COLLECTION, id);
    if (!p || p.ownerId !== userId) throw new ProjectError('Only the person who saved a preset can delete it.', 404);
    await this.services.store.delete(COLLECTION, id);
  }

  /** The operations that apply a preset to a node in a project's current state. */
  async opsFor(projectId: string, preset: Preset, targetId: string) {
    const state = await this.services.projects.state(projectId);
    try {
      const ops = applyPresetOps(state, preset, targetId);
      if (!ops.length) throw new Error(`Nothing in there takes a ${preset.kind} preset.`);
      return ops;
    } catch (e) {
      throw new ProjectError(e instanceof Error ? e.message : String(e), 400);
    }
  }
}

export function presetsOf(services: Services): PresetService {
  return services.ext.presets as PresetService;
}

const zKind = z.enum(PRESET_KINDS as [PresetKind, ...PresetKind[]]);

function summary(p: Preset & { ownerName?: string; shared?: boolean; mine?: boolean }) {
  return { id: p.id, kind: p.kind, name: p.name, description: p.description, builtIn: !!p.builtIn, appliesTo: PRESET_TARGETS[p.kind], ...(p.ownerName ? { by: p.ownerName } : {}), ...(p.shared !== undefined ? { shared: p.shared } : {}), ...(p.mine !== undefined ? { mine: p.mine } : {}) };
}

function presetTools(services: Services): ToolDef[] {
  const presets = presetsOf(services);
  const templates = () => services.ext.templates as TemplateService;
  return [
    defineTool({
      name: 'list_presets',
      title: 'List presets and templates',
      description:
        'Reusable presets: layer-effects (filter stacks for canvas layers), clip-effects (looks for video clips), rig (animation rigs with their motion), doc-styles (a document\'s text styles), slide-theme (slideshow colors and fonts). Built-in ones plus the person\'s own and shared ones. With kind "template", lists project templates for create_project.',
      category: 'project',
      access: 'read',
      input: { kind: z.union([zKind, z.literal('template')]).optional() },
      output: z.object({ presets: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string() }).passthrough()) }),
      example: { input: { kind: 'clip-effects' }, output: { presets: [{ id: 'builtin-clip-warm-film', kind: 'clip-effects', name: 'Warm film', appliesTo: ['clip', 'track', 'sequence'] }] } },
      async handler(args, ctx) {
        if (args.kind === 'template') {
          const list = (await templates().list(ctx.principal.user.id)).map((tpl) => ({ id: tpl.id, kind: 'template', name: tpl.name, tool: tpl.tool, description: tpl.description }));
          return { text: list.map((x) => `- ${x.id} (${x.tool}): ${x.name}. ${x.description}`).join('\n'), data: { presets: list } };
        }
        const list = (await presets.list(ctx.principal.user.id, args.kind)).map(summary);
        return { text: list.map((p) => `- ${p.id} [${p.kind}] ${p.name}: ${p.description}`).join('\n') || 'No presets.', data: { presets: list } };
      },
    }),
    defineTool({
      name: 'save_preset',
      title: 'Save something as a preset',
      description: "Save a reusable piece of a project as a preset: a layer's filters, a clip's effects, an animation layer's rig and motion, a document's text styles, or a slideshow's theme. Pass the node; the kind follows from it.",
      category: 'project',
      access: 'write',
      input: { projectId: zProjectId, nodeId: z.string(), name: z.string().min(1).max(80), description: z.string().max(300).optional(), shared: z.boolean().optional().describe('Let everyone on this Omnix server use it') },
      output: z.object({ presetId: z.string(), kind: z.string() }),
      example: { input: { projectId: 'prj_8Kq2...', nodeId: 'clp_4', name: 'Teal and orange' }, output: { presetId: 'pre_7b...', kind: 'clip-effects' } },
      async handler(args, ctx) {
        if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
        await ctx.requireProject(args.projectId, 'read');
        try {
          const p = await presets.saveFromNode({ id: ctx.principal.user.id, name: ctx.principal.author.name }, args.projectId, args.nodeId, { name: args.name, ...(args.description ? { description: args.description } : {}), ...(args.shared !== undefined ? { shared: args.shared } : {}) }, await ctx.state(args.projectId));
          return { text: `Saved ${p.kind} preset "${p.name}" (${p.id}).`, data: { presetId: p.id, kind: p.kind } };
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e));
        }
      },
    }),
    defineTool({
      name: 'apply_preset',
      title: 'Apply a preset',
      description:
        "Apply a preset (id or name from list_presets) to a target: layer-effects to a layer or a whole canvas (its pictures), clip-effects to a clip, a track or a whole sequence (picture clips), rig to an animation layer, doc-styles to a document, slide-theme to a slideshow. Looks are added on top of existing ones; rigs, styles and themes replace the target's own.",
      category: 'project',
      access: 'write',
      input: { projectId: zProjectId, preset: z.string().describe('Preset id or exact name'), nodeId: z.string().describe('What to apply it to') },
      output: zWriteResult.extend({ changed: z.number() }),
      example: { input: { projectId: 'prj_8Kq2...', preset: 'Warm film', nodeId: 'seq_main' }, output: { status: 'proposed', proposalId: 'prop_9...', changed: 4 } },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'write');
        let ops;
        let preset: Preset;
        try {
          preset = await presets.find(args.preset, ctx.principal.user.id);
          ops = applyPresetOps(await ctx.state(args.projectId), preset, args.nodeId);
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e));
        }
        if (!ops.length) throw new ToolError(`Nothing in that target takes a ${preset.kind} preset.`);
        const out = await ctx.apply(args.projectId, ops, `Apply preset "${preset.name}"`);
        return writeResult(out, { changed: ops.length });
      },
    }),
  ];
}

useModule(({ services, router }) => {
  const presets = new PresetService(services);
  services.ext.presets = presets;
  registerToolProvider(services, () => presetTools(services));

  // Batch: apply one preset to many documents (themes to decks, styles to documents, looks to sequences or canvases).
  registerBatchOperation(
    services,
    defineBatchOperation({
      id: 'document.preset',
      label: 'Apply a preset',
      description: 'Apply a saved or built-in preset to each document: a slideshow theme, document styles, a look for every picture clip in a video, or a filter stack for the pictures on a canvas.',
      group: 'document',
      documentTypes: ['canvas', 'sequence', 'document', 'deck'],
      params: { presetId: z.string().describe('Preset id or name') },
      async run(ctx, target, p) {
        if (!('documentId' in target)) throw new Error('This operation works on project documents.');
        const preset = await presets.find(p.presetId, ctx.user.id);
        const state = await services.projects.state(target.projectId);
        let ops;
        try {
          ops = applyPresetOps(state, preset, target.documentId);
        } catch (e) {
          return { status: 'skipped', message: e instanceof Error ? e.message : String(e) };
        }
        if (!ops.length) return { status: 'skipped', message: `Nothing here takes a ${preset.kind} preset` };
        const out = await ctx.apply(target.projectId, ops, `Apply preset "${preset.name}"`);
        return { status: 'done', ...(out.status === 'committed' ? { commitId: out.id } : { proposalId: out.id }), message: `${ops.length} change${ops.length === 1 ? '' : 's'}` };
      },
    }),
  );

  const r = express.Router();
  r.get(
    '/presets',
    h(async (req, res) => {
      const user = requireUser(req);
      const kind = req.query.kind ? zKind.parse(req.query.kind) : undefined;
      res.json({ presets: (await presets.list(user.id, kind)).map((p) => ({ ...summary(p), data: p.data })) });
    }),
  );
  r.post(
    '/presets',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z
        .object({ name: z.string().min(1).max(80), description: z.string().max(300).optional(), shared: z.boolean().optional(), from: z.object({ projectId: z.string(), nodeId: z.string() }).optional(), kind: zKind.optional(), data: z.unknown().optional() })
        .parse(req.body);
      const meta = { name: body.name, ...(body.description ? { description: body.description } : {}), ...(body.shared !== undefined ? { shared: body.shared } : {}) };
      let p: StoredPreset;
      if (body.from) p = await presets.saveFromNode(user, body.from.projectId, body.from.nodeId, meta);
      else {
        if (!body.kind) throw new ProjectError('Give the preset kind and data, or the node to save it from.', 400);
        try {
          p = await presets.save(user, { ...meta, kind: body.kind, data: body.data });
        } catch (e) {
          throw new ProjectError(e instanceof Error ? e.message : String(e), 400);
        }
      }
      res.status(201).json({ preset: { ...summary({ ...p, mine: true }), data: p.data } });
    }),
  );
  r.patch(
    '/presets/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ name: z.string().min(1).max(80).optional(), description: z.string().max(300).optional(), shared: z.boolean().optional() }).parse(req.body);
      res.json({ preset: summary({ ...(await presets.update(String(req.params.id), user.id, body)), mine: true }) });
    }),
  );
  r.delete(
    '/presets/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      await presets.delete(String(req.params.id), user.id);
      res.json({ ok: true });
    }),
  );
  /** Apply a preset to something in a project (one undoable change). */
  r.post(
    '/projects/:id/presets/apply',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const body = z.object({ presetId: z.string(), targetId: z.string() }).parse(req.body);
      const preset = await presets.get(body.presetId, user.id);
      const ops = await presets.opsFor(projectId, preset, body.targetId);
      const author: Author = { type: 'human', id: user.id, name: user.name };
      const commit = await services.projects.commit(projectId, ops.length === 1 ? ops[0]! : { kind: 'batch', ops }, author, { label: `Apply preset "${preset.name}"`, via: 'ui' });
      res.json({ commitId: commit.id, changed: ops.length });
    }),
  );
  router.use(r);
});
