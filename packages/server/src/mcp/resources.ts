import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  childrenOf,
  clipsOf,
  clipEnd,
  inlineToPlain,
  notesContainer,
  outlineDocument,
  outlineProject,
  projectTreeText,
  tracksOf,
  type SceneNode,
} from '@omnix/core';
import type { ToolContext } from './registry.js';
import { assetSummary, visibleAssets } from './tools/assets.js';
import { compactProps } from './tools/project.js';

/**
 * Read-only MCP resources. Claude (or any MCP client) can attach these directly as context:
 * the project list, a project's cross-tool outline, layer tree, timeline, code tree,
 * document outline, slide list, current selection, notes and the asset library.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  const json = (uri: URL, data: unknown) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });
  const text = (uri: URL, data: string) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: data }] });

  const projectList = async () => {
    const all = await ctx.services.projects.listForUser(ctx.principal.user.id);
    return ctx.principal.projectIds === 'all' ? all : all.filter((p) => (ctx.principal.projectIds as string[]).includes(p.id));
  };

  const listProjectsAs = (suffix: string, mime = 'application/json') => async () => ({
    resources: (await projectList()).map((p) => ({ uri: `omnix://projects/${p.id}${suffix}`, name: `${p.name}${suffix ? ` ${suffix.slice(1)}` : ''}`, mimeType: mime })),
  });

  server.registerResource('projects', 'omnix://projects', { title: 'Projects', description: 'All projects this connection can access.', mimeType: 'application/json' }, async (uri) =>
    json(uri, (await projectList()).map((p) => ({ id: p.id, name: p.name, primaryTool: p.primaryTool, updatedAt: p.updatedAt, aiConsent: p.aiConsent }))),
  );

  server.registerResource(
    'project',
    new ResourceTemplate('omnix://projects/{projectId}', { list: listProjectsAs('') }),
    { title: 'Project overview', description: 'Cross-tool outline of a project.', mimeType: 'application/json' },
    async (uri, { projectId }) => {
      await ctx.requireProject(String(projectId), 'read');
      return json(uri, outlineProject(await ctx.state(String(projectId))));
    },
  );

  server.registerResource(
    'project-tree',
    new ResourceTemplate('omnix://projects/{projectId}/tree', { list: listProjectsAs('/tree', 'text/plain') }),
    { title: 'Scene graph', description: 'Every node with id and label, as indented text.', mimeType: 'text/plain' },
    async (uri, { projectId }) => {
      await ctx.requireProject(String(projectId), 'read');
      return text(uri, projectTreeText(await ctx.state(String(projectId)), 2000));
    },
  );

  server.registerResource(
    'layers',
    new ResourceTemplate('omnix://projects/{projectId}/layers/{canvasId}', { list: undefined }),
    { title: 'Layer tree', description: 'Layers of a canvas, bottom to top, with blend modes, masks and filters.', mimeType: 'application/json' },
    async (uri, { projectId, canvasId }) => {
      await ctx.requireProject(String(projectId), 'read');
      const state = await ctx.state(String(projectId));
      const canvas = state.nodes[String(canvasId)];
      if (!canvas || canvas.type !== 'canvas') throw new Error('Canvas not found');
      const walkLayers = (id: string): unknown[] =>
        childrenOf(state, id)
          .filter((n): n is SceneNode<'layer'> => n.type === 'layer')
          .map((l) => ({ id: l.id, ...compactProps(l.props as unknown as Record<string, unknown>), children: walkLayers(l.id) }));
      return json(uri, { canvas: { id: canvas.id, ...(canvas.props as object) }, layers: walkLayers(canvas.id) });
    },
  );

  server.registerResource(
    'timeline',
    new ResourceTemplate('omnix://projects/{projectId}/timeline/{sequenceId}', { list: undefined }),
    { title: 'Timeline', description: 'Tracks (top first) and clips with timing, speed, transitions and keyframed properties.', mimeType: 'application/json' },
    async (uri, { projectId, sequenceId }) => {
      await ctx.requireProject(String(projectId), 'read');
      const state = await ctx.state(String(projectId));
      const seq = state.nodes[String(sequenceId)];
      if (!seq || seq.type !== 'sequence') throw new Error('Sequence not found');
      return json(uri, {
        sequence: { id: seq.id, ...(seq.props as object) },
        tracks: tracksOf(state, seq.id).map((t) => ({
          id: t.id,
          ...t.props,
          clips: clipsOf(state, t.id).map((c) => ({ id: c.id, end: clipEnd(c.props), ...compactProps(c.props as unknown as Record<string, unknown>) })),
          animLayers: childrenOf(state, t.id)
            .filter((a): a is SceneNode<'animLayer'> => a.type === 'animLayer')
            .map((a) => ({ id: a.id, ...compactProps(a.props as unknown as Record<string, unknown>) })),
        })),
      });
    },
  );

  server.registerResource(
    'code',
    new ResourceTemplate('omnix://projects/{projectId}/code/{workspaceId}', { list: undefined }),
    { title: 'Code tree', description: 'Files and notebook cells of a code workspace.', mimeType: 'application/json' },
    async (uri, { projectId, workspaceId }) => {
      await ctx.requireProject(String(projectId), 'read');
      const state = await ctx.state(String(projectId));
      const ws = state.nodes[String(workspaceId)];
      if (!ws || ws.type !== 'codeWorkspace') throw new Error('Workspace not found');
      return json(uri, outlineDocument(state, ws));
    },
  );

  server.registerResource(
    'document',
    new ResourceTemplate('omnix://projects/{projectId}/document/{documentId}', { list: undefined }),
    { title: 'Document', description: 'Document outline and blocks (inline markdown).', mimeType: 'application/json' },
    async (uri, { projectId, documentId }) => {
      await ctx.requireProject(String(projectId), 'read');
      const state = await ctx.state(String(projectId));
      const doc = state.nodes[String(documentId)];
      if (!doc || doc.type !== 'document') throw new Error('Document not found');
      return json(uri, {
        outline: outlineDocument(state, doc),
        blocks: childrenOf(state, doc.id)
          .filter((b): b is SceneNode<'block'> => b.type === 'block')
          .map((b) => ({ id: b.id, ...b.props })),
      });
    },
  );

  server.registerResource(
    'slides',
    new ResourceTemplate('omnix://projects/{projectId}/slides/{deckId}', { list: undefined }),
    { title: 'Slide list', description: 'Slides with elements, notes and transitions.', mimeType: 'application/json' },
    async (uri, { projectId, deckId }) => {
      await ctx.requireProject(String(projectId), 'read');
      const state = await ctx.state(String(projectId));
      const deck = state.nodes[String(deckId)];
      if (!deck || deck.type !== 'deck') throw new Error('Deck not found');
      return json(uri, {
        deck: { id: deck.id, ...(deck.props as object) },
        slides: childrenOf(state, deck.id)
          .filter((s): s is SceneNode<'slide'> => s.type === 'slide')
          .map((s) => ({
            id: s.id,
            ...s.props,
            elements: childrenOf(state, s.id)
              .filter((e): e is SceneNode<'slideElement'> => e.type === 'slideElement')
              .map((e) => ({ id: e.id, ...e.props, plainText: e.props.text ? inlineToPlain(e.props.text) : undefined })),
          })),
      });
    },
  );

  server.registerResource(
    'selection',
    new ResourceTemplate('omnix://projects/{projectId}/selection', { list: undefined }),
    { title: 'Current selection', description: 'What the user has selected right now.', mimeType: 'application/json' },
    async (uri, { projectId }) => {
      await ctx.requireProject(String(projectId), 'read');
      return json(uri, ctx.services.presence.selectionFor(String(projectId), ctx.principal.user.id) ?? { nodeIds: [], location: null });
    },
  );

  server.registerResource(
    'notes',
    new ResourceTemplate('omnix://projects/{projectId}/notes', { list: undefined }),
    { title: 'Session memory', description: 'Decisions, prompts and rejected options for this project.', mimeType: 'application/json' },
    async (uri, { projectId }) => {
      await ctx.requireProject(String(projectId), 'read');
      const state = await ctx.state(String(projectId));
      return json(
        uri,
        childrenOf(state, notesContainer(state).id).map((n) => ({ id: n.id, ...(n.props as object) })),
      );
    },
  );

  server.registerResource('assets', 'omnix://assets', { title: 'Asset library', description: 'Images, video, audio, LUTs and fonts.', mimeType: 'application/json' }, async (uri) =>
    json(uri, (await visibleAssets(ctx.services, ctx.principal.user.id)).map((a) => assetSummary(a, ctx.services.config.publicUrl))),
  );
}
