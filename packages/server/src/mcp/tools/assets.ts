import { z } from 'zod';
import { signedFileUrl } from '../../http/signedUrls.js';
import { importFromUrl, libraryFor } from '../../http/assetRoutes.js';
import { ensureAnalyzed, mergeAssets, searchAssets, similarGroups, similarTo } from '../../assets/library.js';
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
    ...(a.autoTags?.length ? { autoTags: a.autoTags } : {}),
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
    description:
      'Search images, video, audio, LUTs and fonts in the asset library. Every word must match something about the file: name, tags, automatic tags (landscape, portrait, square, 4k, transparent, short, silent, main colors like blue or orange), size such as 1920x1080, the prompt it was generated from, camera details, or a project it is used in. "unused" finds files no project uses. Asset ids are content hashes and can be placed into any project.',
    category: 'assets',
    access: 'read',
    input: {
      query: z.string().optional().describe('Words to match, e.g. "blue landscape logo" or "kind:video short".'),
      kind: z.enum(['image', 'video', 'audio', 'lut', 'font', 'text', 'data', 'other']).optional(),
      tag: z.string().optional(),
      projectId: z.string().optional().describe('Only assets used in this project.'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    output: z.object({ assets: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() }).passthrough()) }),
    example: { input: { kind: 'video', query: 'beach' } },
    async handler(args, ctx) {
      const { list: all, usage } = await libraryFor(ctx.services, ctx.principal.user.id);
      const list = searchAssets(all, { ...(args.query ? { query: args.query } : {}), ...(args.kind ? { kind: args.kind } : {}), ...(args.tag ? { tag: args.tag } : {}), ...(args.projectId ? { projectId: args.projectId } : {}), usage });
      const assets = list.slice(0, args.limit ?? 50).map((a) => ({ ...assetSummary(a, ctx.services.config.publicUrl), usedIn: (usage.get(a.id) ?? []).map((u) => u.projectName) }));
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
      const a = await ensureAnalyzed(ctx.services, await requireAsset(ctx.services, ctx.principal.user.id, args.assetId));
      const link = await signedFileUrl(ctx.services, a.id);
      const { list, usage } = await libraryFor(ctx.services, ctx.principal.user.id);
      const similar = similarTo(a, list).map(({ asset, distance }) => ({ id: asset.id, name: asset.name, distance }));
      const data = { ...assetSummary(a, ctx.services.config.publicUrl), downloadUrl: link.url, exif: a.exif ?? {}, projectIds: a.projectIds, usedIn: usage.get(a.id) ?? [], similar, proxyStatus: a.proxyStatus, source: a.source };
      return { text: `${a.name}: ${a.kind}${a.width ? ` ${a.width}x${a.height}` : ''}${a.duration ? ` ${a.duration.toFixed(2)}s` : ''}${similar.length ? `. Looks like ${similar.length} other file(s): ${similar.map((s) => s.name).join(', ')}` : ''}`, data };
    },
  }),
  defineTool({
    name: 'find_similar_assets',
    title: 'Find near-duplicate files',
    description: 'Find groups of pictures and videos in the library that are the same image in different files (resized, re-encoded or re-saved copies). Identical files are already stored once; these are the near-duplicates. The first file in each group is the best copy to keep (largest picture). Merge a group with merge_assets.',
    category: 'assets',
    access: 'read',
    input: {},
    output: z.object({ groups: z.array(z.array(z.object({ id: z.string(), name: z.string() }).passthrough())) }),
    example: { input: {}, output: { groups: [[{ id: '3f9a...', name: 'logo.png', width: 2000, height: 2000, usedIn: ['Launch'] }, { id: '77c1...', name: 'logo-small.jpg', width: 500, height: 500, usedIn: [] }]] } },
    async handler(_args, ctx) {
      const { list, usage } = await libraryFor(ctx.services, ctx.principal.user.id);
      const groups = similarGroups(list).map((g) => g.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, ...(a.width ? { width: a.width, height: a.height } : {}), usedIn: (usage.get(a.id) ?? []).map((u) => u.projectName) })));
      return { text: groups.length ? groups.map((g, i) => `${i + 1}. ${g.map((a) => `${a.name} (${a.width ?? '?'}x${a.height ?? '?'})`).join(' ≈ ')}`).join('\n') : 'No near-duplicates in the library.', data: { groups } };
    },
  }),
];

export const assetWriteTools = [
  defineTool({
    name: 'merge_assets',
    title: 'Merge near-duplicate files',
    description: 'Keep one file and switch every use of the other copies (layers, clips, slide images, document images, LUTs) to it in each project you can edit, then remove the copies from the library. With edit-with-approval the project changes arrive as proposals and the copies stay until they are accepted.',
    category: 'assets',
    access: 'write',
    destructive: true,
    input: { keep: z.string().describe('Asset id to keep'), drop: z.array(z.string()).min(1).max(50).describe('Asset ids to merge into it') },
    output: z.object({ kept: z.string(), merged: z.array(z.string()), projects: z.array(z.unknown()) }),
    example: { input: { keep: '3f9a...', drop: ['77c1...'] }, output: { kept: '3f9a...', merged: ['77c1...'], projects: [{ projectName: 'Launch', replaced: 2, status: 'committed' }] } },
    async handler(args, ctx) {
      if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only.');
      for (const id of [args.keep, ...args.drop]) await requireAsset(ctx.services, ctx.principal.user.id, id);
      const result = await mergeAssets(ctx.services, ctx.principal.user.id, args.keep, args.drop, async (projectId, ops, label) => {
        const out = await ctx.apply(projectId, ops, label);
        return out.status === 'committed' ? 'committed' : 'proposed';
      });
      const done = result.projects.filter((p) => p.status !== 'skipped');
      return {
        text: `Kept ${args.keep.slice(0, 10)}…; ${result.merged.length} cop${result.merged.length === 1 ? 'y' : 'ies'} merged. ${done.map((p) => `${p.projectName}: ${p.replaced} use(s) ${p.status}`).join('; ') || 'No project used the copies.'}`,
        data: result,
      };
    },
  }),
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
