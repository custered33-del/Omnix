import express from 'express';
import { z } from 'zod';
import { TOOL_KINDS, aiMarks, diffStates, outlineProject, summarizeDiff, zOperation, type ToolKind } from '@omnix/core';
import type { Services } from '../services.js';
import { author, h, requireUser } from './middleware.js';
import { renderNode } from '../render/renderNode.js';
import { ProjectError } from '../projects/service.js';

/** Small in-memory LRU for rendered thumbnails keyed by project + version. */
const thumbCache = new Map<string, Buffer>();
function cacheThumb(key: string, data: Buffer): void {
  thumbCache.set(key, data);
  if (thumbCache.size > 200) thumbCache.delete(thumbCache.keys().next().value!);
}

export function projectRoutes(services: Services): express.Router {
  const r = express.Router();
  const P = services.projects;

  r.get(
    '/',
    h(async (req, res) => {
      const user = requireUser(req);
      const list = await P.listForUser(user.id, { includeArchived: req.query.archived === 'true' });
      res.json({ projects: list.map((m) => ({ ...m, role: P.roleOf(m, user.id) })) });
    }),
  );

  r.post(
    '/',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z
        .object({
          name: z.string().max(200).default('Untitled project'),
          primaryTool: z.enum(TOOL_KINDS as [ToolKind, ...ToolKind[]]),
          templateId: z.string().optional(),
          aiConsent: z.boolean().optional(),
          description: z.string().max(2000).optional(),
        })
        .parse(req.body);
      let state;
      if (body.templateId) {
        const templates = services.ext.templates as { getState(id: string, userId: string): Promise<import('@omnix/core').ProjectState | null> } | undefined;
        state = (await templates?.getState(body.templateId, user.id)) ?? undefined;
        if (!state) throw new ProjectError('Template not found', 404);
      }
      const meta = await P.create({ name: body.name, primaryTool: body.primaryTool, ownerId: user.id, author: author(req), ...(state ? { state } : {}), ...(body.templateId ? { templateId: body.templateId } : {}), ...(body.aiConsent !== undefined ? { aiConsent: body.aiConsent } : {}), ...(body.description ? { description: body.description } : {}) });
      res.status(201).json({ project: meta });
    }),
  );

  r.get(
    '/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const meta = await P.requireAccess(String(req.params.id), user.id, 'read');
      const session = await P.session(meta.id);
      res.json({
        project: { ...meta, role: P.roleOf(meta, user.id) },
        state: session.state,
        head: session.head,
        proposals: session.listProposals('open'),
        snapshots: session.listSnapshots(),
        aiMarks: Object.fromEntries(Object.entries(aiMarks(session.log())).filter(([nodeId]) => session.state.nodes[nodeId])),
      });
    }),
  );

  r.get(
    '/:id/outline',
    h(async (req, res) => {
      const user = requireUser(req);
      await P.requireAccess(String(req.params.id), user.id, 'read');
      res.json(outlineProject(await P.state(String(req.params.id))));
    }),
  );

  r.patch(
    '/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      const body = z.object({ name: z.string().max(200).optional(), archived: z.boolean().optional(), description: z.string().max(2000).optional(), aiConsent: z.boolean().optional() }).parse(req.body);
      await P.requireAccess(id, user.id, body.aiConsent !== undefined || body.archived !== undefined ? 'admin' : 'write');
      let meta = await P.getMeta(id);
      if (body.aiConsent !== undefined && body.aiConsent !== meta.aiConsent) meta = await P.setAiConsent(id, body.aiConsent, author(req));
      const patch: Parameters<typeof P.updateMeta>[1] = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.archived !== undefined) patch.archived = body.archived;
      if (body.description !== undefined) patch.description = body.description;
      if (Object.keys(patch).length) meta = await P.updateMeta(id, patch, author(req));
      res.json({ project: meta });
    }),
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      await P.requireAccess(String(req.params.id), user.id, 'admin');
      await P.delete(String(req.params.id), author(req));
      res.json({ ok: true });
    }),
  );

  /* Members --------------------------------------------------------- */
  r.post(
    '/:id/members',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'admin');
      const body = z.object({ email: z.string(), role: z.enum(['editor', 'viewer']) }).parse(req.body);
      const member = await services.users.byEmail(body.email);
      if (!member) throw new ProjectError('No Omnix account uses that email on this server', 404);
      const meta = await P.getMeta(id);
      const members = [...meta.members.filter((m) => m.userId !== member.id), { userId: member.id, role: body.role }];
      res.json({ project: await P.updateMeta(id, { members }, author(req)) });
    }),
  );

  r.delete(
    '/:id/members/:userId',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'admin');
      const meta = await P.getMeta(id);
      res.json({ project: await P.updateMeta(id, { members: meta.members.filter((m) => m.userId !== req.params.userId) }, author(req)) });
    }),
  );

  /* Operations ------------------------------------------------------ */
  r.post(
    '/:id/commits',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'write');
      const body = z.object({ op: zOperation, label: z.string().max(200).optional(), baseHead: z.string().nullable().optional() }).parse(req.body);
      const commit = await P.commit(id, body.op, author(req), { ...(body.label ? { label: body.label } : {}), via: req.viaToken ? 'api' : 'ui', ...(body.baseHead !== undefined ? { baseHead: body.baseHead } : {}) });
      res.status(201).json({ commit, head: (await P.session(id)).head });
    }),
  );

  r.post(
    '/:id/undo',
    h(async (req, res) => {
      const user = requireUser(req);
      await P.requireAccess(String(req.params.id), user.id, 'write');
      const c = await P.undo(String(req.params.id), author(req));
      res.json({ commit: c });
    }),
  );

  r.post(
    '/:id/redo',
    h(async (req, res) => {
      const user = requireUser(req);
      await P.requireAccess(String(req.params.id), user.id, 'write');
      const c = await P.redo(String(req.params.id), author(req));
      res.json({ commit: c });
    }),
  );

  r.post(
    '/:id/revert',
    h(async (req, res) => {
      const user = requireUser(req);
      await P.requireAccess(String(req.params.id), user.id, 'write');
      const body = z.object({ commitId: z.string() }).parse(req.body);
      res.json({ commit: await P.revert(String(req.params.id), body.commitId, author(req)) });
    }),
  );

  r.get(
    '/:id/history',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'read');
      const session = await P.session(id);
      const all = req.query.all === 'true';
      const commits = (all ? session.allCommits() : session.log()).map(({ op: _op, inverse: _inv, ...rest }) => rest);
      res.json({ head: session.head, commits, tips: session.branchTips().map((c) => c.id), snapshots: session.listSnapshots() });
    }),
  );

  r.get(
    '/:id/commits/:commitId',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'read');
      const session = await P.session(id);
      const c = session.getCommit(String(req.params.commitId));
      if (!c) throw new ProjectError('Commit not found', 404);
      const before = session.stateAt(c.parentId);
      const after = session.stateAt(c.id);
      res.json({ commit: c, diff: diffStates(before, after) });
    }),
  );

  r.post(
    '/:id/checkout',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'write');
      const body = z.object({ commitId: z.string().nullable() }).parse(req.body);
      const state = await P.checkout(id, body.commitId, author(req));
      res.json({ state, head: (await P.session(id)).head });
    }),
  );

  r.post(
    '/:id/snapshots',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'write');
      const body = z.object({ name: z.string().max(120) }).parse(req.body);
      res.status(201).json({ snapshot: await P.snapshot(id, body.name, author(req)) });
    }),
  );

  r.get(
    '/:id/diff',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'read');
      const session = await P.session(id);
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : session.head;
      const diff = session.diffCommits(from === 'base' ? null : from, to === 'base' ? null : to);
      res.json({ diff, summary: summarizeDiff(diff) });
    }),
  );

  /* Proposals ------------------------------------------------------- */
  r.get(
    '/:id/proposals',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'read');
      const session = await P.session(id);
      const status = req.query.status ? (String(req.query.status) as 'open') : undefined;
      res.json({ proposals: session.listProposals(status) });
    }),
  );

  r.get(
    '/:id/proposals/:pid/preview',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'read');
      const session = await P.session(id);
      const { state, diff } = session.previewProposal(String(req.params.pid));
      res.json({ state, diff, summary: summarizeDiff(diff) });
    }),
  );

  r.post(
    '/:id/proposals/:pid/accept',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'write');
      const body = z.object({ ops: z.array(zOperation).optional() }).parse(req.body ?? {});
      res.json({ commit: await P.acceptProposal(id, String(req.params.pid), author(req), body.ops) });
    }),
  );

  r.post(
    '/:id/proposals/:pid/reject',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'write');
      const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
      const proposal = await P.rejectProposal(id, String(req.params.pid), author(req), body.reason);
      const notes = services.ext.notes as { recordRejection(projectId: string, label: string, reason: string | undefined, by: import('@omnix/core').Author, proposalId?: string): Promise<unknown> } | undefined;
      await notes?.recordRejection(id, proposal.label, body.reason, author(req), proposal.id);
      res.json({ proposal });
    }),
  );

  /* Rendering ------------------------------------------------------- */
  r.get(
    '/:id/render',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'read');
      const q = z
        .object({
          node: z.string().optional(),
          t: z.coerce.number().min(0).optional(),
          size: z.coerce.number().int().min(16).max(4096).optional(),
          format: z.enum(['png', 'webp', 'jpeg']).optional(),
          scheme: z.enum(['light', 'dark']).optional(),
          step: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.query);
      const state = await P.state(id);
      const img = await renderNode(services, state, { nodeId: q.node ?? null, ...(q.t !== undefined ? { time: q.t } : {}), maxSize: q.size ?? 1024, format: q.format ?? 'png', ...(q.scheme ? { scheme: q.scheme } : {}), ...(q.step !== undefined ? { step: q.step } : {}) });
      res.set('Content-Type', img.mime).set('Cache-Control', 'no-store').send(img.data);
    }),
  );

  r.get(
    '/:id/thumbnail',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      const meta = await P.requireAccess(id, user.id, 'read');
      const scheme = req.query.scheme === 'dark' ? 'dark' : 'light';
      const key = `${id}:${meta.thumbnailVersion}:${scheme}`;
      let data = thumbCache.get(key);
      if (!data) {
        const state = await P.state(id);
        data = (await renderNode(services, state, { nodeId: null, maxSize: 640, format: 'webp', scheme })).data;
        cacheThumb(key, data);
      }
      res.set('Content-Type', 'image/webp').set('Cache-Control', 'private, max-age=60').send(data);
    }),
  );

  /* Diff images for version comparison (visual diff) -------------- */
  r.get(
    '/:id/render-at',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      await P.requireAccess(id, user.id, 'read');
      const session = await P.session(id);
      const commitId = req.query.commit === 'base' ? null : String(req.query.commit ?? session.head ?? '');
      const state = session.stateAt(commitId || null);
      const img = await renderNode(services, state, { nodeId: req.query.node ? String(req.query.node) : null, maxSize: Number(req.query.size ?? 768), format: 'png', ...(req.query.t ? { time: Number(req.query.t) } : {}) });
      res.set('Content-Type', img.mime).send(img.data);
    }),
  );

  return r;
}
