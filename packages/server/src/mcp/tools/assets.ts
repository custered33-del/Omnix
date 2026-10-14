import { z } from 'zod';
import { signedFileUrl } from '../../http/signedUrls.js';
import { importFromUrl } from '../../http/assetRoutes.js';
import { defineTool, ToolError } from '../registry.js';
import type { AssetRecord } from '../../assets/pipeline.js';
import type { Services } from '../../services.js';

export function assetSummary(a: AssetRecord, publicUrl: string) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    mime: a.mime,
    size: a.size,
    ...(a.width ? { width: a.width, height: a.height } : {}),
    ...(a.duration ? { duration: Math.round(a.duration * 100) / 100 } : {}),
    ...(a.fps ? { fps: a.fps } : {}),
    ...(a.hasAudio !== undefined ? { hasAudio: a.hasAudio } : {}),
    ...(a.colorProfile ? { colorProfile: a.colorProfile } : {}),
    tags: a.tags,
    url: `${publicUrl}/api/assets/${a.id}/file`,
    createdAt: a.createdAt,
  };
}

/** Assets the user can see: their own, plus anything used in projects they can access. */
export async function visibleAssets(services: Services, userId: string): Promise<AssetRecord[]> {
  const projects = new Set((await services.projects.listForUser(userId, { includeArchived: true })).map((p) => p.id));
  return (await services.assets.list()).filter((a) => a.owners.includes(userId) || a.projectIds.some((p) => projects.has(p)));
}

export async function requireAsset(services: Services, userId: string, assetId: string): Promise<AssetRecord> {
  const a = await services.assets.get(assetId);
  if (!a) throw new ToolError(`Asset not found: ${assetId}`);
  if (a.owners.includes(userId)) return a;
  const projects = new Set((await services.projects.listForUser(userId, { includeArchived: true })).map((p) => p.id));
  if (a.projectIds.some((p) => projects.has(p))) return a;
  throw new ToolError(`Asset not found: ${assetId}`);
}

export const assetReadTools = [
  defineTool({
    name: 'list_assets',
    title: 'Search the asset library',
    description: 'Search images, video, audio, LUTs and fonts in the asset library by name, tag or kind. Asset ids are content hashes and can be placed into any project.',
    category: 'assets',
    access: 'read',
    input: {
      query: z.string().optional().describe('Matches name and tags (case-insensitive).'),
      kind: z.enum(['image', 'video', 'audio', 'lut', 'font', 'text', 'data', 'other']).optional(),
      tag: z.string().optional(),
      projectId: z.string().optional().describe('Only assets used in this project.'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    output: z.object({ assets: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() }).passthrough()) }),
    example: { input: { kind: 'video', query: 'beach' } },
    async handler(args, ctx) {
      const q = args.query?.toLowerCase().trim();
      let list = await visibleAssets(ctx.services, ctx.principal.user.id);
      if (args.kind) list = list.filter((a) => a.kind === args.kind);
      if (args.tag) list = list.filter((a) => a.tags.includes(args.tag!));
      if (args.projectId) list = list.filter((a) => a.projectIds.includes(args.projectId!));
      if (q) list = list.filter((a) => a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)));
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const assets = list.slice(0, args.limit ?? 50).map((a) => assetSummary(a, ctx.services.config.publicUrl));
      return { text: assets.length ? assets.map((a) => `- ${a.name} [${a.kind}] id=${a.id}`).join('\n') : 'No matching assets.', data: { assets } };
    },
  }),
  defineTool({
    name: 'get_asset',
    title: 'Get asset details',
    description: 'Metadata for one asset: dimensions, duration, frame rate, audio, color profile, EXIF summary and where it is used.',
    category: 'assets',
    access: 'read',
    input: { assetId: z.string() },
    output: z.object({ id: z.string(), name: z.string(), kind: z.string() }).passthrough(),
    example: { input: { assetId: '9f86d081884c7d65...' } },
    async handler(args, ctx) {
      const a = await requireAsset(ctx.services, ctx.principal.user.id, args.assetId);
      const link = await signedFileUrl(ctx.services, a.id);
      const data = { ...assetSummary(a, ctx.services.config.publicUrl), downloadUrl: link.url, exif: a.exif ?? {}, projectIds: a.projectIds, proxyStatus: a.proxyStatus, source: a.source };
      return { text: `${a.name}: ${a.kind}${a.width ? ` ${a.width}x${a.height}` : ''}${a.duration ? ` ${a.duration.toFixed(2)}s` : ''}`, data };
    },
  }),
];

export const assetWriteTools = [
  defineTool({
    name: 'import_asset',
    title: 'Import a file from a URL',
    description: 'Download an image, video, audio file, font or LUT from a public URL (or a data: URL) into the asset library, optionally attached to a project, so it can be placed in canvases, timelines, documents and slides. Identical files are stored once.',
    category: 'assets',
    access: 'write',
    input: { url: z.string().url(), name: z.string().max(200).optional(), projectId: z.string().optional(), tags: z.array(z.string().max(40)).max(20).optional() },
    output: z.object({ id: z.string(), name: z.string(), kind: z.string() }).passthrough(),
    example: { input: { url: 'https://example.com/photos/beach.jpg', projectId: 'prj_8Kq2...', tags: ['reference'] }, output: { id: '3f9a...', name: 'beach.jpg', kind: 'image', width: 3000, height: 2000 } },
    async handler(args, ctx) {
      if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
      if (args.projectId) await ctx.requireProject(args.projectId, 'write');
      const a = await importFromUrl(ctx.services, args.url, { ownerId: ctx.principal.user.id, ...(args.name ? { name: args.name } : {}), ...(args.projectId ? { projectId: args.projectId } : {}), tags: args.tags ?? [], source: { kind: 'url', url: args.url, tool: 'mcp' } });
      const s = assetSummary(a, ctx.services.config.publicUrl);
      return { text: `Imported ${a.name} (${a.kind}${a.width ? ` ${a.width}x${a.height}` : ''}${a.duration ? ` ${a.duration.toFixed(1)}s` : ''}) as ${a.id}.`, data: s };
    },
  }),
  defineTool({
    name: 'tag_asset',
    title: 'Rename or tag an asset',
    description: 'Rename an asset or replace its tags, to keep the library searchable.',
    category: 'assets',
    access: 'write',
    input: { assetId: z.string(), name: z.string().min(1).max(200).optional(), tags: z.array(z.string().max(40)).max(50).optional() },
    output: z.object({ id: z.string(), name: z.string(), tags: z.array(z.string()) }),
    example: { input: { assetId: '3f9a...', tags: ['beach', 'summer', 'b-roll'] }, output: { id: '3f9a...', name: 'beach.jpg', tags: ['beach', 'summer', 'b-roll'] } },
    async handler(args, ctx) {
      if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
      const a = await requireAsset(ctx.services, ctx.principal.user.id, args.assetId);
      const next = await ctx.services.assets.update(a.id, { ...(args.name ? { name: args.name } : {}), ...(args.tags ? { tags: [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))] } : {}) });
      return { text: `Updated ${next.name}: ${next.tags.join(', ') || 'no tags'}.`, data: { id: next.id, name: next.name, tags: next.tags } };
    },
  }),
];
