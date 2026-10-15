import { z } from 'zod';
import express from 'express';
import { compareVersions, type Commit, type ProjectSession, type ProjectState, type SceneNode, type VersionComparison } from '@omnix/core';
import { createRaster, diffOverlay, pixelDiff, type PixelDiff, type Raster } from '@omnix/imaging';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { defineTool, ToolError, zProjectId, type ToolDef } from '../mcp/registry.js';
import { registerToolProvider } from '../mcp/tools/index.js';
import { renderNodeCanvas } from '../render/renderNode.js';
import { canvasToRaster, rasterPng } from '../render/pixels.js';

/**
 * Version snapshots and comparing versions (feature 52). A version is any point in history:
 * a named snapshot, a commit, the original state ("base") or the current state. Two versions
 * compare as pictures (side by side, swipe, overlay, or a difference image with the changed
 * area highlighted) and, for documents and code, as text.
 */

export interface ResolvedVersion {
  /** Commit id, or null for the original state. */
  commitId: string | null;
  label: string;
  at: string | null;
}

/** Turn "current", "base", a snapshot id or a commit id into a point in history. */
export function resolveVersion(session: ProjectSession, ref: string | null | undefined): ResolvedVersion {
  const r = (ref ?? 'current').trim();
  if (r === 'current' || r === 'head' || r === '') {
    const c = session.head ? session.getCommit(session.head) : undefined;
    return { commitId: session.head, label: 'Current version', at: c?.timestamp ?? null };
  }
  if (r === 'base') return { commitId: null, label: 'Original', at: null };
  const snap = session.listSnapshots().find((s) => s.id === r);
  if (snap) return { commitId: snap.commitId, label: snap.name, at: snap.createdAt };
  const c: Commit | undefined = session.getCommit(r);
  if (!c) throw new ProjectError(`No version "${r}". Use "current", "base", a saved version id or a commit id.`, 404);
  return { commitId: c.id, label: c.label, at: c.timestamp };
}

/** The document (canvas, sequence, deck) a visual node belongs to, and its pixel size. */
function frameOf(state: ProjectState, nodeId: string): { width: number; height: number } | null {
  let cur: SceneNode | undefined = state.nodes[nodeId];
  while (cur) {
    if (cur.type === 'canvas' || cur.type === 'sequence' || cur.type === 'deck') {
      const p = cur.props as { width: number; height: number };
      return { width: p.width, height: p.height };
    }
    cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
  }
  return null;
}

export interface VisualComparison {
  before: Raster;
  after: Raster;
  diff: PixelDiff;
  scale: number;
}

/**
 * Render a visual node (canvas, layer, sequence frame, slide) in two versions at the same
 * scale, so the pictures line up, and compare them pixel by pixel. A node missing from one
 * version renders as an empty frame there.
 */
export async function compareVisual(services: Services, before: ProjectState, after: ProjectState, nodeId: string, options: { time?: number; maxSize?: number } = {}): Promise<VisualComparison> {
  const fa = frameOf(before, nodeId);
  const fb = frameOf(after, nodeId);
  if (!fa && !fb) throw new ProjectError('Pick a canvas, layer, video or animation, or slide to compare as pictures.', 400);
  const maxSize = Math.min(2048, Math.max(64, options.maxSize ?? 960));
  const longest = Math.max(fa?.width ?? 0, fa?.height ?? 0, fb?.width ?? 0, fb?.height ?? 0);
  const scale = Math.min(1, maxSize / longest);
  const render = async (state: ProjectState, frame: { width: number; height: number } | null, other: { width: number; height: number }): Promise<Raster> => {
    if (!frame || !state.nodes[nodeId]) return createRaster(Math.max(1, Math.round(other.width * scale)), Math.max(1, Math.round(other.height * scale)));
    return canvasToRaster(await renderNodeCanvas(services, state, { nodeId, scale, ...(options.time !== undefined ? { time: options.time } : {}) }));
  };
  const a = await render(before, fa, (fb ?? fa)!);
  const b = await render(after, fb, (fa ?? fb)!);
  return { before: a, after: b, diff: pixelDiff(a, b), scale };
}

/** Recent comparisons, so the before, after and difference images of one view render once. */
const cache = new Map<string, Promise<VisualComparison>>();
function cached(key: string, make: () => Promise<VisualComparison>): Promise<VisualComparison> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = make();
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > 24) cache.delete(cache.keys().next().value!);
  return p;
}

function trimForTool(c: VersionComparison): unknown {
  // Long diffs are summarized for Claude; the full text stays available through get_node.
  return {
    summary: c.summary,
    documents: c.documents
      .filter((d) => c.changed.includes(d.documentId))
      .map((d) => ({
        documentId: d.documentId,
        kind: d.kind,
        name: d.name,
        summary: d.summary,
        structural: { added: d.structural.added.slice(0, 40), removed: d.structural.removed.slice(0, 40), changed: d.structural.changed.slice(0, 40).map((x) => ({ id: x.id, type: x.type, name: x.name, props: x.props })) },
        ...(d.blocks ? { blocks: d.blocks.filter((b) => b.status !== 'same').slice(0, 60).map(({ words: _w, ...b }) => b) } : {}),
        ...(d.files ? { files: d.files.slice(0, 20).map((f) => ({ ...f, runs: f.runs.slice(0, 80) })) } : {}),
        ...(d.slides ? { slides: d.slides.filter((s) => s.status !== 'same') } : {}),
      })),
  };
}

export function versionTools(services: Services): ToolDef[] {
  return [
    defineTool({
      name: 'save_version',
      title: 'Save a version',
      description: 'Save the project as it is now as a named version (a snapshot people can return to and compare against). Good moments: before a big change, after finishing a stage, or when the user likes how something looks.',
      category: 'project',
      access: 'write',
      input: { projectId: zProjectId, name: z.string().min(1).max(120) },
      output: z.object({ versionId: z.string(), commitId: z.string().nullable() }),
      example: { input: { projectId: 'prj_8Kq2...', name: 'Before the color pass' }, output: { versionId: 'snap_1...', commitId: 'c_9...' } },
      async handler(args, ctx) {
        if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only. Ask the user to switch Claude to "edit with approval" or "autonomous" in Omnix.');
        await ctx.requireProject(args.projectId, 'write');
        const snap = await services.projects.snapshot(args.projectId, args.name, ctx.principal.author);
        return { text: `Saved version "${snap.name}" (${snap.id}).`, data: { versionId: snap.id, commitId: snap.commitId } };
      },
    }),
    defineTool({
      name: 'compare_versions',
      title: 'Compare two versions',
      description:
        'See what changed between two versions of a project: named versions (ids from get_history), commit ids, "base" (the original) or "current". Returns a summary per document, paragraph-level text changes for documents, line diffs for code, slide-by-slide changes for decks, and for a canvas, video or animation frame, or slide: before, after and difference pictures with the changed area highlighted and the share of pixels that changed.',
      category: 'project',
      access: 'read',
      input: {
        projectId: zProjectId,
        from: z.string().describe('Older version: version id, commit id or "base"'),
        to: z.string().default('current').describe('Newer version (default "current")'),
        documentId: z.string().optional().describe('Only this canvas, sequence, workspace, document or deck'),
        nodeId: z.string().optional().describe('Picture comparison of this canvas, layer, sequence, or slide (default: the document when it is visual)'),
        time: z.number().min(0).optional().describe('Seconds, for video and animation'),
        images: z.boolean().default(true),
      },
      output: z.object({
        from: z.object({ commitId: z.string().nullable(), label: z.string(), at: z.string().nullable() }),
        to: z.object({ commitId: z.string().nullable(), label: z.string(), at: z.string().nullable() }),
        comparison: z.record(z.string(), z.unknown()),
        pixels: z.object({ nodeId: z.string(), changedPercent: z.number(), bbox: z.unknown(), width: z.number(), height: z.number() }).optional(),
      }),
      example: {
        input: { projectId: 'prj_8Kq2...', from: 'snap_1...', documentId: 'cnv_1' },
        output: {
          from: { commitId: 'c_41...', label: 'Claude: Poster', at: '2026-10-14T09:12:00.000Z' },
          to: { commitId: 'c_57...', label: 'Current version', at: '2026-10-14T09:30:00.000Z' },
          comparison: { summary: 'Poster: 1 added, 2 changed' },
          pixels: { nodeId: 'cnv_1', changedPercent: 12.4, bbox: { x: 95, y: 472, width: 579, height: 136 }, width: 768, height: 768 },
        },
      },
      async handler(args, ctx) {
        await ctx.requireProject(args.projectId, 'read');
        const session = await services.projects.session(args.projectId);
        const from = resolveVersion(session, args.from);
        const to = resolveVersion(session, args.to);
        const before = session.stateAt(from.commitId);
        const after = session.stateAt(to.commitId);
        const comparison = compareVersions(before, after, args.documentId);
        let pixels: { nodeId: string; changedPercent: number; bbox: PixelDiff['bbox']; width: number; height: number } | undefined;
        const images: { data: Buffer; mimeType: string }[] = [];
        const visualId = args.nodeId ?? (args.documentId && ['canvas', 'sequence'].includes((after.nodes[args.documentId] ?? before.nodes[args.documentId])?.type ?? '') ? args.documentId : undefined) ?? (args.documentId ? firstChangedSlide(comparison, args.documentId) : undefined);
        if (visualId) {
          const v = await compareVisual(services, before, after, visualId, { maxSize: 768, ...(args.time !== undefined ? { time: args.time } : {}) });
          pixels = { nodeId: visualId, changedPercent: Math.round(v.diff.fraction * 1000) / 10, bbox: v.diff.bbox, width: v.diff.width, height: v.diff.height };
          if (args.images) {
            images.push({ data: await rasterPng(v.before), mimeType: 'image/png' }, { data: await rasterPng(v.after), mimeType: 'image/png' }, { data: await rasterPng(diffOverlay(v.after, v.diff)), mimeType: 'image/png' });
          }
        }
        const text = [
          `Comparing "${from.label}" → "${to.label}".`,
          comparison.summary,
          ...(pixels ? [`${pixels.changedPercent}% of the picture changed${pixels.bbox ? ` (area x ${pixels.bbox.x}, y ${pixels.bbox.y}, ${pixels.bbox.width}×${pixels.bbox.height} at preview scale)` : ''}.${images.length ? ' Images: before, after, difference (changes in magenta).' : ''}`] : []),
        ].join('\n');
        return { text, data: { from, to, comparison: trimForTool(comparison), ...(pixels ? { pixels } : {}) }, ...(images.length ? { images } : {}) };
      },
    }),
  ];
}

function firstChangedSlide(c: VersionComparison, deckId: string): string | undefined {
  const d = c.documents.find((x) => x.documentId === deckId);
  return d?.slides?.find((s) => s.status !== 'same' && s.status !== 'removed')?.slideId ?? d?.slides?.find((s) => s.status === 'removed')?.slideId;
}

useModule(({ services, router }) => {
  registerToolProvider(services, () => versionTools(services));
  const r = express.Router();
  const zRef = z.string().max(80).optional();

  const open = async (req: express.Request) => {
    const user = requireUser(req);
    const id = String(req.params.id);
    await services.projects.requireAccess(id, user.id, 'read');
    const session = await services.projects.session(id);
    return { id, session };
  };

  // Text and structure: what changed in each document between two versions.
  r.get(
    '/projects/:id/compare',
    h(async (req, res) => {
      const { session } = await open(req);
      const q = z.object({ from: zRef, to: zRef, doc: z.string().optional() }).parse(req.query);
      const from = resolveVersion(session, q.from ?? 'base');
      const to = resolveVersion(session, q.to ?? 'current');
      res.json({ from, to, comparison: compareVersions(session.stateAt(from.commitId), session.stateAt(to.commitId), q.doc) });
    }),
  );

  // Pictures of a visual node in both versions at one scale, and their difference.
  const zVisual = z.object({ from: zRef, to: zRef, node: z.string(), t: z.coerce.number().min(0).optional(), size: z.coerce.number().int().min(64).max(2048).optional() });
  const visual = async (req: express.Request) => {
    const { id, session } = await open(req);
    const q = zVisual.parse(req.query);
    const from = resolveVersion(session, q.from ?? 'base');
    const to = resolveVersion(session, q.to ?? 'current');
    const key = `${id}|${from.commitId}|${to.commitId}|${q.node}|${q.t ?? ''}|${q.size ?? ''}`;
    return cached(key, () => compareVisual(services, session.stateAt(from.commitId), session.stateAt(to.commitId), q.node, { ...(q.t !== undefined ? { time: q.t } : {}), ...(q.size ? { maxSize: q.size } : {}) }));
  };
  r.get(
    '/projects/:id/compare/pixels',
    h(async (req, res) => {
      const v = await visual(req);
      res.json({ changed: v.diff.changed, total: v.diff.total, fraction: v.diff.fraction, bbox: v.diff.bbox, width: v.diff.width, height: v.diff.height, scale: v.scale });
    }),
  );
  r.get(
    '/projects/:id/compare/image',
    h(async (req, res) => {
      const which = z.enum(['before', 'after', 'diff']).parse(req.query.which ?? 'diff');
      const v = await visual(req);
      const img = which === 'before' ? v.before : which === 'after' ? v.after : diffOverlay(v.after, v.diff);
      res.set('Content-Type', 'image/png').set('Cache-Control', 'private, max-age=300').send(await rasterPng(img));
    }),
  );

  router.use(r);
});
