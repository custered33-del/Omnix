import { z } from 'zod';
import { newId, type ProjectState, type ToolKind } from '@omnix/core';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { renderNode } from '../render/renderNode.js';
import { builtinTemplateState, builtinTemplates, type TemplateInfo } from './builtin.js';

/** A template saved by a person from one of their projects. */
interface UserTemplate extends TemplateInfo {
  ownerId: string;
  state: ProjectState;
  createdAt: string;
  shared: boolean;
}

export class TemplateService {
  constructor(private readonly services: Services) {}

  async list(userId: string): Promise<TemplateInfo[]> {
    const mine = (await this.services.store.list<UserTemplate>('templates')).filter((t) => t.ownerId === userId || t.shared);
    return [...builtinTemplates(), ...mine.map(({ state: _s, ...info }) => info)];
  }

  async getState(id: string, userId: string): Promise<ProjectState | null> {
    const b = builtinTemplateState(id);
    if (b) return b;
    const t = await this.services.store.get<UserTemplate>('templates', id);
    if (!t || (t.ownerId !== userId && !t.shared)) return null;
    return t.state;
  }

  async saveFromProject(projectId: string, userId: string, input: { name: string; description: string; shared: boolean }): Promise<TemplateInfo> {
    const meta = await this.services.projects.requireAccess(projectId, userId, 'read');
    const state = await this.services.projects.state(projectId);
    const t: UserTemplate = { id: newId('tpl'), name: input.name.trim() || meta.name, tool: meta.primaryTool, description: input.description, builtIn: false, ownerId: userId, state, createdAt: new Date().toISOString(), shared: input.shared };
    await this.services.store.put('templates', t.id, t);
    const { state: _s, ...info } = t;
    return info;
  }

  async delete(id: string, userId: string): Promise<void> {
    const t = await this.services.store.get<UserTemplate>('templates', id);
    if (!t || t.ownerId !== userId) throw new ProjectError('Template not found', 404);
    await this.services.store.delete('templates', id);
  }
}

useModule(({ services, router }) => {
  const templates = new TemplateService(services);
  services.ext.templates = templates;
  const thumbs = new Map<string, Buffer>();

  router.get(
    '/templates',
    h(async (req, res) => {
      const user = requireUser(req);
      res.json({ templates: await templates.list(user.id) });
    }),
  );

  router.get(
    '/templates/:id/thumbnail',
    h(async (req, res) => {
      const user = requireUser(req);
      const id = String(req.params.id);
      let data = thumbs.get(id);
      if (!data) {
        const state = await templates.getState(id, user.id);
        if (!state) throw new ProjectError('Template not found', 404);
        data = (await renderNode(services, state, { nodeId: null, maxSize: 640, format: 'webp' })).data;
        if (id.startsWith('builtin-')) thumbs.set(id, data);
      }
      res.set('Content-Type', 'image/webp').set('Cache-Control', 'private, max-age=600').send(data);
    }),
  );

  router.post(
    '/templates',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ projectId: z.string(), name: z.string().max(120), description: z.string().max(500).default(''), shared: z.boolean().default(false) }).parse(req.body);
      res.status(201).json({ template: await templates.saveFromProject(body.projectId, user.id, body) });
    }),
  );

  router.delete(
    '/templates/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      await templates.delete(String(req.params.id), user.id);
      res.json({ ok: true });
    }),
  );
});

export type { ToolKind };
